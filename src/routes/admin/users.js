const router = require('express').Router();
const { z } = require('zod');
const { User, SystemRank, Transaction, Trade, LedgerEntry } = require('../../models');
const C = require('../../constants');
const HttpError = require('../../utils/httpError');
const asyncHandler = require('../../utils/asyncHandler');
const { page } = require('../../utils/pagination');
const { paged, esc, rangeFilter } = require('../../utils/serialize');
const { setUpline, levelQuery } = require('../../services/network');
const { evaluateRank } = require('../../services/rank');
const ledger = require('../../services/ledger');
const mt5 = require('../../services/mt5');
const audit = require('../../services/audit');
const { sign } = require('../../middleware/auth');
const env = require('../../config/env');
const { genId } = require('../../utils/ids');

const must = async (id, sel = '') => { const u = await User.findById(id).select(sel); if (!u) throw new HttpError(404, 'User not found'); return u; };

/* ------------------------------------------------------------------ list (all Clients sub-pages) */
router.get('/', asyncHandler(async (req, res) => {
  const q = {}, p = page(req.query);
  const { status, kyc, registrationType, hasBalance, search, systemRankId, ibRank, isIb, revenueLink } = req.query;
  if (status) q.accountStatus = status;
  if (kyc) q.kycStatus = kyc;
  if (registrationType) q.registrationType = registrationType;
  if (systemRankId) q.systemRankId = systemRankId;
  if (ibRank) q.ibRank = ibRank;
  if (isIb !== undefined) q.isIb = isIb === 'true';
  if (revenueLink) q.revenueLink = revenueLink;
  if (hasBalance === 'true') q.walletBalance = { $gt: 0 };
  if (search) { const r = new RegExp(esc(search), 'i'); q.$or = [{ name: r }, { email: r }, { phone: r }, { _id: r }]; }
  Object.assign(q, rangeFilter(req.query));
  const [rows, total, ranks] = await Promise.all([
    User.find(q).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit), User.countDocuments(q), SystemRank.find().lean(),
  ]);
  const rn = new Map(ranks.map((r) => [r._id, r.name]));
  res.json(paged(rows.map((u) => ({ ...u.toJSON(), systemRank: rn.get(u.systemRankId) || null })), total, p));
}));

/* ------------------------------------------------------------------ profile (§8) */
router.get('/:id', asyncHandler(async (req, res) => {
  const u = await must(req.params.id, '+ancestors');
  const [upline, rank, directs, level2, team, l2eq] = await Promise.all([
    u.uplineId ? User.findById(u.uplineId).select('name email') : null,
    u.systemRankId ? SystemRank.findById(u.systemRankId).lean() : null,
    User.countDocuments({ uplineId: u.id }), User.countDocuments(levelQuery(u.id, 2)), User.countDocuments({ ancestors: u.id }),
    User.aggregate([{ $match: levelQuery(u.id, 2) }, { $group: { _id: null, e: { $sum: '$mt5Equity' } } }]),
  ]);
  res.json({
    ...u.toJSON(),
    upline: upline ? { id: upline.id, name: upline.name, email: upline.email } : null,
    systemRank: rank ? { id: rank._id, name: rank.name } : null,
    verification: { kycStatus: u.kycStatus, kycDetails: u.kycDetails, email: u.email, emailVerified: u.emailVerified, phone: u.phone, phoneVerified: u.phoneVerified, country: u.country },
    network: { directs, level2, teamSize: team, teamDeposit: u.teamDeposit, level2Equity: l2eq[0]?.e || 0 },
    links: { rebate: u.referralCode, revenue: u.revenueLink === 'Approved' ? u.revenueCode : null },
  });
}));
router.patch('/:id', asyncHandler(async (req, res) => {
  const b = z.object({ name: z.string().min(1), phone: z.string(), country: z.string(), accountType: z.enum(C.ACCOUNT_TYPES), mt5Login: z.string().nullable() }).partial().parse(req.body);
  const u = await User.findByIdAndUpdate(req.params.id, b, { new: true });
  if (!u) throw new HttpError(404, 'User not found');
  audit(req.admin, 'Profile edited', 'Clients', Object.keys(b).join(', '), u.id);
  res.json(u);
}));

/* ------------------------------------------------------------------ §8.2 financial history */
const history = (Model, extra) => asyncHandler(async (req, res) => {
  const p = page(req.query), q = { userId: req.params.id, ...extra, ...rangeFilter(req.query, Model === Trade ? 'openTime' : 'createdAt') };
  const [rows, total] = await Promise.all([Model.find(q).sort({ [Model === Trade ? 'openTime' : 'createdAt']: -1 }).skip(p.skip).limit(p.limit), Model.countDocuments(q)]);
  res.json(paged(rows, total, p));
});
router.get('/:id/trades', history(Trade));
router.get('/:id/deposits', history(Transaction, { kind: 'deposit' }));
router.get('/:id/withdrawals', history(Transaction, { kind: 'withdrawal' }));
router.get('/:id/ledger', history(LedgerEntry));

/* ------------------------------------------------------------------ §8.1 upline */
router.put('/:id/upline', asyncHandler(async (req, res) => {
  const { uplineId } = z.object({ uplineId: z.string().min(1).nullable() }).parse(req.body);
  const r = await setUpline(req.params.id, uplineId);
  if (r.newUplineId) await evaluateRank(r.newUplineId);
  audit(req.admin, 'Upline changed', 'Clients', `${r.oldUplineId || 'none'} -> ${r.newUplineId || 'none'}`, req.params.id);
  res.json({ ok: true, ...r });
}));

/* ------------------------------------------------------------------ §8.3 / §8.6 status, warn, ban, verification */
const setStatus = async (req, status, extra = {}) => {
  const u = await User.findByIdAndUpdate(req.params.id, { accountStatus: status, ...extra }, { new: true });
  if (!u) throw new HttpError(404, 'User not found');
  audit(req.admin, 'User status changed', 'Clients', `Account status set to ${status}`, u.id);
  return u;
};
router.patch('/:id/status', asyncHandler(async (req, res) => {
  const { status } = z.object({ status: z.enum(C.ACCOUNT_STATUSES) }).parse(req.body);
  res.json(await setStatus(req, status));
}));
router.post('/:id/ban', asyncHandler(async (req, res) => res.json(await setStatus(req, 'Banned'))));
router.post('/:id/warn', asyncHandler(async (req, res) => {
  const u = await setStatus(req, 'Warned', { $inc: { warningCount: 1 } }); res.json(u);
}));
router.patch('/:id/verification', asyncHandler(async (req, res) => {
  const b = z.object({ kycStatus: z.enum(C.KYC_STATUSES), emailVerified: z.boolean(), phoneVerified: z.boolean() }).partial().parse(req.body);
  const u = await User.findByIdAndUpdate(req.params.id, b, { new: true });
  if (!u) throw new HttpError(404, 'User not found');
  audit(req.admin, 'Verification updated', 'KYC', JSON.stringify(b), u.id);
  res.json(u);
}));
router.post('/:id/impersonate', asyncHandler(async (req, res) => {
  const u = await must(req.params.id);
  const token = sign({ sub: u.id, imp: req.admin.id }, 'user', '1h'); // short-lived, marked as impersonation
  audit(req.admin, 'Login to user account', 'Clients', 'Admin opened a user session', u.id);
  res.json({ token, url: `${env.USER_APP_URL}/impersonate?token=${token}` });
}));

/* ------------------------------------------------------------------ §8.4 / §8.5 plus & minus (wallet vs MT5 equity — separate) */
router.post('/:id/balance', asyncHandler(async (req, res) => {
  const b = z.object({ target: z.enum(['wallet', 'equity']), op: z.enum(['add', 'minus']), amount: z.number().positive().max(10_000_000), reason: z.string().trim().min(3).max(200) }).parse(req.body);
  const u = await must(req.params.id);
  const signed = b.op === 'add' ? b.amount : -b.amount;
  const account = b.target === 'wallet' ? 'wallet' : 'equity';
  if (b.target === 'equity') {
    if (signed < 0 && u.mt5Equity < b.amount) throw new HttpError(409, 'Insufficient MT5 equity');
    await mt5.adjustEquity(u.mt5Login, signed, b.reason); // apply on MT5 first; throws (502) if the bridge refuses
  }
  const entry = await ledger.post({ userId: u.id, account, amount: signed, type: b.op === 'add' ? 'admin_add' : 'admin_minus', note: b.reason, createdBy: req.admin.name, refId: genId('ADJ') });
  audit(req.admin, `${b.op === 'add' ? 'Add' : 'Minus'} ${b.target}`, 'Clients', `${signed > 0 ? '+' : ''}${signed} (${b.reason})`, u.id);
  res.json({ ok: true, entry });
}));

/* ------------------------------------------------------------------ §8.7 custom IB structure, §8.8 IB rank, §8.9 system rank */
router.put('/:id/custom-ib', asyncHandler(async (req, res) => {
  const lvl = z.array(z.number().min(0).max(1000).nullable()).max(5);
  const { rebate, revenue } = z.object({ rebate: lvl.default([]), revenue: lvl.default([]) }).parse(req.body);
  if (revenue.some((v) => v !== null && v > 100)) throw new HttpError(400, 'Revenue % cannot exceed 100');
  const u = await User.findByIdAndUpdate(req.params.id, { customIb: { rebate, revenue } }, { new: true });
  if (!u) throw new HttpError(404, 'User not found');
  audit(req.admin, 'Custom IB structure set', 'IB Management', JSON.stringify({ rebate, revenue }), u.id);
  res.json(u);
}));
router.delete('/:id/custom-ib', asyncHandler(async (req, res) => {
  const u = await User.findByIdAndUpdate(req.params.id, { $unset: { customIb: 1 } }, { new: true });
  if (!u) throw new HttpError(404, 'User not found');
  audit(req.admin, 'Custom IB structure cleared', 'IB Management', 'Back to defaults', u.id);
  res.json(u);
}));
router.put('/:id/ib-rank', asyncHandler(async (req, res) => {
  const { rank } = z.object({ rank: z.enum(C.IB_RANKS) }).parse(req.body);
  const u = await User.findByIdAndUpdate(req.params.id, { ibRank: rank, isIb: true }, { new: true });
  if (!u) throw new HttpError(404, 'User not found');
  audit(req.admin, 'IB rank assigned', 'IB Management', `IB rank set to ${rank}`, u.id);
  res.json(u);
}));
/** rankId => manual assignment (lifetime, never auto-changed). rankId null => remove manual override and re-evaluate automatically. */
router.put('/:id/system-rank', asyncHandler(async (req, res) => {
  const { rankId } = z.object({ rankId: z.string().nullable() }).parse(req.body);
  let u;
  if (rankId) {
    const r = await SystemRank.findById(rankId);
    if (!r) throw new HttpError(404, 'Rank not found');
    u = await User.findByIdAndUpdate(req.params.id, { systemRankId: r.id, systemRankSource: 'manual' }, { new: true });
    audit(req.admin, 'System rank assigned', 'System Ranks', `Manually set to ${r.name}`, req.params.id);
  } else {
    u = await User.findByIdAndUpdate(req.params.id, { systemRankId: null, systemRankSource: null }, { new: true });
    if (u) { await evaluateRank(u.id); u = await User.findById(u.id); }
    audit(req.admin, 'System rank removed', 'System Ranks', 'Manual rank removed; automatic evaluation resumed', req.params.id);
  }
  if (!u) throw new HttpError(404, 'User not found');
  res.json(u);
}));

/* ------------------------------------------------------------------ §8.10 marketing account, §8.11 revenue link approval */
router.post('/:id/marketing', asyncHandler(async (req, res) => {
  const { dummyDollars } = z.object({ dummyDollars: z.number().min(0).max(10_000_000).optional() }).parse(req.body || {});
  const u = await User.findByIdAndUpdate(req.params.id, { marketing: { assignedAt: new Date(), approvedBy: req.admin.name } }, { new: true });
  if (!u) throw new HttpError(404, 'User not found');
  if (dummyDollars) await ledger.post({ userId: u.id, account: 'dummy', amount: dummyDollars, type: 'marketing_grant', createdBy: req.admin.name, note: 'Marketing dummy dollars' });
  audit(req.admin, 'Marketing Account approved', 'Marketing Accounts', `Dummy dollars granted: ${dummyDollars || 0}`, u.id);
  res.json(await User.findById(u.id));
}));
router.post('/:id/marketing/grant', asyncHandler(async (req, res) => {
  const { amount } = z.object({ amount: z.number().positive().max(10_000_000) }).parse(req.body);
  const u = await must(req.params.id);
  if (!u.marketing) throw new HttpError(409, 'User is not a Marketing Account');
  const entry = await ledger.post({ userId: u.id, account: 'dummy', amount, type: 'marketing_grant', createdBy: req.admin.name, note: 'Marketing dummy dollars' });
  audit(req.admin, 'Dummy dollars granted', 'Marketing Accounts', `+${amount}`, u.id);
  res.json({ ok: true, entry });
}));
router.delete('/:id/marketing', asyncHandler(async (req, res) => {
  const u = await User.findByIdAndUpdate(req.params.id, { $unset: { marketing: 1 }, dummyBalance: 0 }, { new: true }); // dummy dollars die with the marketing status
  if (!u) throw new HttpError(404, 'User not found');
  audit(req.admin, 'Marketing status removed', 'Marketing Accounts', 'Marketing Account status removed', u.id);
  res.json(u);
}));
router.put('/:id/revenue-link', asyncHandler(async (req, res) => {
  const { status } = z.object({ status: z.enum(['None', 'Pending', 'Approved', 'Rejected']) }).parse(req.body);
  const u = await must(req.params.id);
  u.revenueLink = status;
  if (status === 'Approved') { if (!u.revenueCode) u.revenueCode = `R${genId('X').slice(2)}`; u.isIb = true; }
  await u.save();
  audit(req.admin, 'Revenue Link', 'Clients', `Revenue Link ${status}`, u.id);
  res.json(u);
}));
module.exports = router;
