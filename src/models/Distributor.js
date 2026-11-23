const mongoose = require('mongoose');
const { TIER_DISCOUNT_PCT } = require('../config');

const distributorSchema = new mongoose.Schema({
  _id: { type: String }, // the X-Distributor-Id value
  tier: { type: String, enum: Object.keys(TIER_DISCOUNT_PCT), required: true },
});

module.exports = mongoose.model('Distributor', distributorSchema);
