const http = require('http');
const mongoose = require('mongoose');
const env = require('./config/env');
const app = require('./app');
const realtime = require('./services/realtime');
const { ensureIndexes } = require('./models');

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  await ensureIndexes();
  const server = http.createServer(app);
  realtime.attach(server);
  if (env.ENABLE_CRON === 'true') require('./jobs').start();
  if (env.ALPACA_SYNC_INTERVAL_MS > 0 && require('./services/alpaca').configured()) {
    const trading = require('./services/trading'); let busy = false;
    setInterval(async () => { if (busy) return; busy = true; try { await trading.sync(); } catch (e) { console.error('[trading] sync failed', e.message); } finally { busy = false; } }, env.ALPACA_SYNC_INTERVAL_MS).unref();
  }
  server.listen(env.PORT, () => console.log(`INVEX API listening on :${env.PORT} (${env.NODE_ENV})`));
  const stop = () => server.close(() => mongoose.disconnect().then(() => process.exit(0)));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
