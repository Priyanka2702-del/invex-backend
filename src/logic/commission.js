const { IB_LEVELS, REBATE_DEFAULT, REVENUE_DEFAULT } = require('../constants');
const { round2 } = require('../utils/money');

const rebateRate = (upline, i, defaults = REBATE_DEFAULT) => upline?.customIb?.rebate?.[i] ?? defaults[i];
const revenueRate = (upline, i, defaults = REVENUE_DEFAULT) => upline?.customIb?.revenue?.[i] ?? defaults[i];
/** Rebate: $ per lot x volume. */
const calcRebate = (ratePerLot, volume) => round2(ratePerLot * volume);
/** §7.2: a level is paid only if the upline's IB rank unlocks it. */
const levelUnlocked = (ibRank, level) => (IB_LEVELS[ibRank] || 0) >= level;

/**
 * §7.3 Revenue Link. Loss -> upline "Account Plus" (+rate% of loss).
 * Profit -> rate% of profit moves from the upline ("Account Minus") to the user.
 */
function calcRevenue(profit, ratePct) {
  const amount = round2((Math.abs(profit) * ratePct) / 100);
  return { amount, accountPlus: profit < 0 ? amount : 0, accountMinus: profit > 0 ? amount : 0 };
}
module.exports = { rebateRate, revenueRate, calcRebate, levelUnlocked, calcRevenue };
