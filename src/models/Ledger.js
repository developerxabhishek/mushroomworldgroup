const mongoose = require('mongoose');

const { Schema } = mongoose;

// One row per stock movement. Rows are only ever inserted, never changed.
const ledgerSchema = new Schema({
  batchId: { type: Schema.Types.ObjectId, ref: 'Batch', required: true },
  orderId: { type: Schema.Types.ObjectId, ref: 'Order' },
  type: { type: String, enum: ['ADDED', 'RESERVED', 'RELEASED', 'CONFIRMED'], required: true },
  grams: { type: Number, required: true }, // how much moved
  delta: { type: Number, required: true }, // effect on batch.remainingGrams
  at: { type: Date, default: Date.now },
});
ledgerSchema.index({ batchId: 1 });

// Append-only: block every update/delete path that goes through Mongoose.
const LEDGER_WRITE_OPS = [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace',
  'deleteOne', 'deleteMany', 'findOneAndDelete',
];
ledgerSchema.pre(LEDGER_WRITE_OPS, function blockLedgerChange() {
  throw new Error('Ledger is append-only: updates and deletes are not allowed');
});
ledgerSchema.pre('save', function blockLedgerResave() {
  if (!this.isNew) throw new Error('Ledger is append-only: updates are not allowed');
});

module.exports = mongoose.model('Ledger', ledgerSchema);
