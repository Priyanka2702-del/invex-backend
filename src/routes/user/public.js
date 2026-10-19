const router = require('express').Router();
const { Promotion, MediaAsset, AccountType } = require('../../models');
const asyncHandler = require('../../utils/asyncHandler');

// §9: what the website/app shows. Only Active promotions inside their date window.
router.get('/promotions', asyncHandler(async (_req, res) => {
  const now = new Date();
  const promos = await Promotion.find({ status: 'Active', $and: [{ $or: [{ startsAt: null }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }] }).sort({ createdAt: -1 });
  const media = new Map((await MediaAsset.find({ _id: { $in: promos.map((p) => p.mediaId).filter(Boolean) } })).map((m) => [m.id, m]));
  res.json(promos.map((p) => ({ ...p.toJSON(), media: media.get(p.mediaId) || null })));
}));
router.get('/templates', asyncHandler(async (_req, res) => res.json(await MediaAsset.find().sort({ createdAt: -1 }))));
// leverage + separate-per-lot per account type (§6) so the app can show what is available
router.get('/account-types', asyncHandler(async (_req, res) => res.json(await AccountType.find())));
module.exports = router;
