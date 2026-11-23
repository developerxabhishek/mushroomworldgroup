/**
 * Entry point: connect to MongoDB, start the reservation sweeper, start the HTTP server.
 *
 * MongoDB MUST run as a replica set (even a single node), because
 * multi-document transactions are only available on replica sets.
 */

const mongoose = require('mongoose');
const { PORT } = require('./config');
const { connectDb } = require('./db');
const { createApp } = require('./app');
const { startSweeper } = require('./sweeper');

async function main() {
  await connectDb();
  const stopSweeper = startSweeper();
  const server = createApp().listen(PORT, () => console.log(`API listening on :${PORT}`));

  const shutdown = async () => {
    stopSweeper();
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
