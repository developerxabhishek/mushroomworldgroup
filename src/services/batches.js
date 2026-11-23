const { PRODUCTS } = require('../config');
const { Batch, Ledger } = require('../models');
const { inTransaction } = require('../db');

function toBatchResponse(batch) {
  return {
    batchId: String(batch._id),
    product: batch.product,
    grade: batch.grade,
    grams: batch.initialGrams,
    remainingGrams: batch.remainingGrams,
    harvestedAt: batch.harvestedAt.toISOString(),
    expiresAt: batch.expiresAt.toISOString(),
  };
}

// Add stock: batch + ADDED ledger row, together or not at all.
async function createBatch({ product, grade, grams, harvestedAt }) {
  const expiresAt = new Date(harvestedAt.getTime() + PRODUCTS[product].shelfLifeMs);
  return inTransaction(async (session) => {
    const [batch] = await Batch.create(
      [{ product, grade, initialGrams: grams, remainingGrams: grams, harvestedAt, expiresAt }],
      { session },
    );
    await Ledger.create([{ batchId: batch._id, type: 'ADDED', grams, delta: grams }], { session });
    return batch;
  });
}

module.exports = { createBatch, toBatchResponse };
