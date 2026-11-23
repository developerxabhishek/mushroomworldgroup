// Part C: allowSubstitute – fill a Grade A shortfall from Grade B, at Grade B price.
const { createApp } = require('../src/app');
const { todayIST } = require('../src/lib/time');
const { Batch, Order, Ledger } = require('../src/models');
const { startTestDb, clearDb, addBatch, placeOrder } = require('./helpers');

const HOUR = 60 * 60 * 1000;

describe('POST /orders with allowSubstitute', () => {
  let app;
  let stopTestDb;
  const deliveryDate = todayIST(new Date());
  const expiresIn = (hours) => new Date(Date.now() + hours * HOUR);
  const remainingGrams = async (batchId) => (await Batch.findById(batchId).lean()).remainingGrams;
  const order = (extra) => ({ product: 'oyster', grade: 'A', grams: 10000, deliveryDate, ...extra });

  beforeAll(async () => {
    stopTestDb = await startTestDb();
    app = createApp();
  }, 60000);
  afterAll(() => stopTestDb());
  beforeEach(() => clearDb());

  test('Grade A short → the rest comes from Grade B, at Grade B price, and is marked as substituted', async () => {
    const gradeA = await addBatch(app, { grade: 'A', grams: 6000, expiresAt: expiresIn(50) });
    const gradeB = await addBatch(app, { grade: 'B', grams: 20000, expiresAt: expiresIn(50) });

    const res = await placeOrder(app, order({ allowSubstitute: true }));

    expect(res.status).toBe(201);
    expect(res.body.lines).toEqual([
      { batchId: gradeA.batchId, grams: 6000, amountPaise: 180000 }, // 6 kg × ₹300
      { batchId: gradeB.batchId, grams: 4000, amountPaise: 102000, grade: 'B', substituted: true }, // 4 kg × ₹300 × 0.85
    ]);
    expect(res.body.totalPaise).toBe(282000);
    expect(res.body.shortfallGrams).toBe(0);
    expect(await remainingGrams(gradeA.batchId)).toBe(0);
    expect(await remainingGrams(gradeB.batchId)).toBe(16000);
  });

  test('uses all Grade A first, then Grade B first-expiry-first', async () => {
    const gradeA = await addBatch(app, { grade: 'A', grams: 1000, expiresAt: expiresIn(70) });
    const bLater = await addBatch(app, { grade: 'B', grams: 5000, expiresAt: expiresIn(60) });
    const bSooner = await addBatch(app, { grade: 'B', grams: 2000, expiresAt: expiresIn(30) }); // expires before the A batch

    const res = await placeOrder(app, order({ grams: 5000, allowSubstitute: true }));

    expect(res.body.lines.map((l) => [l.batchId, l.grams, l.substituted ?? false])).toEqual([
      [gradeA.batchId, 1000, false],
      [bSooner.batchId, 2000, true],
      [bLater.batchId, 2000, true],
    ]);
  });

  test('Grade A + Grade B still short and allowPartial: false → 409 and nothing is allocated', async () => {
    const gradeA = await addBatch(app, { grade: 'A', grams: 6000, expiresAt: expiresIn(50) });
    const gradeB = await addBatch(app, { grade: 'B', grams: 2000, expiresAt: expiresIn(50) });

    const res = await placeOrder(app, order({ allowSubstitute: true, allowPartial: false }));

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'INSUFFICIENT_STOCK' });
    expect(await remainingGrams(gradeA.batchId)).toBe(6000);
    expect(await remainingGrams(gradeB.batchId)).toBe(2000);
    expect(await Order.countDocuments()).toBe(0);
    expect(await Ledger.countDocuments({ type: 'RESERVED' })).toBe(0);
  });

  test('Grade A + Grade B still short and allowPartial: true → takes both and reports the shortfall', async () => {
    await addBatch(app, { grade: 'A', grams: 6000, expiresAt: expiresIn(50) });
    await addBatch(app, { grade: 'B', grams: 2000, expiresAt: expiresIn(50) });

    const res = await placeOrder(app, order({ allowSubstitute: true, allowPartial: true }));

    expect(res.status).toBe(201);
    expect(res.body.lines.map((l) => l.grams)).toEqual([6000, 2000]);
    expect(res.body.shortfallGrams).toBe(2000);
  });

  test('without allowSubstitute, grades are still never mixed', async () => {
    await addBatch(app, { grade: 'A', grams: 6000, expiresAt: expiresIn(50) });
    await addBatch(app, { grade: 'B', grams: 20000, expiresAt: expiresIn(50) });

    expect((await placeOrder(app, order())).status).toBe(409);
    expect((await placeOrder(app, order({ allowSubstitute: false }))).status).toBe(409);
  });

  test('enough Grade A → no substitution, lines keep the normal shape', async () => {
    await addBatch(app, { grade: 'A', grams: 20000, expiresAt: expiresIn(50) });
    await addBatch(app, { grade: 'B', grams: 20000, expiresAt: expiresIn(50) });

    const res = await placeOrder(app, order({ allowSubstitute: true }));

    expect(res.body.lines).toHaveLength(1);
    expect(Object.keys(res.body.lines[0]).sort()).toEqual(['amountPaise', 'batchId', 'grams']);
  });

  test('a Grade B order is never filled from Grade A', async () => {
    await addBatch(app, { grade: 'A', grams: 20000, expiresAt: expiresIn(50) });
    await addBatch(app, { grade: 'B', grams: 1000, expiresAt: expiresIn(50) });

    const res = await placeOrder(app, order({ grade: 'B', allowSubstitute: true }));

    expect(res.status).toBe(409);
  });

  test('allowSubstitute must be a boolean', async () => {
    const res = await placeOrder(app, order({ allowSubstitute: 'yes' }));

    expect(res.status).toBe(400);
  });
});
