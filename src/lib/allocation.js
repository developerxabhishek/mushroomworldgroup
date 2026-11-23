/**
 * First-expiry-first-out plan. `batches` must already be sorted by expiresAt ASC.
 * Returns which batch gives how many grams, and how much is still missing.
 * Pure function: it only plans, it does not touch the database.
 */
function planAllocation(batches, requestedGrams) {
  const picks = [];
  let needed = requestedGrams;
  for (const batch of batches) {
    if (needed === 0) break;
    const take = Math.min(batch.remainingGrams, needed);
    if (take > 0) {
      picks.push({ batch, grams: take });
      needed -= take;
    }
  }
  return { picks, allocatedGrams: requestedGrams - needed, shortfallGrams: needed };
}

module.exports = { planAllocation };
