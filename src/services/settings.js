const { Setting } = require('../models');
const C = require('../constants');

const DEFAULTS = {
  'ib.rebate': C.REBATE_DEFAULT,          // $ per lot, Level 1..5 (§8.7)
  'ib.revenue': C.REVENUE_DEFAULT,        // % of loss/profit, Level 1..5 (§7.1)
  copy: { profitCutPct: 20, timeline: [] },          // §4.3
  pam: { profitSharePct: 20, monthlyReturnPct: 5 },  // §5.3
  // stock trading: kill switch, shares per "lot" (rebates are $ per lot), per-order cap, cash buffer held on market buys
  trading: { enabled: true, lotSize: 100, maxOrderValue: 100000, buyReserveBufferPct: 5 },
};
async function get(key) {
  const s = await Setting.findById(key).lean();
  const d = DEFAULTS[key];
  return s ? (Array.isArray(d) ? s.value : { ...d, ...s.value }) : d;
}
async function set(key, value, by) {
  await Setting.findByIdAndUpdate(key, { value, updatedBy: by }, { upsert: true, new: true });
  return get(key);
}
module.exports = { get, set, DEFAULTS };
