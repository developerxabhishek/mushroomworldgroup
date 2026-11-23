const mongoose = require('mongoose');

// The response we sent for (distributor, Idempotency-Key), so a retry gets the same answer.
const idempotencySchema = new mongoose.Schema({
  distributorId: { type: String, required: true },
  key: { type: String, required: true },
  requestHash: { type: String, required: true },
  statusCode: { type: Number, required: true },
  body: { type: mongoose.Schema.Types.Mixed, required: true },
});

// One key per distributor. The unique index is what makes duplicates impossible.
idempotencySchema.index({ distributorId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('IdempotencyRecord', idempotencySchema);
