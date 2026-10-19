const router = require('express').Router();
const { z } = require('zod');
const { PamTransaction, User } = require('../../models');
const asyncHandler = require('../../utils/asyncHandler');
const { page } = require('../../utils/pagination');
const { paged, rangeFilter, datesByUser } = require('../../utils/serialize');
const settings = require('../../services/settings');
const audit = require('../../services/audit');

async function perClient(match = {}) {
  const rows = await PamTransaction.aggregate([
    { $match: { ...match, type: 'deposit' } },
    { $group: { _id: '$userId', deposited: { $sum: '$amount' } } },
  ]);
  return rows;
}
// §5.1 overview
router.get('/overview', asyncHandler(async (_req, res) => {
  const rows = (await perClient()).filter((r) => r.deposited > 0);
  res.json({ totalDeposit: rows.reduce((s, r) => s + r.deposited, 0), totalClients: rows.length });
}));
router.get('/history', asyncHandler(async (req, res) => {
  const p = page(req.query), q = { ...rangeFilter(req.query) };
  if (req.query.type) q.type = req.query.type;
  const [rows, total] = await Promise.all([PamTransaction.find(q).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit), PamTransaction.countDocuments(q)]);
  res.json(paged(rows, total, p));
}));
// §5.2 client-wise deposits
router.get('/clients', asyncHandler(async (req, res) => {
  const p = page(req.query), rows = (await perClient(rangeFilter(req.query))).filter((r) => r.deposited > 0).sort((a, b) => b.deposited - a.deposited);
  const slice = rows.slice(p.skip, p.skip + p.limit);
  const ids = slice.map((r) => r._id);
  const [users, dates] = await Promise.all([User.find({ _id: { $in: ids } }).select('name email').lean(), datesByUser(PamTransaction, ids)]);
  const names = new Map(users.map((u) => [u._id, u]));
  res.json(paged(slice.map((r) => ({ userId: r._id, name: names.get(r._id)?.name, email: names.get(r._id)?.email, depositAmount: r.deposited, firstDepositAt: dates.get(r._id)?.firstAt, lastActivityAt: dates.get(r._id)?.lastAt })), rows.length, p));
}));
router.get('/clients/:id', asyncHandler(async (req, res) => {
  const [user, history] = await Promise.all([User.findById(req.params.id).select('name email phone country'), PamTransaction.find({ userId: req.params.id }).sort({ createdAt: -1 })]);
  res.json({ user, totalDeposit: history.filter((h) => h.type === 'deposit').reduce((s, h) => s + h.amount, 0), history });
}));
// §5.3 profit % taken + monthly return given to the client
router.get('/settings', asyncHandler(async (_req, res) => res.json(await settings.get('pam'))));
router.put('/settings', asyncHandler(async (req, res) => {
  const b = z.object({ profitSharePct: z.number().min(0).max(100), monthlyReturnPct: z.number().min(0).max(100) }).partial().parse(req.body);
  const cur = await settings.get('pam');
  audit(req.admin, 'PAM settings changed', 'PAM', JSON.stringify(b));
  res.json(await settings.set('pam', { ...cur, ...b }, req.admin.name));
}));
module.exports = router;
