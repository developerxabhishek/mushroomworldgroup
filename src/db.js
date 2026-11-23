const mongoose = require('mongoose');
const { MONGODB_URI } = require('./config');
const models = require('./models');

async function connectDb(uri = MONGODB_URI) {
  await mongoose.connect(uri);
  // Create collections and indexes up front – they can't be created inside a transaction.
  await Promise.all(Object.values(models).map((m) => m.init()));
}

/** Thrown when the data changed under us; the whole transaction is retried. */
class RetryableError extends Error {}

/**
 * Run fn(session) inside a MongoDB transaction. The driver retries write conflicts.
 * MongoDB must run as a replica set (even a single node) for transactions to work.
 */
async function inTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(
      async () => {
        result = await fn(session);
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
    return result;
  } finally {
    await session.endSession();
  }
}

/** Retry the whole transaction for our own "data changed" errors and duplicate-key races. */
async function withRetry(fn, maxAttempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof RetryableError || err?.code === 11000;
      if (!retryable || attempt >= maxAttempts) throw err;
    }
  }
}

module.exports = { connectDb, inTransaction, withRetry, RetryableError };
