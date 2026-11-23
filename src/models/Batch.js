const mongoose = require('mongoose');
const { PRODUCTS, GRADES } = require('../config');

const batchSchema = new mongoose.Schema(
  {
    product: { type: String, enum: Object.keys(PRODUCTS), required: true },
    grade: { type: String, enum: GRADES, required: true },
    initialGrams: { type: Number, required: true },
    remainingGrams: { type: Number, required: true, min: 0 },
    harvestedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// Exactly the shape of the allocation query: filter product+grade, sort by expiry.
batchSchema.index({ product: 1, grade: 1, expiresAt: 1 });

module.exports = mongoose.model('Batch', batchSchema);
