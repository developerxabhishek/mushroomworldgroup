// Shared setup for tests that go through the API: a throwaway MongoDB replica set
// in memory (transactions need a replica set) and small request helpers.
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const request = require('supertest');
const { connectDb } = require('../src/db');
const { PRODUCTS } = require('../src/config');

async function startTestDb() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await connectDb(replSet.getUri('test'));
  return async function stopTestDb() {
    await mongoose.disconnect();
    await replSet.stop();
  };
}

// Native driver delete, so it also clears the append-only ledger between tests.
async function clearDb() {
  for (const collection of await mongoose.connection.db.collections()) {
    await collection.deleteMany({});
  }
}

// Creates a batch through POST /batches that expires exactly at `expiresAt`.
async function addBatch(app, { product = 'oyster', grade = 'A', grams, expiresAt }) {
  const harvestedAt = new Date(expiresAt.getTime() - PRODUCTS[product].shelfLifeMs).toISOString();
  const res = await request(app).post('/batches').send({ product, grade, grams, harvestedAt });
  if (res.status !== 201) throw new Error(`could not create batch: ${JSON.stringify(res.body)}`);
  return res.body;
}

let keyCounter = 0;
function placeOrder(app, body, distributorId = 'distributor-1') {
  return request(app)
    .post('/orders')
    .set('X-Distributor-Id', distributorId)
    .set('Idempotency-Key', `test-key-${++keyCounter}`)
    .send(body);
}

module.exports = { startTestDb, clearDb, addBatch, placeOrder };
