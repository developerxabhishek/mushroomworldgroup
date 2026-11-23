const { Batch, Ledger } = require('../models');
const { inTransaction } = require('../db');

// Rebuild stock from the ledger and compare with the batches.
async function reconcile() {
  // Inside a snapshot transaction so the ledger and the batches are read at the same instant.
  return inTransaction(async (session) => {
    const ledgerTotals = await Ledger.aggregate([{ $group: { _id: '$batchId', grams: { $sum: '$delta' } } }]).session(session);
    const fromLedger = new Map(ledgerTotals.map((r) => [String(r._id), r.grams]));
    const batches = await Batch.find({}, { remainingGrams: 1 }).session(session).lean();

    const mismatches = [];
    for (const b of batches) {
      const id = String(b._id);
      const ledgerGrams = fromLedger.get(id) ?? 0;
      if (ledgerGrams !== b.remainingGrams) {
        mismatches.push({ batchId: id, ledgerGrams, batchGrams: b.remainingGrams, diffGrams: b.remainingGrams - ledgerGrams });
      }
      fromLedger.delete(id);
    }
    for (const [id, ledgerGrams] of fromLedger) {
      mismatches.push({ batchId: id, ledgerGrams, batchGrams: null, diffGrams: null }); // ledger rows, batch missing
    }
    return { ok: mismatches.length === 0, batchesChecked: batches.length, mismatches };
  });
}

module.exports = { reconcile };
