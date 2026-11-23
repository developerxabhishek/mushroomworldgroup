const { HOUR_MS, TIER_DISCOUNT_PCT, MAX_DISCOUNT_PCT } = require('../config');

const roundHalfUp = (num, den) => (2n * num + den) / (2n * den); // BigInt, positive values
const ceilDiv = (num, den) => (num + den - 1n) / den;

/**
 * Price one order line. Returns the amount in integer paise.
 * base → grade B ×0.85 → tier discount → ×0.80 if < 24h left → never below 75% of base.
 */
function priceLine({ grams, basePricePerKgPaise, grade, tier, expiresAt, now }) {
  const gradeKeptPct = grade === 'B' ? 85 : 100;
  const tierKeptPct = 100 - TIER_DISCOUNT_PCT[tier];
  const nearExpiry = expiresAt.getTime() - now.getTime() < 24 * HOUR_MS;
  const expiryKeptPct = nearExpiry ? 80 : 100;

  // Three "percent kept" numbers multiplied → parts-per-million of the base price kept.
  const keptPpm = gradeKeptPct * tierKeptPct * expiryKeptPct; // 1_000_000 = full price
  const floorPpm = (100 - MAX_DISCOUNT_PCT) * 10_000; // 750_000 = 75% of base

  // base (in paise) = grams/1000 * pricePerKg. Keep everything as one exact fraction
  // and divide only once at the end → no floating point anywhere.
  const baseTimes1000 = BigInt(grams) * BigInt(basePricePerKgPaise);
  const PPM_DEN = 1000n * 1_000_000n;

  const discounted = roundHalfUp(baseTimes1000 * BigInt(keptPpm), PPM_DEN);
  const floor = ceilDiv(baseTimes1000 * BigInt(floorPpm), PPM_DEN); // ceil → discount never > 25%

  return Number(discounted < floor ? floor : discounted); // amount in paise
}

module.exports = { priceLine };
