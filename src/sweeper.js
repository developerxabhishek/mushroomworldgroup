const { SWEEP_INTERVAL_MS } = require('./config');
const { releaseExpiredReservations } = require('./services/orders');

/**
 * Releases expired reservations now (catch-up after a restart) and then every interval.
 * Expiry is stored in the database (reservedUntil), so nothing is lost if the server restarts.
 */
function startSweeper(intervalMs = SWEEP_INTERVAL_MS) {
  let running = false;
  const tick = async () => {
    if (running) return; // never overlap two sweeps from the same process
    running = true;
    try {
      const n = await releaseExpiredReservations();
      if (n > 0) console.log(`[sweeper] released ${n} expired reservation(s)`);
    } catch (err) {
      console.error('[sweeper] failed:', err.message);
    } finally {
      running = false;
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { startSweeper };
