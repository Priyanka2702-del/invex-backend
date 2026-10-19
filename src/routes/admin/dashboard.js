const router = require('express').Router();
const { User, Transaction, Trade, RebateCommission, RevenueCommission } = require('../../models');
const asyncHandler = require('../../utils/asyncHandler');

const sum = (Model, match, field = 'amount') =>
  Model.aggregate([{ $match: match }, { $group: { _id: null, t: { $sum: `$${field}` }, n: { $sum: 1 } } }]).then(([r]) => ({ total: r?.t || 0, count: r?.n || 0 }));

router.get('/', asyncHandler(async (_req, res) => {
  const since = new Date(Date.now() - 24 * 3600e3);
  const [users, banned, kycPending, dep, wd, pendDep, pendWd, tr24, reb24, rev24, wallets] = await Promise.all([
    User.countDocuments(), User.countDocuments({ accountStatus: 'Banned' }), User.countDocuments({ kycStatus: 'Pending' }),
    sum(Transaction, { kind: 'deposit', status: 'Successful' }), sum(Transaction, { kind: 'withdrawal', status: 'Successful' }),
    sum(Transaction, { kind: 'deposit', status: 'Pending' }), sum(Transaction, { kind: 'withdrawal', status: 'Pending' }),
    sum(Trade, { openTime: { $gte: since } }, 'volume'),
    sum(RebateCommission, { createdAt: { $gte: since } }), sum(RevenueCommission, { createdAt: { $gte: since } }),
    User.aggregate([{ $group: { _id: null, wallet: { $sum: '$walletBalance' }, equity: { $sum: '$mt5Equity' } } }]).then(([r]) => r || { wallet: 0, equity: 0 }),
  ]);
  res.json({
    users: { total: users, banned, kycPending },
    deposits: { total: dep.total, count: dep.count, pending: pendDep },
    withdrawals: { total: wd.total, count: wd.count, pending: pendWd },
    netDeposits: dep.total - wd.total,
    last24h: { trades: tr24.count, volume: tr24.total, rebateCommission: reb24.total, revenueCommission: rev24.total },
    balances: { wallet: wallets.wallet, mt5Equity: wallets.equity },
  });
}));
module.exports = router;
