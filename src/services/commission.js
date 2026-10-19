const { Trade, User, RebateCommission, RevenueCommission } = require('../models');
const { uplineChain } = require('./network');
const ledger = require('./ledger');
const settings = require('./settings');
const realtime = require('./realtime');
const { rebateRate, revenueRate, calcRebate, calcRevenue, levelUnlocked } = require('../logic/commission');
const { MAX_NETWORK_LEVELS } = require('../constants');

const isDup = (e) => e && e.code === 11000;

/**
 * Generates Rebate (§8.7) and Revenue-Link (§7) commissions for a CLOSED trade, exactly once.
 * - The trade is claimed atomically (commissionsProcessedAt) so concurrent/duplicate MT5 pushes can't double pay.
 * - Unique (tradeId, level) indexes make a re-run after a crash safe: existing rows are skipped.
 * - A Banned upline's commission is recorded as "On Hold" and not paid.
 */
async function processClosedTrade(tradeId, { force = false } = {}) {
  const filter = { _id: tradeId, status: 'Closed' };
  if (!force) filter.commissionsProcessedAt = null;
  const trade = await Trade.findOneAndUpdate(filter, { $set: { commissionsProcessedAt: new Date() } }, { new: true });
  if (!trade) return { skipped: true };

  const trader = await User.findById(trade.userId).select('+ancestors');
  const out = { rebates: 0, revenues: 0 };
  if (!trader || trader.registrationType === 'Direct') return out;
  const chain = await uplineChain(trader, MAX_NETWORK_LEVELS);

  if (trader.registrationType === 'Rebate Link' && trade.volume > 0) {
    const defaults = await settings.get('ib.rebate');
    for (const [i, up] of chain.entries()) {
      const rate = rebateRate(up, i, defaults);
      const amount = calcRebate(rate, trade.volume);
      if (amount <= 0) continue;
      const hold = up.accountStatus === 'Banned';
      let doc;
      try {
        doc = await RebateCommission.create({ tradeId: trade.id, level: i + 1, ibUserId: up.id, traderId: trader.id, volume: trade.volume, rate, amount, status: hold ? 'On Hold' : 'Distributed' });
      } catch (e) { if (isDup(e)) continue; throw e; }
      if (!hold) await ledger.post({ userId: up.id, amount, type: 'rebate', refId: doc.id, note: `Level ${i + 1} rebate, trade ${trade.id}` });
      out.rebates++;
      realtime.emit('rebate:created', doc.toJSON());
    }
  }

  if (trader.registrationType === 'Revenue Link' && trade.profit !== 0) {
    const defaults = await settings.get('ib.revenue');
    for (const [i, up] of chain.entries()) {
      if (!levelUnlocked(up.ibRank, i + 1)) continue; // §7.2 rank unlocks levels
      const rate = revenueRate(up, i, defaults);
      const { amount, accountPlus, accountMinus } = calcRevenue(trade.profit, rate);
      if (amount <= 0) continue;
      const hold = up.accountStatus === 'Banned';
      let doc;
      try {
        doc = await RevenueCommission.create({ tradeId: trade.id, level: i + 1, uplineId: up.id, traderId: trader.id, uplineRank: up.ibRank, rate, pl: trade.profit, amount, accountPlus, accountMinus, status: hold ? 'On Hold' : 'Settled' });
      } catch (e) { if (isDup(e)) continue; throw e; }
      if (!hold) {
        if (accountPlus) await ledger.post({ userId: up.id, amount: accountPlus, type: 'revenue_plus', refId: doc.id, note: `Level ${i + 1} share of user ${trader.id} loss` });
        if (accountMinus) {
          await ledger.post({ userId: up.id, amount: -accountMinus, type: 'revenue_minus', refId: doc.id, allowNegative: true, note: `Level ${i + 1} share of user ${trader.id} profit` });
          await ledger.post({ userId: trader.id, amount: accountMinus, type: 'revenue_minus', refId: doc.id, note: `Revenue-link profit share from upline ${up.id}` });
        }
      }
      out.revenues++;
      realtime.emit('revenue:created', doc.toJSON());
    }
  }
  return out;
}
module.exports = { processClosedTrade };
