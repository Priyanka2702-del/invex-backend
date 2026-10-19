const router = require('express').Router();
const { z } = require('zod');
const { Transaction, Trade, User } = require('../../models');
const HttpError = require('../../utils/httpError');
const asyncHandler = require('../../utils/asyncHandler');
const { page } = require('../../utils/pagination');
const { paged, esc, rangeFilter } = require('../../utils/serialize');
const tx = require('../../services/transactions');
const audit = require('../../services/audit');

/** Attach user name/email so the admin tables don't need a second call. */
async function withUsers(rows) {
  const users = await User.find({ _id: { $in: [...new Set(rows.map((r) => r.userId))] } }).select('name email').lean();
  const m = new Map(users.map((u) => [u._id, u]));
  return rows.map((r) => ({ ...r.toJSON(), user: m.get(r.userId) ? { id: r.userId, name: m.get(r.userId).name, email: m.get(r.userId).email } : null }));
}
const listTx = (kind) => asyncHandler(async (req, res) => {
  const p = page(req.query), q = { ...(kind && { kind }), ...rangeFilter(req.query) };
  if (!kind && req.query.kind) q.kind = req.query.kind;
  if (req.query.status) q.status = req.query.status;
  if (req.query.userId) q.userId = req.query.userId;
  if (req.query.search) { const r = new RegExp(esc(req.query.search), 'i'); q.$or = [{ _id: r }, { txId: r }, { userId: r }]; }
  const [rows, total] = await Promise.all([Transaction.find(q).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit), Transaction.countDocuments(q)]);
  res.json(paged(await withUsers(rows), total, p));
});
router.get('/transactions', listTx());
router.get('/deposits', listTx('deposit'));
router.get('/withdrawals', listTx('withdrawal'));

const review = (kind) => asyncHandler(async (req, res) => {
  const { status, note } = z.object({ status: z.enum(['Successful', 'Rejected']), note: z.string().max(300).optional() }).parse(req.body);
  const t = await tx.review(kind, req.params.id, status, { note, adminName: req.admin.name });
  audit(req.admin, `${kind} ${status === 'Successful' ? 'approved' : 'rejected'}`, 'Finance', `${t.id} ${t.amount}`, t.userId);
  res.json(t);
});
router.post('/deposits/:id/review', review('deposit'));
router.post('/withdrawals/:id/review', review('withdrawal'));

// §8.12 edit any transaction; balances / team deposit are corrected by the difference
router.patch('/transactions/:id', asyncHandler(async (req, res) => {
  const b = z.object({
    amount: z.number().positive().max(10_000_000), method: z.string().max(60), txId: z.string().max(120),
    destination: z.string().max(200).nullable(), note: z.string().max(300), createdAt: z.coerce.date(),
  }).partial().parse(req.body);
  const t = await tx.edit(req.params.id, b, req.admin.name);
  audit(req.admin, 'Transaction edited', 'Finance', `${t.id}: ${Object.keys(b).join(', ')}`, t.userId);
  res.json(t);
}));

router.get('/trades', asyncHandler(async (req, res) => {
  const p = page(req.query), q = { ...rangeFilter(req.query, 'openTime') };
  for (const k of ['status', 'userId', 'symbol']) if (req.query[k]) q[k] = req.query[k];
  const [rows, total] = await Promise.all([Trade.find(q).sort({ openTime: -1 }).skip(p.skip).limit(p.limit), Trade.countDocuments(q)]);
  res.json(paged(rows, total, p));
}));
router.get('/trades/:id', asyncHandler(async (req, res) => {
  const t = await Trade.findById(req.params.id);
  if (!t) throw new HttpError(404, 'Trade not found');
  res.json(t);
}));
module.exports = router;
