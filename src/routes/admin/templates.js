const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { z } = require('zod');
const { MediaAsset, Promotion } = require('../../models');
const asyncHandler = require('../../utils/asyncHandler');
const HttpError = require('../../utils/httpError');
const env = require('../../config/env');
const audit = require('../../services/audit');
const { rangeFilter } = require('../../utils/serialize');

const dir = path.resolve(env.UPLOAD_DIR);
fs.mkdirSync(dir, { recursive: true });
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }; // no SVG: it can carry scripts
const upload = multer({
  storage: multer.diskStorage({ destination: dir, filename: (_r, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + EXT[f.mimetype]) }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_r, f, cb) => (EXT[f.mimetype] ? cb(null, true) : cb(new HttpError(400, 'Only JPG, PNG, WEBP or GIF images up to 5 MB are allowed'))),
});
const urlFor = (f) => `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/uploads/${f}`;
const rm = (filename) => filename && fs.promises.unlink(path.join(dir, path.basename(filename))).catch(() => {});

/* ---- §9.1 pictures / banners / graphics ---- */
const meta = z.object({ title: z.string().trim().min(1).max(120), kind: z.enum(['image', 'banner', 'graphic', 'other']).default('image'), text: z.string().max(2000).default('') });
router.get('/media', asyncHandler(async (req, res) => {
  const q = { ...rangeFilter(req.query) }; if (req.query.kind) q.kind = req.query.kind;
  res.json(await MediaAsset.find(q).sort({ createdAt: -1 }));
}));
router.post('/media', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'file is required (multipart field "file")');
  let b; try { b = meta.parse(req.body); } catch (e) { await rm(req.file.filename); throw e; }
  const m = await MediaAsset.create({ ...b, url: urlFor(req.file.filename), filename: req.file.filename });
  audit(req.admin, 'Media uploaded', 'Manage Templates', m.title);
  res.status(201).json(m);
}));
// edit text/meta, and optionally replace the image in the same call
router.patch('/media/:id', upload.single('file'), asyncHandler(async (req, res) => {
  const m = await MediaAsset.findById(req.params.id);
  if (!m) { if (req.file) await rm(req.file.filename); throw new HttpError(404, 'Media not found'); }
  const b = meta.partial().parse(req.body);
  Object.assign(m, b);
  if (req.file) { const old = m.filename; m.filename = req.file.filename; m.url = urlFor(req.file.filename); await m.save(); await rm(old); } else await m.save();
  audit(req.admin, 'Media edited', 'Manage Templates', m.title);
  res.json(m);
}));
router.delete('/media/:id', asyncHandler(async (req, res) => {
  const m = await MediaAsset.findByIdAndDelete(req.params.id);
  if (!m) throw new HttpError(404, 'Media not found');
  await rm(m.filename);
  await Promotion.updateMany({ mediaId: m.id }, { mediaId: null });
  audit(req.admin, 'Media deleted', 'Manage Templates', m.title);
  res.json({ ok: true });
}));

/* ---- §9.2 promotions ---- */
const promo = z.object({
  title: z.string().trim().min(1).max(160), type: z.enum(['Bonus', 'Contest', 'Special Offer', 'Other']).default('Special Offer'),
  description: z.string().max(5000).default(''), mediaId: z.string().nullable().default(null),
  settings: z.record(z.any()).default({}), status: z.enum(['Draft', 'Active', 'Paused', 'Ended']).default('Draft'),
  startsAt: z.coerce.date().nullable().optional(), endsAt: z.coerce.date().nullable().optional(),
}).refine((p) => !p.startsAt || !p.endsAt || p.startsAt <= p.endsAt, { message: 'endsAt must be after startsAt', path: ['endsAt'] });
router.get('/promotions', asyncHandler(async (req, res) => {
  const q = {}; if (req.query.status) q.status = req.query.status; if (req.query.type) q.type = req.query.type;
  res.json(await Promotion.find(q).sort({ createdAt: -1 }));
}));
router.post('/promotions', asyncHandler(async (req, res) => {
  const p = await Promotion.create(promo.parse(req.body));
  audit(req.admin, 'Promotion created', 'Manage Templates', p.title);
  res.status(201).json(p);
}));
router.patch('/promotions/:id', asyncHandler(async (req, res) => {
  const b = promo.innerType().partial().parse(req.body);
  const p = await Promotion.findByIdAndUpdate(req.params.id, b, { new: true });
  if (!p) throw new HttpError(404, 'Promotion not found');
  audit(req.admin, 'Promotion edited', 'Manage Templates', p.title);
  res.json(p);
}));
router.delete('/promotions/:id', asyncHandler(async (req, res) => {
  const p = await Promotion.findByIdAndDelete(req.params.id);
  if (!p) throw new HttpError(404, 'Promotion not found');
  audit(req.admin, 'Promotion deleted', 'Manage Templates', p.title);
  res.json({ ok: true });
}));
module.exports = router;
