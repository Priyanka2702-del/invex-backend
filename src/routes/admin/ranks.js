const router = require('express').Router();
const { z } = require('zod');
const { SystemRank, User } = require('../../models');
const asyncHandler = require('../../utils/asyncHandler');
const HttpError = require('../../utils/httpError');
const { page } = require('../../utils/pagination');
const { paged } = require('../../utils/serialize');
const { recomputeAll } = require('../../services/rank');
const audit = require('../../services/audit');
const { nextRankProgress } = require('../../logic/rank');

const body = z.object({ name: z.string().trim().min(1).max(40), minTeamDeposit: z.number().min(0), description: z.string().max(200).default(''), status: z.enum(['Active', 'Inactive']).default('Active') });

// §2.2 ranks in order, with how many users hold each
router.get('/', asyncHandler(async (_req, res) => {
  const [ranks, counts] = await Promise.all([SystemRank.find().sort({ minTeamDeposit: 1 }), User.aggregate([{ $match: { systemRankId: { $ne: null } } }, { $group: { _id: '$systemRankId', n: { $sum: 1 } } }])]);
  const c = new Map(counts.map((x) => [x._id, x.n]));
  res.json(ranks.map((r, i) => ({ ...r.toJSON(), position: i + 1, members: c.get(r.id) || 0 })));
}));
router.post('/recalculate', asyncHandler(async (req, res) => {
  const r = await recomputeAll();
  audit(req.admin, 'Team deposits recalculated', 'System Ranks', JSON.stringify(r));
  res.json(r);
}));
// §2.4 click a rank -> every user holding it
router.get('/:id/members', asyncHandler(async (req, res) => {
  const rank = await SystemRank.findById(req.params.id);
  if (!rank) throw new HttpError(404, 'Rank not found');
  const p = page(req.query), q = { systemRankId: rank.id };
  const [rows, total] = await Promise.all([User.find(q).sort({ teamDeposit: -1 }).skip(p.skip).limit(p.limit).select('name email teamDeposit systemRankSource'), User.countDocuments(q)]);
  res.json({ rank: rank.toJSON(), ...paged(rows.map((u) => ({ userId: u.id, name: u.name, email: u.email, totalTeamDeposit: u.teamDeposit, currentSystemRank: rank.name, assigned: u.systemRankSource })), total, p) });
}));
router.post('/', asyncHandler(async (req, res) => {
  const b = body.parse(req.body);
  const position = (await SystemRank.countDocuments()) + 1;
  const r = await SystemRank.create({ ...b, position });
  audit(req.admin, 'System rank created', 'System Ranks', `${r.name} @ ${r.minTeamDeposit}`);
  res.status(201).json(r);
}));
router.patch('/:id', asyncHandler(async (req, res) => {
  const b = body.partial().parse(req.body);
  const r = await SystemRank.findByIdAndUpdate(req.params.id, b, { new: true });
  if (!r) throw new HttpError(404, 'Rank not found');
  audit(req.admin, 'System rank edited', 'System Ranks', JSON.stringify(b));
  res.json(r);
}));
router.delete('/:id', asyncHandler(async (req, res) => {
  const held = await User.countDocuments({ systemRankId: req.params.id });
  if (held && req.query.force !== 'true') throw new HttpError(409, `${held} user(s) hold this rank. Re-assign them or pass ?force=true to clear it from them.`);
  const r = await SystemRank.findByIdAndDelete(req.params.id);
  if (!r) throw new HttpError(404, 'Rank not found');
  if (held) await User.updateMany({ systemRankId: r.id }, { systemRankId: null, systemRankSource: null });
  audit(req.admin, 'System rank deleted', 'System Ranks', r.name);
  res.json({ ok: true });
}));
module.exports = router;
