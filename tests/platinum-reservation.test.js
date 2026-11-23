// Part C: Platinum distributors get a 30-minute reservation instead of 15.
const { createApp } = require('../src/app');
const { todayIST } = require('../src/lib/time');
const { confirmOrder, releaseExpiredReservations } = require('../src/services/orders');
const { Batch, Distributor } = require('../src/models');
const { startTestDb, clearDb, addBatch, placeOrder } = require('./helpers');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe('reservation length by tier', () => {
  let app;
  let stopTestDb;
  const deliveryDate = todayIST(new Date());
  const order = { product: 'oyster', grade: 'A', grams: 1000, deliveryDate };
  const minutesFromNow = (n) => new Date(Date.now() + n * MINUTE);
  const reservedMinutes = (res, placedAt) => Math.round((new Date(res.body.reservedUntil) - placedAt) / MINUTE);

  beforeAll(async () => {
    stopTestDb = await startTestDb();
    app = createApp();
  }, 60000);
  afterAll(() => stopTestDb());
  beforeEach(async () => {
    await clearDb();
    await Distributor.create([
      { _id: 'platinum-distributor', tier: 'PLATINUM' },
      { _id: 'gold-distributor', tier: 'GOLD' },
      { _id: 'silver-distributor', tier: 'SILVER' },
    ]);
    await addBatch(app, { grams: 10000, expiresAt: new Date(Date.now() + 50 * HOUR) });
  });

  test('Platinum → reserved for 30 minutes', async () => {
    const placedAt = Date.now();
    const res = await placeOrder(app, order, 'platinum-distributor');

    expect(res.status).toBe(201);
    expect(reservedMinutes(res, placedAt)).toBe(30);
  });

  test.each(['silver-distributor', 'gold-distributor', 'unknown-distributor'])('%s → still 15 minutes', async (distributorId) => {
    const placedAt = Date.now();
    const res = await placeOrder(app, order, distributorId);

    expect(reservedMinutes(res, placedAt)).toBe(15);
  });

  test('Platinum order is still reserved at minute 20 and can be confirmed', async () => {
    const res = await placeOrder(app, order, 'platinum-distributor');

    expect(await releaseExpiredReservations(minutesFromNow(20))).toBe(0);
    const confirmed = await confirmOrder({ orderId: res.body.orderId, now: minutesFromNow(20) });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('CONFIRMED');
  });

  test('at minute 16 a Silver order is released but a Platinum order is not', async () => {
    await placeOrder(app, { ...order, grams: 1000 }, 'silver-distributor');
    await placeOrder(app, { ...order, grams: 2000 }, 'platinum-distributor');

    expect(await releaseExpiredReservations(minutesFromNow(16))).toBe(1);
    expect((await Batch.findOne().lean()).remainingGrams).toBe(8000); // only the Silver 1 kg came back
  });

  test('Platinum order after 30 minutes → confirm gives 410 and the stock comes back', async () => {
    const res = await placeOrder(app, { ...order, grams: 3000 }, 'platinum-distributor');

    const late = await confirmOrder({ orderId: res.body.orderId, now: minutesFromNow(31) });

    expect(late.status).toBe(410);
    expect(late.body).toEqual({ error: 'RESERVATION_EXPIRED' });
    expect((await Batch.findOne().lean()).remainingGrams).toBe(10000);
  });
});
