const router = require('express').Router();
const { z } = require('zod');
const { RebateCommission, RevenueCommission, User } = require('../../models');
const asyncHandler = require('../../utils/asyncHandler');
const HttpError = require('../../utils/httpError');
const { parseRange } = require('../../utils/dateRange');
const { page } = require('../../utils/pagination');
const { paged, esc, rangeFilter } = require('../../utils/serialize');
const settings = require('../../services/settings');
const audit = require('../../services/audit');

const total = (Model, match) => Model.aggregate([{ $match: match }, { $group: { _id: null, t: { $sum: '$amount' }, n: { $sum: 1 } } }]).then(([r]) => ({ amount: r?.t || 0, count: r?.n || 0 }));

/** §1.2 the four cards. Each card has its own Date & Time filter (§1.3): card=?from&to. */
const CARDS = {
  'total-rebate-commission': { hours: null, calc: (r) => total(RebateCommission, { createdAt: { $gte: r.from, $lte: r.to } }) },
  'total-rebate-distribution': { hours: null, calc: (r) => total(RebateCommission, { status: 'Distributed', createdAt: { $gte: r.from, $lte: r.to } }) },
  '24h-rebate-commission': { hours: 24, calc: (r) => total(RebateCommission, { createdAt: { $gte: r.from, $lte: r.to } }) },
  '24h-revenue-commission': { hours: 24, calc: (r) => total(RevenueCommission, { createdAt: { $gte: r.from, $lte: r.to } }) },
};
async function card(name, query = {}) {
  const c = CARDS[name], range = parseRange(query, { defaultHours: c.hours });
  return { card: name, ...(await c.calc(range)), from: range.from, to: range.to };
}
router.get('/cards/:card', asyncHandler(async (req, res) => {
  if (!CARDS[req.params.card]) throw new HttpError(404, `Unknown card. Use one of: ${Object.keys(CARDS).join(', ')}`);
  res.json(await card(req.params.card, req.query));
}));
// all four at once; per-card ranges via ?<card>.from=&<card>.to= (e.g. 24h-rebate-commission.from=...)
router.get('/summary', asyncHandler(async (req, res) => {
  const out = {};
  for (const name of Object.keys(CARDS)) out[name] = await card(name, { from: req.query[`${name}.from`], to: req.query[`${name}.to`] });
  res.json(out);
}));

router.get('/history', asyncHandler(async (req, res) => {
  const p = page(req.query), q = { ...rangeFilter(req.query) };
  if (req.query.level) q.level = Number(req.query.level);
  if (req.query.status) q.status = req.query.status;
  if (req.query.ibUserId) q.ibUserId = req.query.ibUserId;
  if (req.query.search) { const r = new RegExp(esc(req.query.search), 'i'); q.$or = [{ ibUserId: r }, { traderId: r }, { tradeId: r }]; }
  const [rows, count] = await Promise.all([RebateCommission.find(q).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit), RebateCommission.countDocuments(q)]);
  const users = await User.find({ _id: { $in: rows.flatMap((r) => [r.ibUserId, r.traderId]) } }).select('name').lean();
  const n = new Map(users.map((u) => [u._id, u.name]));
  res.json(paged(rows.map((r) => ({ ...r.toJSON(), ibName: n.get(r.ibUserId), traderName: n.get(r.traderId) })), count, p));
}));

// default per-level rebate ($ per lot) used when an IB has no custom structure (§8.7)
router.get('/defaults', asyncHandler(async (_req, res) => res.json({ rebate: await settings.get('ib.rebate') })));
router.put('/defaults', asyncHandler(async (req, res) => {
  const { rebate } = z.object({ rebate: z.array(z.number().min(0)).length(5) }).parse(req.body);
  audit(req.admin, 'Default rebate structure changed', 'Rebate System', JSON.stringify(rebate));
  res.json({ rebate: await settings.set('ib.rebate', rebate, req.admin.name) });
}));
module.exports = router;
