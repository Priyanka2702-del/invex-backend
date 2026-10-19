const router = require('express').Router();
const { z } = require('zod');
const { RevenueCommission, User } = require('../../models');
const asyncHandler = require('../../utils/asyncHandler');
const { parseRange } = require('../../utils/dateRange');
const { page } = require('../../utils/pagination');
const { paged, esc, rangeFilter } = require('../../utils/serialize');
const settings = require('../../services/settings');
const audit = require('../../services/audit');
const { IB_LEVELS } = require('../../constants');

// §7.3 totals: Account Plus (from user losses) vs Account Minus (paid out of uplines on user profits)
router.get('/summary', asyncHandler(async (req, res) => {
  const { from, to } = parseRange(req.query);
  const base = { createdAt: { $gte: from, $lte: to }, status: 'Settled' };
  const sum = (field) => RevenueCommission.aggregate([{ $match: { ...base, [field]: { $gt: 0 } } }, { $group: { _id: null, t: { $sum: `$${field}` }, n: { $sum: 1 } } }]).then(([r]) => r || { t: 0, n: 0 });
  const [plus, minus] = await Promise.all([sum('accountPlus'), sum('accountMinus')]);
  res.json({ accountPlus: plus.t, accountMinus: minus.t, net: plus.t - minus.t, count: plus.n + minus.n, from, to });
}));
router.get('/history', asyncHandler(async (req, res) => {
  const p = page(req.query), q = { ...rangeFilter(req.query) };
  if (req.query.level) q.level = Number(req.query.level);
  if (req.query.status) q.status = req.query.status;
  if (req.query.uplineId) q.uplineId = req.query.uplineId;
  if (req.query.search) { const r = new RegExp(esc(req.query.search), 'i'); q.$or = [{ uplineId: r }, { traderId: r }, { tradeId: r }]; }
  const [rows, count] = await Promise.all([RevenueCommission.find(q).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit), RevenueCommission.countDocuments(q)]);
  const users = await User.find({ _id: { $in: rows.flatMap((r) => [r.uplineId, r.traderId]) } }).select('name').lean();
  const n = new Map(users.map((u) => [u._id, u.name]));
  res.json(paged(rows.map((r) => ({ ...r.toJSON(), uplineName: n.get(r.uplineId), traderName: n.get(r.traderId) })), count, p));
}));
router.get('/structure', asyncHandler(async (_req, res) => res.json({ revenue: await settings.get('ib.revenue'), levelsByIbRank: IB_LEVELS })));
router.put('/structure', asyncHandler(async (req, res) => {
  const { revenue } = z.object({ revenue: z.array(z.number().min(0).max(100)).length(5) }).parse(req.body);
  audit(req.admin, 'Default revenue structure changed', 'Revenue Link', JSON.stringify(revenue));
  res.json({ revenue: await settings.set('ib.revenue', revenue, req.admin.name), levelsByIbRank: IB_LEVELS });
}));
module.exports = router;
