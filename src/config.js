// Runtime settings – can be overridden with environment variables.
const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:27018/perishable?directConnection=true';
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS) || 10_000;

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000; // in MILLISECONDS (Part A bug #6)
// How long an order stays RESERVED, by distributor tier. Part C: Platinum gets 30 minutes.
const RESERVATION_MS_BY_TIER = { SILVER: 15 * MINUTE_MS, GOLD: 15 * MINUTE_MS, PLATINUM: 30 * MINUTE_MS };
const IST_OFFSET_MS = 5.5 * HOUR_MS; // IST = UTC+05:30, India has no DST

// Base prices are NOT given in the brief → assumed values, in paise per kg.
const PRODUCTS = {
  oyster: { shelfLifeMs: 72 * HOUR_MS, basePricePerKgPaise: 30_000 }, // ₹300/kg
  button: { shelfLifeMs: 120 * HOUR_MS, basePricePerKgPaise: 20_000 }, // ₹200/kg
  dried: { shelfLifeMs: 180 * 24 * HOUR_MS, basePricePerKgPaise: 120_000 }, // ₹1200/kg
};
const GRADES = ['A', 'B'];
const TIER_DISCOUNT_PCT = { SILVER: 0, GOLD: 5, PLATINUM: 8 };
const DEFAULT_TIER = 'SILVER'; // unknown distributor → no discount (never give away money)
const MAX_DISCOUNT_PCT = 25;

module.exports = {
  PORT,
  MONGODB_URI,
  SWEEP_INTERVAL_MS,
  HOUR_MS,
  RESERVATION_MS_BY_TIER,
  IST_OFFSET_MS,
  PRODUCTS,
  GRADES,
  TIER_DISCOUNT_PCT,
  DEFAULT_TIER,
  MAX_DISCOUNT_PCT,
};
