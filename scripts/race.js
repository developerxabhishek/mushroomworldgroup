/**
 * Race test: 10 kg of stock, 50 parallel orders of 1 kg each.
 * Total allocated must never be more than 10 kg.
 *
 *   npm run race
 *
 * Every run starts its own empty MongoDB replica set in memory, so the result
 * does not depend on stock left over from earlier runs.
 * The orders go over real HTTP to the real Express app, all fired at once.
 */

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createApp } = require('../src/app');
const { connectDb } = require('../src/db');
const { todayIST } = require('../src/lib/time');
const { Batch } = require('../src/models');

const STOCK_GRAMS = 10_000;
const ORDERS = 50;
const ORDER_GRAMS = 1_000;

async function startDatabase() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  return {
    uri: replSet.getUri('race'),
    stop: async () => {
      await mongoose.disconnect();
      await replSet.stop();
    },
  };
}

async function main() {
  const db = await startDatabase();
  await connectDb(db.uri);

  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const post = (path, body, headers = {}) =>
    fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json() }));

  // 1. Create 10 kg of stock.
  const harvestedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const batch = await post('/batches', { product: 'oyster', grade: 'A', grams: STOCK_GRAMS, harvestedAt });
  if (batch.status !== 201) throw new Error(`could not create batch: ${JSON.stringify(batch.body)}`);

  // 2. Fire 50 orders of 1 kg at the same time, each from a different distributor.
  const order = { product: 'oyster', grade: 'A', grams: ORDER_GRAMS, deliveryDate: todayIST(new Date()), allowPartial: false };
  const results = await Promise.all(
    Array.from({ length: ORDERS }, (_, i) =>
      post('/orders', order, { 'X-Distributor-Id': `race-distributor-${i}`, 'Idempotency-Key': `race-${i}` }),
    ),
  );

  // 3. Add up what was actually allocated.
  const byStatus = {};
  let allocatedGrams = 0;
  for (const r of results) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (r.status === 201) allocatedGrams += r.body.lines.reduce((sum, l) => sum + l.grams, 0);
  }
  const left = await Batch.findById(batch.body.batchId).lean();
  const reconcile = await fetch(`${baseUrl}/reconcile`).then((r) => r.json());

  console.log(`Stock created     : ${STOCK_GRAMS} g`);
  console.log(`Orders fired      : ${ORDERS} x ${ORDER_GRAMS} g (in parallel)`);
  console.log(`Responses         : ${JSON.stringify(byStatus)}`);
  console.log(`Total allocated   : ${allocatedGrams} g`);
  console.log(`Left in batch     : ${left.remainingGrams} g`);
  console.log(`Ledger reconciles : ${reconcile.ok}`);

  const ok = allocatedGrams <= STOCK_GRAMS && left.remainingGrams >= 0 && allocatedGrams + left.remainingGrams === STOCK_GRAMS && reconcile.ok;
  console.log(ok ? 'PASS: never allocated more than 10 kg' : 'FAIL: stock was oversold');

  server.close();
  await db.stop();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
