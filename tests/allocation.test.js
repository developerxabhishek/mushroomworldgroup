const { planAllocation } = require('../src/lib/allocation');
const { createApp } = require('../src/app');
const { todayIST } = require('../src/lib/time');
const { Batch, Order, Ledger } = require('../src/models');
const { startTestDb, clearDb, addBatch, placeOrder } = require('./helpers');

const HOUR = 60 * 60 * 1000;

describe('planAllocation', () => {
  const batch = (id, remainingGrams) => ({ id, remainingGrams });
  const picked = (plan) => plan.picks.map((p) => [p.batch.id, p.grams]);

  test('takes the whole order from the first batch when it has enough', () => {
    const plan = planAllocation([batch('b1', 10000), batch('b2', 10000)], 4000);
    expect(picked(plan)).toEqual([['b1', 4000]]);
    expect(plan.shortfallGrams).toBe(0);
  });

  test('splits the order across batches, in the order given', () => {
    const plan = planAllocation([batch('b1', 5000), batch('b2', 50000)], 12500);
    expect(picked(plan)).toEqual([['b1', 5000], ['b2', 7500]]);
    expect(plan.allocatedGrams).toBe(12500);
    expect(plan.shortfallGrams).toBe(0);
  });

  test('reports the shortfall when there is not enough stock', () => {
    const plan = planAllocation([batch('b1', 3000), batch('b2', 2000)], 10000);
    expect(picked(plan)).toEqual([['b1', 3000], ['b2', 2000]]);
    expect(plan.allocatedGrams).toBe(5000);
    expect(plan.shortfallGrams).toBe(5000);
  });

  test('allocates nothing when there are no batches', () => {
    const plan = planAllocation([], 1000);
    expect(plan.picks).toEqual([]);
    expect(plan.shortfallGrams).toBe(1000);
  });
});

describe('POST /orders allocation', () => {
  let app;
  let stopTestDb;
  const deliveryDate = todayIST(new Date());
  const expiresIn = (hours) => new Date(Date.now() + hours * HOUR);
  const remainingGrams = async (batchId) => (await Batch.findById(batchId).lean()).remainingGrams;

  beforeAll(async () => {
    stopTestDb = await startTestDb();
    app = createApp();
  }, 60000);
  afterAll(() => stopTestDb());
  beforeEach(() => clearDb());

  test('allocates from the batch that expires first and splits the order across batches', async () => {
    const later = await addBatch(app, { grams: 50000, expiresAt: expiresIn(70) });
    const sooner = await addBatch(app, { grams: 5000, expiresAt: expiresIn(50) });

    const res = await placeOrder(app, { product: 'oyster', grade: 'A', grams: 12500, deliveryDate, allowPartial: false });

    expect(res.status).toBe(201);
    expect(res.body.lines.map((l) => [l.batchId, l.grams])).toEqual([
      [sooner.batchId, 5000],
      [later.batchId, 7500],
    ]);
    expect(res.body.shortfallGrams).toBe(0);
    expect(await remainingGrams(sooner.batchId)).toBe(0);
    expect(await remainingGrams(later.batchId)).toBe(42500);
  });

  test('never mixes grade A and grade B', async () => {
    const gradeB = await addBatch(app, { grade: 'B', grams: 20000, expiresAt: expiresIn(50) });
    const gradeA = await addBatch(app, { grade: 'A', grams: 6000, expiresAt: expiresIn(60) });

    const rejected = await placeOrder(app, { product: 'oyster', grade: 'A', grams: 10000, deliveryDate, allowPartial: false });
    expect(rejected.status).toBe(409);

    const partial = await placeOrder(app, { product: 'oyster', grade: 'A', grams: 10000, deliveryDate, allowPartial: true });
    expect(partial.status).toBe(201);
    expect(partial.body.lines.map((l) => l.batchId)).toEqual([gradeA.batchId]);
    expect(await remainingGrams(gradeB.batchId)).toBe(20000);
  });

  test('allowPartial: false and not enough stock → 409 and nothing is allocated', async () => {
    const b = await addBatch(app, { grams: 6000, expiresAt: expiresIn(60) });

    const res = await placeOrder(app, { product: 'oyster', grade: 'A', grams: 10000, deliveryDate, allowPartial: false });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'INSUFFICIENT_STOCK' });
    expect(await remainingGrams(b.batchId)).toBe(6000);
    expect(await Order.countDocuments()).toBe(0);
    expect(await Ledger.countDocuments({ type: 'RESERVED' })).toBe(0);
  });

  test('allowPartial: true and not enough stock → allocates what is available', async () => {
    const b = await addBatch(app, { grams: 6000, expiresAt: expiresIn(60) });

    const res = await placeOrder(app, { product: 'oyster', grade: 'A', grams: 10000, deliveryDate, allowPartial: true });

    expect(res.status).toBe(201);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].grams).toBe(6000);
    expect(res.body.shortfallGrams).toBe(4000);
    expect(await remainingGrams(b.batchId)).toBe(0);
  });

  test('no stock at all → 409, even with allowPartial: true', async () => {
    const res = await placeOrder(app, { product: 'oyster', grade: 'A', grams: 1000, deliveryDate, allowPartial: true });

    expect(res.status).toBe(409);
    expect(await Order.countDocuments()).toBe(0);
  });
});
