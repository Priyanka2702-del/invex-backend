const { EQUITY_TIERS, EQUITY_MAX_FAILURES } = require('../constants');
const { round2 } = require('../utils/money');

const equityTierFor = (eq) => [...EQUITY_TIERS].reverse().find((t) => eq >= t.min) || null;

/**
 * §3.3–3.5. Bonus % depends ONLY on maintained Level-2 team equity (never the system rank).
 * failures 1 -> warning, 2 -> second warning, 3 -> bonus forfeited for the month.
 */
function evaluateEquityMonth({ maintained, failureCount }) {
  const tier = equityTierFor(maintained);
  if (!tier) return { status: 'Not qualified', pct: 0, bonus: 0, required: 0 };
  if (failureCount >= EQUITY_MAX_FAILURES) return { status: 'Forfeited', pct: tier.pct, bonus: 0, required: tier.min };
  return {
    status: failureCount > 0 ? 'Warning' : 'Qualified',
    pct: tier.pct,
    bonus: round2((maintained * tier.pct) / 100),
    required: tier.min,
  };
}
module.exports = { equityTierFor, evaluateEquityMonth };
