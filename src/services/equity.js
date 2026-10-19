const { User, EquityMonth } = require('../models');
const { level2EquityMap } = require('./network');
const ledger = require('./ledger');
const { equityTierFor, evaluateEquityMonth } = require('../logic/equity');
const { EQUITY_MAX_FAILURES } = require('../constants');
const { ym } = require('../utils/dateRange');

const dayKey = (d) => d.toISOString().slice(0, 10);

/**
 * Daily check (run by cron). For every IB: Level-2 team equity only (§3.2).
 * - first check of the month fixes the tier floor the IB must keep ("requiredEquity")
 * - every later day below that floor = one failure (1st/2nd = warnings, 3rd = no bonus, §3.5)
 * - the lowest equity seen is the "maintained" equity used at month end (§3.3: held the whole month)
 */
async function runDailySnapshot(date = new Date()) {
  const month = ym(date), day = dayKey(date);
  const map = await level2EquityMap();
  const ibs = await User.find({ isIb: true }).select('_id').lean();
  let checked = 0, failures = 0;
  for (const { _id: ibUserId } of ibs) {
    const equity = map.get(ibUserId) || 0;
    let row = await EquityMonth.findOne({ ibUserId, month });
    if (!row) {
      if (equity <= 0) continue; // nothing to track
      row = await EquityMonth.create({ ibUserId, month, requiredEquity: equityTierFor(equity)?.min || 0, minEquity: equity });
    } else if (row.finalized) continue;
    if (row.minEquity === null || equity < row.minEquity) row.minEquity = equity;
    if (row.requiredEquity > 0 && equity < row.requiredEquity && !row.failures.some((f) => f.day === day)) {
      row.failures.push({ day, equity, required: row.requiredEquity });
      row.failureCount = row.failures.length;
      failures++;
    }
    row.status = row.requiredEquity === 0 ? 'Not qualified' : row.failureCount >= EQUITY_MAX_FAILURES ? 'Forfeited' : row.failureCount ? 'Warning' : 'Qualified';
    await row.save();
    checked++;
  }
  return { month, day, checked, failures };
}

/** Month end: fix pct + bonus from the equity actually maintained. Bonus = maintained equity x pct (see README). */
async function finalizeMonth(month) {
  const rows = await EquityMonth.find({ month, finalized: false });
  for (const r of rows) {
    const maintained = r.minEquity ?? 0;
    const ev = evaluateEquityMonth({ maintained, failureCount: r.failureCount });
    Object.assign(r, { maintainedEquity: maintained, pct: ev.pct, bonus: ev.bonus, status: ev.status, finalized: true });
    await r.save();
  }
  return { month, finalized: rows.length };
}

/** Credit finalized, unpaid bonuses to the IB wallets. Idempotent (atomic claim per row). */
async function payMonth(month, adminName, { ibUserId } = {}) {
  const q = { month, finalized: true, paid: false, bonus: { $gt: 0 } };
  if (ibUserId) q.ibUserId = ibUserId;
  const rows = await EquityMonth.find(q).select('_id');
  let paid = 0, total = 0;
  for (const { id } of rows) {
    const r = await EquityMonth.findOneAndUpdate({ _id: id, paid: false }, { paid: true, paidAt: new Date() }, { new: true });
    if (!r) continue;
    await ledger.post({ userId: r.ibUserId, amount: r.bonus, type: 'equity_bonus', refId: r.id, note: `Equity bonus ${month} (${r.pct}%)`, createdBy: adminName });
    paid++; total += r.bonus;
  }
  return { month, paid, total };
}
module.exports = { runDailySnapshot, finalizeMonth, payMonth };
