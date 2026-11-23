const { PRODUCTS, GRADES } = require('../config');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HAS_TIMEZONE_RE = /(Z|[+-]\d{2}:\d{2})$/;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPositiveGrams = (n) => Number.isSafeInteger(n) && n > 0;
const isValidHeader = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
const isObjectId = (v) => typeof v === 'string' && OBJECT_ID_RE.test(v);

function isRealCalendarDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // rejects 2026-02-30
}

function validateBatchInput(body) {
  if (!isPlainObject(body)) return { error: 'body must be a JSON object' };
  const { product, grade, grams, harvestedAt } = body;
  if (!Object.hasOwn(PRODUCTS, product)) return { error: `product must be one of ${Object.keys(PRODUCTS).join(', ')}` };
  if (!GRADES.includes(grade)) return { error: 'grade must be A or B' };
  if (!isPositiveGrams(grams)) return { error: 'grams must be a positive integer' };
  if (typeof harvestedAt !== 'string' || !HAS_TIMEZONE_RE.test(harvestedAt)) {
    return { error: 'harvestedAt must be an ISO timestamp with a timezone' };
  }
  const harvested = new Date(harvestedAt);
  if (Number.isNaN(harvested.getTime())) return { error: 'harvestedAt is not a valid date' };
  return { value: { product, grade, grams, harvestedAt: harvested } };
}

function validateOrderInput(body) {
  if (!isPlainObject(body)) return { error: 'body must be a JSON object' };
  const { product, grade, grams, deliveryDate, allowPartial = false, allowSubstitute = false } = body;
  if (!Object.hasOwn(PRODUCTS, product)) return { error: `product must be one of ${Object.keys(PRODUCTS).join(', ')}` };
  if (!GRADES.includes(grade)) return { error: 'grade must be A or B' };
  if (!isPositiveGrams(grams)) return { error: 'grams must be a positive integer' };
  if (!isRealCalendarDate(deliveryDate)) return { error: 'deliveryDate must be a real date in YYYY-MM-DD format' };
  if (typeof allowPartial !== 'boolean') return { error: 'allowPartial must be a boolean' };
  if (typeof allowSubstitute !== 'boolean') return { error: 'allowSubstitute must be a boolean' };
  // Fixed key order → the same logical request always hashes the same (idempotency).
  return { value: { product, grade, grams, deliveryDate, allowPartial, allowSubstitute } };
}

module.exports = { validateBatchInput, validateOrderInput, isValidHeader, isObjectId };
