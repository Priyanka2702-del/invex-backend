const cron = require('node-cron');
const equity = require('../services/equity');
const { recomputeAll } = require('../services/rank');
const { ym } = require('../utils/dateRange');

const safe = (name, fn) => async () => { try { console.log(`[cron] ${name}`, JSON.stringify(await fn())); } catch (e) { console.error(`[cron] ${name} failed`, e); } };
/** All jobs are idempotent, so running two instances (or a manual re-run) cannot double-count or double-pay. */
function start() {
  cron.schedule('5 0 * * *', safe('equity-snapshot', () => equity.runDailySnapshot()), { timezone: 'UTC' });
  cron.schedule('30 0 1 * *', safe('equity-finalize', () => { const d = new Date(); return equity.finalizeMonth(ym(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)))); }), { timezone: 'UTC' });
  cron.schedule('0 3 * * *', safe('rank-recompute', () => recomputeAll()), { timezone: 'UTC' });
}
module.exports = { start };
