const router = require('express').Router();
const { z } = require('zod');
const { EquityMonth, User } = require('../../models');
const asyncHandler = require('../../utils/asyncHandler');
const { page } = require('../../utils/pagination');
const { paged } = require('../../utils/serialize');
const { ym } = require('../../utils/dateRange');
const eq = require('../../services/equity');
const audit = require('../../services/audit');
const { EQUITY_TIERS, EQUITY_MAX_FAILURES } = require('../../constants');

const monthSchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM') });
router.get('/tiers', (_req, res) => res.json({ tiers: EQUITY_TIERS.map((t) => ({ min: t.min, max: Number.isFinite(t.max) ? t.max : null, pct: t.pct })), maxFailures: EQUITY_MAX_FAILURES }));

// monthly overview, each row = IB, L2 equity maintained, %, warnings (§3.5 count is automatic), bonus, status
router.get('/', asyncHandler(async (req, res) => {
  const month = req.query.month || ym(), p = page(req.query), q = { month };
  if (req.query.status) q.status = req.query.status;
  const [rows, total] = await Promise.all([EquityMonth.find(q).sort({ bonus: -1, minEquity: -1 }).skip(p.skip).limit(p.limit), EquityMonth.countDocuments(q)]);
  const names = new Map((await User.find({ _id: { $in: rows.map((r) => r.ibUserId) } }).select('name').lean()).map((u) => [u._id, u.name]));
  res.json({ month, ...paged(rows.map((r) => ({ ...r.toJSON(), name: names.get(r.ibUserId), warnings: Math.min(r.failureCount, EQUITY_MAX_FAILURES) })), total, p) });
}));
router.get('/user/:ibUserId', asyncHandler(async (req, res) => res.json(await EquityMonth.find({ ibUserId: req.params.ibUserId }).sort({ month: -1 }))));

// manual triggers (cron does these automatically)
router.post('/snapshot', asyncHandler(async (req, res) => { const r = await eq.runDailySnapshot(); audit(req.admin, 'Equity snapshot run', 'Equity Bonus', JSON.stringify(r)); res.json(r); }));
router.post('/finalize', asyncHandler(async (req, res) => { const { month } = monthSchema.parse(req.body); const r = await eq.finalizeMonth(month); audit(req.admin, 'Equity month finalized', 'Equity Bonus', JSON.stringify(r)); res.json(r); }));
router.post('/pay', asyncHandler(async (req, res) => {
  const { month, ibUserId } = monthSchema.extend({ ibUserId: z.string().optional() }).parse(req.body);
  const r = await eq.payMonth(month, req.admin.name, { ibUserId });
  audit(req.admin, 'Equity bonus paid', 'Equity Bonus', JSON.stringify(r));
  res.json(r);
}));
module.exports = router;
