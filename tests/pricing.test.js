const { priceLine } = require('../src/lib/pricing');
const { createApp } = require('../src/app');
const { todayIST, endOfDeliveryDayIST } = require('../src/lib/time');
const { Distributor } = require('../src/models');
const { startTestDb, clearDb, addBatch, placeOrder } = require('./helpers');

const HOUR = 60 * 60 * 1000;
const OYSTER_PAISE_PER_KG = 30000; // ₹300/kg, from src/config.js

describe('priceLine', () => {
  const now = new Date('2026-11-22T10:00:00+05:30');
  const FRESH = new Date(now.getTime() + 48 * HOUR);
  const NEAR_EXPIRY = new Date(now.getTime() + 10 * HOUR);

  const price = (overrides) =>
    priceLine({
      grams: 1000,
      basePricePerKgPaise: OYSTER_PAISE_PER_KG,
      grade: 'A',
      tier: 'SILVER',
      expiresAt: FRESH,
      now,
      ...overrides,
    });

  test('base price = grams / 1000 × price per kg, in paise', () => {
    expect(price()).toBe(30000);
    expect(price({ grams: 2500 })).toBe(75000);
  });

  test('Grade B is 15% cheaper', () => {
    expect(price({ grade: 'B' })).toBe(25500);
  });

  test.each([
    ['SILVER', 30000], // 0%
    ['GOLD', 28500], // 5%
    ['PLATINUM', 27600], // 8%
  ])('tier discount: %s → %i paise', (tier, expected) => {
    expect(price({ tier })).toBe(expected);
  });

  test('discounts apply one after another: Grade B then Gold = 0.85 × 0.95', () => {
    expect(price({ grade: 'B', tier: 'GOLD' })).toBe(24225); // 19.25% off, not 20%
  });

  test('extra 20% off when the batch has less than 24 hours left at the time of order', () => {
    expect(price({ expiresAt: NEAR_EXPIRY })).toBe(24000);
  });

  test('24 hour boundary: exactly 24h left → no discount, 1 ms less → discount', () => {
    expect(price({ expiresAt: new Date(now.getTime() + 24 * HOUR) })).toBe(30000);
    expect(price({ expiresAt: new Date(now.getTime() + 24 * HOUR - 1) })).toBe(24000);
  });

  describe('total discount is never more than 25% of base price', () => {
    test.each([
      ['A + Platinum + near expiry (26.4% off)', 'A', 'PLATINUM'],
      ['B + Silver + near expiry (32% off)', 'B', 'SILVER'],
      ['B + Platinum + near expiry (37.44% off)', 'B', 'PLATINUM'],
    ])('%s is capped at 75% of base', (_, grade, tier) => {
      expect(price({ grade, tier, expiresAt: NEAR_EXPIRY })).toBe(22500);
    });

    test('a discount under 25% is left as it is', () => {
      expect(price({ grade: 'B', tier: 'GOLD' })).toBe(24225);
    });

    test('rounding never takes the discount over 25%', () => {
      // 1 g of oyster: base 30 paise, 75% of it is 22.5 → must round UP to 23
      expect(price({ grams: 1, grade: 'B', expiresAt: NEAR_EXPIRY })).toBe(23);
    });
  });

  test('always returns whole paise', () => {
    for (const grams of [1, 7, 333, 999, 12345]) {
      for (const grade of ['A', 'B']) {
        for (const tier of ['SILVER', 'GOLD', 'PLATINUM']) {
          for (const expiresAt of [FRESH, NEAR_EXPIRY]) {
            expect(Number.isInteger(price({ grams, grade, tier, expiresAt }))).toBe(true);
          }
        }
      }
    }
  });
});

describe('POST /orders pricing', () => {
  let app;
  let stopTestDb;

  beforeAll(async () => {
    stopTestDb = await startTestDb();
    app = createApp();
  }, 60000);
  afterAll(() => stopTestDb());
  beforeEach(() => clearDb());

  test('prices each line separately, uses the distributor tier, and total = sum of lines', async () => {
    await Distributor.create({ _id: 'gold-distributor', tier: 'GOLD' });
    const deliveryDate = todayIST(new Date());
    // valid at the end of today, but less than 24 hours left → near-expiry discount
    await addBatch(app, { grams: 333, expiresAt: new Date(endOfDeliveryDayIST(deliveryDate).getTime() + 60 * 1000) });
    await addBatch(app, { grams: 777, expiresAt: new Date(Date.now() + 60 * HOUR) });
    await addBatch(app, { grams: 5000, expiresAt: new Date(Date.now() + 65 * HOUR) });

    const res = await placeOrder(app, { product: 'oyster', grade: 'A', grams: 1500, deliveryDate }, 'gold-distributor');

    expect(res.status).toBe(201);
    expect(res.body.lines.map((l) => [l.grams, l.amountPaise])).toEqual([
      [333, 7592], // 9990 × 0.95 × 0.80 = 7592.4
      [777, 22145], // 23310 × 0.95 = 22144.5 → rounded half up
      [390, 11115], // 11700 × 0.95
    ]);
    expect(res.body.totalPaise).toBe(7592 + 22145 + 11115);
    expect(res.body.totalPaise).toBe(res.body.lines.reduce((sum, l) => sum + l.amountPaise, 0));
  });

  test('an unknown distributor pays Silver price (no tier discount)', async () => {
    await addBatch(app, { grams: 1000, expiresAt: new Date(Date.now() + 60 * HOUR) });

    const res = await placeOrder(app, { product: 'oyster', grade: 'A', grams: 1000, deliveryDate: todayIST(new Date()) }, 'never-seen-before');

    expect(res.status).toBe(201);
    expect(res.body.lines[0].amountPaise).toBe(30000);
  });
});
