const router = require('express').Router();
const { z } = require('zod');
const { User, SystemRank, Transaction, Trade, RebateCommission, RevenueCommission, EquityMonth, CopyTransaction, PamTransaction } = require('../../models');
const { userAuth } = require('../../middleware/auth');
const asyncHandler = require('../../utils/asyncHandler');
const HttpError = require('../../utils/httpError');
const { page } = require('../../utils/pagination');
const { paged } = require('../../utils/serialize');
const tx = require('../../services/transactions');
const ledger = require('../../services/ledger');
const settings = require('../../services/settings');
const { levelQuery, level2Equity } = require('../../services/network');
const { activeRanks } = require('../../services/rank');
const { nextRankProgress } = require('../../logic/rank');
const { equityTierFor } = require('../../logic/equity');
const { IB_LEVELS, MAX_NETWORK_LEVELS } = require('../../constants');
const { ym } = require('../../utils/dateRange');
const env = require('../../config/env');

router.use(userAuth);
const link = (c) => `${env.USER_APP_URL.replace(/\/$/, '')}/register?ref=${c}`;
const amountBody = z.object({ amount: z.number().positive().max(10_000_000) });

router.get('/', asyncHandler(async (req, res) => {
  const u = req.user, rank = u.systemRankId ? await SystemRank.findById(u.systemRankId).lean() : null;
  res.json({ ...u.toJSON(), systemRank: rank?.name || null, impersonated: !!req.impersonatedBy });
}));
router.patch('/', asyncHandler(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(100), phone: z.string().max(30), country: z.string().max(60) }).partial().parse(req.body);
  res.json(await User.findByIdAndUpdate(req.user.id, b, { new: true }));
}));

/* §8.11: Revenue Link is shown only when approved; otherwise only the Rebate Link */
router.get('/affiliate', (req, res) => {
  const u = req.user, approved = u.revenueLink === 'Approved' && u.revenueCode;
  res.json({
    rebateLink: link(u.referralCode), revenueLink: approved ? link(u.revenueCode) : null, revenueLinkStatus: u.revenueLink,
    isIb: u.isIb, ibRank: u.ibRank, revenueLevelsUnlocked: IB_LEVELS[u.ibRank] || 0,
  });
});
router.get('/team', asyncHandler(async (req, res) => {
  const levels = [];
  for (let l = 1; l <= MAX_NETWORK_LEVELS; l++) levels.push({ level: l, members: await User.countDocuments(levelQuery(req.user.id, l)) });
  const p = page(req.query), q = { uplineId: req.user.id };
  const [direct, total] = await Promise.all([User.find(q).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).select('name createdAt registrationType teamDeposit'), User.countDocuments(q)]);
  res.json({ levels, teamDeposit: req.user.teamDeposit, directs: paged(direct.map((d) => ({ id: d.id, name: d.name, joined: d.createdAt, type: d.registrationType })), total, p) });
}));
router.get('/system-rank', asyncHandler(async (req, res) => {
  const ranks = await activeRanks(), cur = ranks.find((r) => r._id === req.user.systemRankId);
  res.json({ rank: cur?.name || null, source: req.user.systemRankSource, totalTeamDeposit: req.user.teamDeposit, progress: nextRankProgress(req.user.teamDeposit, cur?.name || null, ranks.map((r) => ({ name: r.name, minTeamDeposit: r.minTeamDeposit }))) });
}));
router.get('/equity-bonus', asyncHandler(async (req, res) => {
  const [l2, current, history] = await Promise.all([level2Equity(req.user.id), EquityMonth.findOne({ ibUserId: req.user.id, month: ym() }), EquityMonth.find({ ibUserId: req.user.id }).sort({ month: -1 }).limit(12)]);
  const tier = equityTierFor(l2);
  res.json({ level2TeamEquity: l2, currentTierPct: tier?.pct || 0, thisMonth: current, history });
}));
router.get('/earnings', asyncHandler(async (req, res) => {
  const p = page(req.query);
  const [rebates, revenue] = await Promise.all([RebateCommission.find({ ibUserId: req.user.id }).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit), RevenueCommission.find({ uplineId: req.user.id }).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit)]);
  res.json({ rebates, revenue });
}));

/* money */
const mine = (kind) => asyncHandler(async (req, res) => {
  const p = page(req.query), q = { userId: req.user.id, kind };
  const [rows, total] = await Promise.all([Transaction.find(q).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit), Transaction.countDocuments(q)]);
  res.json(paged(rows, total, p));
});
router.get('/deposits', mine('deposit'));
router.get('/withdrawals', mine('withdrawal'));
router.post('/deposits', asyncHandler(async (req, res) => {
  const b = amountBody.extend({ method: z.string().max(60).default(''), txId: z.string().max(120).default(''), note: z.string().max(300).optional() }).parse(req.body);
  res.status(201).json(await tx.createDeposit(req.user.id, b));
}));
router.post('/withdrawals', asyncHandler(async (req, res) => {
  const b = amountBody.extend({ method: z.string().max(60).default(''), destination: z.string().min(3).max(200), note: z.string().max(300).optional() }).parse(req.body);
  res.status(201).json(await tx.createWithdrawal(req.user.id, b));
}));
router.get('/trades', asyncHandler(async (req, res) => {
  const p = page(req.query), q = { userId: req.user.id };
  const [rows, total] = await Promise.all([Trade.find(q).sort({ openTime: -1 }).skip(p.skip).limit(p.limit), Trade.countDocuments(q)]);
  res.json(paged(rows, total, p));
}));

/* copy trading / PAM: invest from the wallet. Profit-cut %, PAM % and timeline conditions are admin-configured. */
const net = (rows) => rows.reduce((s, r) => s + (r.type === 'invest' ? r.amount : r.type === 'withdraw' ? -r.amount : 0), 0);
router.get('/copy', asyncHandler(async (req, res) => {
  const history = await CopyTransaction.find({ userId: req.user.id }).sort({ createdAt: -1 });
  const s = await settings.get('copy');
  res.json({ netInvestment: net(history), profitCutPct: s.profitCutPct, timeline: s.timeline, history });
}));
router.post('/copy/invest', asyncHandler(async (req, res) => {
  const { amount } = amountBody.parse(req.body);
  const t = await CopyTransaction.create({ userId: req.user.id, type: 'invest', amount });
  try { await ledger.post({ userId: req.user.id, amount: -amount, type: 'copy_invest', refId: t.id }); } catch (e) { await t.deleteOne(); throw e; }
  res.status(201).json(t);
}));
router.get('/pam', asyncHandler(async (req, res) => {
  const history = await PamTransaction.find({ userId: req.user.id }).sort({ createdAt: -1 });
  const s = await settings.get('pam');
  res.json({ totalDeposit: history.filter((h) => h.type === 'deposit').reduce((a, h) => a + h.amount, 0), monthlyReturnPct: s.monthlyReturnPct, profitSharePct: s.profitSharePct, history });
}));
router.post('/pam/deposit', asyncHandler(async (req, res) => {
  const { amount } = amountBody.parse(req.body);
  const t = await PamTransaction.create({ userId: req.user.id, type: 'deposit', amount });
  try { await ledger.post({ userId: req.user.id, amount: -amount, type: 'pam_deposit', refId: t.id }); } catch (e) { await t.deleteOne(); throw e; }
  res.status(201).json(t);
}));
router.use(require('./trading')); // /orders, /positions
module.exports = router;
