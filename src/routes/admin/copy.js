const router = require('express').Router();
const { z } = require('zod');
const { CopyTransaction, User } = require('../../models');
const asyncHandler = require('../../utils/asyncHandler');
const { page } = require('../../utils/pagination');
const { paged, rangeFilter, datesByUser } = require('../../utils/serialize');
const settings = require('../../services/settings');
const audit = require('../../services/audit');

// per-user totals: invested, withdrawn, net (grouped by user+type, folded in JS: portable across MongoDB versions)
async function perUser(match = {}) {
  const rows = await CopyTransaction.aggregate([
    { $match: match },
    { $group: { _id: { userId: '$userId', type: '$type' }, amount: { $sum: '$amount' } } },
  ]);
  const m = new Map();
  for (const r of rows) {
    const u = m.get(r._id.userId) || { _id: r._id.userId, invested: 0, withdrawn: 0 };
    if (r._id.type === 'invest') u.invested += r.amount; else if (r._id.type === 'withdraw') u.withdrawn += r.amount;
    m.set(u._id, u);
  }
  return [...m.values()].map((u) => ({ ...u, net: u.invested - u.withdrawn }));
}

// §4.1 overview
router.get('/overview', asyncHandler(async (_req, res) => {
  const since = new Date(Date.now() - 24 * 3600e3);
  const [rows, last24] = await Promise.all([perUser(), CopyTransaction.aggregate([{ $match: { type: 'invest', createdAt: { $gte: since } } }, { $group: { _id: null, t: { $sum: '$amount' } } }])]);
  res.json({
    totalInvestment: rows.reduce((s, r) => s + r.net, 0),
    totalUsersInvesting: rows.filter((r) => r.invested > 0).length,
    investmentLast24h: last24[0]?.t || 0,
    activeCopiers: rows.filter((r) => r.net > 0).length,
  });
}));
// §4.2 per-user investment list
router.get('/investors', asyncHandler(async (req, res) => {
  const p = page(req.query), rows = (await perUser(rangeFilter(req.query))).sort((a, b) => b.net - a.net);
  const slice = rows.slice(p.skip, p.skip + p.limit);
  const ids = slice.map((r) => r._id);
  const [users, dates] = await Promise.all([User.find({ _id: { $in: ids } }).select('name email').lean(), datesByUser(CopyTransaction, ids)]);
  const names = new Map(users.map((u) => [u._id, u]));
  res.json(paged(slice.map((r) => ({ userId: r._id, name: names.get(r._id)?.name, email: names.get(r._id)?.email, investedAmount: r.invested, withdrawn: r.withdrawn, netInvestment: r.net, firstInvestedAt: dates.get(r._id)?.firstAt, lastActivityAt: dates.get(r._id)?.lastAt, active: r.net > 0 })), rows.length, p));
}));
// complete history for one user (investments + other copy activity)
router.get('/users/:id/history', asyncHandler(async (req, res) => {
  const p = page(req.query), q = { userId: req.params.id, ...rangeFilter(req.query) };
  const [rows, total] = await Promise.all([CopyTransaction.find(q).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit), CopyTransaction.countDocuments(q)]);
  res.json(paged(rows, total, p));
}));
// §4.3 profit cut % + timeline conditions
router.get('/settings', asyncHandler(async (_req, res) => res.json(await settings.get('copy'))));
router.put('/settings', asyncHandler(async (req, res) => {
  const b = z.object({
    profitCutPct: z.number().min(0).max(100).optional(),
    timeline: z.array(z.object({ label: z.string().min(1).max(80), days: z.number().int().min(0).max(3650), description: z.string().max(300).default('') })).max(50).optional(),
  }).parse(req.body);
  const cur = await settings.get('copy');
  audit(req.admin, 'Copy trading settings changed', 'Copy Trading', JSON.stringify(b));
  res.json(await settings.set('copy', { ...cur, ...b }, req.admin.name));
}));
module.exports = router;
