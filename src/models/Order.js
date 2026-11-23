const mongoose = require('mongoose');
const { TIER_DISCOUNT_PCT } = require('../config');

const { Schema } = mongoose;

const orderLineSchema = new Schema(
  {
    batchId: { type: Schema.Types.ObjectId, ref: 'Batch', required: true },
    grams: { type: Number, required: true },
    amountPaise: { type: Number, required: true },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    distributorId: { type: String, required: true },
    tier: { type: String, enum: Object.keys(TIER_DISCOUNT_PCT), required: true },
    product: { type: String, required: true },
    grade: { type: String, required: true },
    deliveryDate: { type: String, required: true }, // 'YYYY-MM-DD', IST calendar date
    requestedGrams: { type: Number, required: true },
    allowPartial: { type: Boolean, required: true },
    lines: [orderLineSchema],
    totalPaise: { type: Number, required: true },
    shortfallGrams: { type: Number, required: true },
    status: { type: String, enum: ['RESERVED', 'CONFIRMED', 'EXPIRED'], required: true },
    reservedUntil: { type: Date, required: true },
    confirmedAt: Date,
    releasedAt: Date,
  },
  { timestamps: true },
);

// The sweeper's query: "RESERVED orders whose reservedUntil has passed".
orderSchema.index({ status: 1, reservedUntil: 1 });

module.exports = mongoose.model('Order', orderSchema);
