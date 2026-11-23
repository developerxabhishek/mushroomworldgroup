const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { PRODUCTS, RESERVATION_MS, DEFAULT_TIER } = require('../config');
const { Batch, Order, Ledger, IdempotencyRecord, Distributor } = require('../models');
const { inTransaction, withRetry, RetryableError } = require('../db');
const { endOfDeliveryDayIST } = require('../lib/time');
const { priceLine } = require('../lib/pricing');
const { planAllocation } = require('../lib/allocation');
const { isObjectId } = require('../lib/validation');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const EXPIRED_RESPONSE = { status: 410, body: { error: 'RESERVATION_EXPIRED' } };
const NOT_FOUND_RESPONSE = { status: 404, body: { error: 'ORDER_NOT_FOUND' } };

function toOrderResponse(order) {
  return {
    orderId: String(order._id),
    status: order.status,
    reservedUntil: order.reservedUntil.toISOString(),
    lines: order.lines.map((l) => ({ batchId: String(l.batchId), grams: l.grams, amountPaise: l.amountPaise })),
    totalPaise: order.totalPaise,
    shortfallGrams: order.shortfallGrams,
  };
}

// Place an order: idempotency check + allocation + reservation in ONE transaction.
async function placeOrder({ distributorId, idempotencyKey, input, now = new Date() }) {
  const requestHash = sha256(JSON.stringify(input));

  return withRetry(() =>
    inTransaction(async (session) => {
      const previous = await IdempotencyRecord.findOne({ distributorId, key: idempotencyKey })
        .session(session)
        .lean();
      if (previous) {
        if (previous.requestHash !== requestHash) {
          return { status: 422, body: { error: 'IDEMPOTENCY_KEY_REUSED' } };
        }
        return { status: previous.statusCode, body: previous.body }; // replay original response
      }

      const response = await reserveStock({ distributorId, input, now, session });

      // Saved in the SAME transaction as the order: either both exist or neither does.
      await IdempotencyRecord.create(
        [{ distributorId, key: idempotencyKey, requestHash, statusCode: response.status, body: response.body }],
        { session },
      );
      return response;
    }),
  );
}

async function reserveStock({ distributorId, input, now, session }) {
  const { product, grade, grams, deliveryDate, allowPartial } = input;

  // 1) Candidate batches: same product, SAME grade (A and B never mix),
  //    still valid at 23:59:59 IST on the delivery day, first-expiring first.
  const candidates = await Batch.find({
    product,
    grade,
    remainingGrams: { $gt: 0 },
    expiresAt: { $gt: endOfDeliveryDayIST(deliveryDate) },
  })
    .sort({ expiresAt: 1, _id: 1 })
    .session(session);

  // 2) Plan in memory first. Decide BEFORE touching any stock.
  const plan = planAllocation(candidates, grams);
  if (plan.allocatedGrams === 0 || (plan.shortfallGrams > 0 && !allowPartial)) {
    return { status: 409, body: { error: 'INSUFFICIENT_STOCK' } };
  }

  const distributor = await Distributor.findById(distributorId).session(session).lean();
  const tier = distributor?.tier ?? DEFAULT_TIER;
  const orderId = new mongoose.Types.ObjectId();

  // 3) Apply: guarded atomic decrement per batch. The filter `remainingGrams >= take`
  //    means the update can never push stock below zero.
  const lines = [];
  for (const { batch, grams: take } of plan.picks) {
    const result = await Batch.updateOne(
      { _id: batch._id, remainingGrams: { $gte: take } },
      { $inc: { remainingGrams: -take } },
      { session },
    );
    if (result.modifiedCount !== 1) throw new RetryableError('batch changed during allocation');

    const amountPaise = priceLine({
      grams: take,
      basePricePerKgPaise: PRODUCTS[product].basePricePerKgPaise,
      grade,
      tier,
      expiresAt: batch.expiresAt,
      now,
    });
    lines.push({ batchId: batch._id, grams: take, amountPaise });
  }

  await Ledger.insertMany(
    lines.map((l) => ({ batchId: l.batchId, orderId, type: 'RESERVED', grams: l.grams, delta: -l.grams, at: now })),
    { session },
  );

  const [order] = await Order.create(
    [
      {
        _id: orderId,
        distributorId,
        tier,
        product,
        grade,
        deliveryDate,
        requestedGrams: grams,
        allowPartial,
        lines,
        totalPaise: lines.reduce((sum, l) => sum + l.amountPaise, 0), // integer sum → exact
        shortfallGrams: plan.shortfallGrams,
        status: 'RESERVED',
        reservedUntil: new Date(now.getTime() + RESERVATION_MS),
      },
    ],
    { session },
  );

  return { status: 201, body: toOrderResponse(order) };
}

// Release one reservation (used by the sweeper AND by a late confirm).
async function releaseOrder(orderId, session, now) {
  // Conditional state change: only ONE caller can move RESERVED → EXPIRED.
  const order = await Order.findOneAndUpdate(
    { _id: orderId, status: 'RESERVED', reservedUntil: { $lte: now } },
    { $set: { status: 'EXPIRED', releasedAt: now } },
    { new: true, session },
  );
  if (!order) return false; // already confirmed or already released by someone else

  for (const line of order.lines) {
    await Batch.updateOne({ _id: line.batchId }, { $inc: { remainingGrams: line.grams } }, { session });
  }
  await Ledger.insertMany(
    order.lines.map((l) => ({ batchId: l.batchId, orderId: order._id, type: 'RELEASED', grams: l.grams, delta: l.grams, at: now })),
    { session },
  );
  return true;
}

async function releaseExpiredReservations(now = new Date()) {
  const expired = await Order.find({ status: 'RESERVED', reservedUntil: { $lte: now } }, { _id: 1 })
    .sort({ reservedUntil: 1 })
    .limit(500)
    .lean();
  let released = 0;
  for (const { _id } of expired) {
    if (await inTransaction((session) => releaseOrder(_id, session, now))) released++;
  }
  return released;
}

async function confirmOrder({ orderId, now = new Date() }) {
  if (!isObjectId(orderId)) return NOT_FOUND_RESPONSE;

  return withRetry(() =>
    inTransaction(async (session) => {
      const order = await Order.findById(orderId).session(session);
      if (!order) return NOT_FOUND_RESPONSE;

      if (order.status === 'CONFIRMED') return { status: 200, body: toOrderResponse(order) }; // safe to repeat
      if (order.status === 'EXPIRED') return EXPIRED_RESPONSE;

      if (order.reservedUntil.getTime() <= now.getTime()) {
        // Expired, but the sweeper hasn't reached it yet → release it right now.
        await releaseOrder(order._id, session, now);
        return EXPIRED_RESPONSE;
      }

      const confirmed = await Order.findOneAndUpdate(
        { _id: order._id, status: 'RESERVED' },
        { $set: { status: 'CONFIRMED', confirmedAt: now } },
        { new: true, session },
      );
      if (!confirmed) throw new RetryableError('order changed during confirm');

      await Ledger.insertMany(
        confirmed.lines.map((l) => ({ batchId: l.batchId, orderId: confirmed._id, type: 'CONFIRMED', grams: l.grams, delta: 0, at: now })),
        { session },
      );
      return { status: 200, body: toOrderResponse(confirmed) };
    }),
  );
}

module.exports = { placeOrder, confirmOrder, releaseExpiredReservations };
