const { endOfDeliveryDayIST, todayIST } = require('../src/lib/time');
const { createApp } = require('../src/app');
const { startTestDb, clearDb, addBatch, placeOrder } = require('./helpers');

describe('endOfDeliveryDayIST', () => {
  test('is 23:59:59 IST on the delivery date (18:29:59 UTC)', () => {
    expect(endOfDeliveryDayIST('2026-11-22').toISOString()).toBe('2026-11-22T18:29:59.000Z');
  });

  test('works across month and year ends', () => {
    expect(endOfDeliveryDayIST('2026-11-30').toISOString()).toBe('2026-11-30T18:29:59.000Z');
    expect(endOfDeliveryDayIST('2026-12-31').toISOString()).toBe('2026-12-31T18:29:59.000Z');
  });

  test('is not the UTC-midnight value that new Date(deliveryDate) gives (the Part A bug)', () => {
    // new Date('2026-11-22') is 00:00 UTC = 05:30 IST, the START of the delivery day
    expect(new Date('2026-11-22').toISOString()).toBe('2026-11-22T00:00:00.000Z');
    expect(endOfDeliveryDayIST('2026-11-22').getTime()).toBeGreaterThan(new Date('2026-11-22').getTime());
  });
});

describe('POST /orders only uses batches still valid at the end of the delivery day (23:59:59 IST)', () => {
  let app;
  let stopTestDb;

  const addDays = (date, n) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const deliveryDate = addDays(todayIST(new Date()), 2);
  const nextDay = addDays(deliveryDate, 1);
  const ist = (dateTime) => new Date(`${dateTime}+05:30`);

  beforeAll(async () => {
    stopTestDb = await startTestDb();
    app = createApp();
  }, 60000);
  afterAll(() => stopTestDb());
  beforeEach(() => clearDb());

  test.each([
    ['05:31 IST on the delivery day', `${deliveryDate}T05:31:00`, 409],
    ['14:00 IST on the delivery day', `${deliveryDate}T14:00:00`, 409],
    ['exactly 23:59:59 IST on the delivery day', `${deliveryDate}T23:59:59`, 409],
    ['00:00:01 IST on the next day', `${nextDay}T00:00:01`, 201],
  ])('batch expiring at %s → %i', async (_, expiresAt, expectedStatus) => {
    await addBatch(app, { grams: 1000, expiresAt: ist(expiresAt) });

    const res = await placeOrder(app, { product: 'oyster', grade: 'A', grams: 1000, deliveryDate, allowPartial: false });

    expect(res.status).toBe(expectedStatus);
  });

  test('skips batches that expire during the delivery day, even if they expire first', async () => {
    await addBatch(app, { grams: 1000, expiresAt: ist(`${deliveryDate}T05:31:00`) });
    await addBatch(app, { grams: 1000, expiresAt: ist(`${deliveryDate}T14:00:00`) });
    await addBatch(app, { grams: 1000, expiresAt: ist(`${deliveryDate}T23:59:59`) });
    const valid = await addBatch(app, { grams: 1000, expiresAt: ist(`${nextDay}T00:00:01`) });

    const res = await placeOrder(app, { product: 'oyster', grade: 'A', grams: 4000, deliveryDate, allowPartial: true });

    expect(res.status).toBe(201);
    expect(res.body.lines.map((l) => [l.batchId, l.grams])).toEqual([[valid.batchId, 1000]]);
    expect(res.body.shortfallGrams).toBe(3000);
  });
});
