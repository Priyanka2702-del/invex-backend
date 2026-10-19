const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { Admin } = require('../../models');
const asyncHandler = require('../../utils/asyncHandler');
const HttpError = require('../../utils/httpError');
const audit = require('../../services/audit');

const pw = z.string().min(10, 'Password must be at least 10 characters').max(100);
router.get('/', asyncHandler(async (_req, res) => res.json(await Admin.find().sort({ createdAt: 1 }))));
router.post('/', asyncHandler(async (req, res) => {
  const b = z.object({ email: z.string().email(), name: z.string().min(1), password: pw, role: z.enum(['admin', 'support']).default('admin') }).parse(req.body);
  const a = await Admin.create({ email: b.email, name: b.name, role: b.role, passwordHash: await bcrypt.hash(b.password, 12) });
  audit(req.admin, 'Admin created', 'Admins', `${a.email} (${a.role})`);
  res.status(201).json(a);
}));
router.patch('/:id', asyncHandler(async (req, res) => {
  const b = z.object({ name: z.string().min(1), role: z.enum(['admin', 'support']), password: pw }).partial().parse(req.body);
  const a = await Admin.findById(req.params.id);
  if (!a) throw new HttpError(404, 'Admin not found');
  if (a.isSuperAdmin && b.role) throw new HttpError(400, 'Cannot change the super admin role');
  if (b.name) a.name = b.name; if (b.role) a.role = b.role; if (b.password) a.passwordHash = await bcrypt.hash(b.password, 12);
  await a.save();
  audit(req.admin, 'Admin updated', 'Admins', a.email);
  res.json(a);
}));
router.delete('/:id', asyncHandler(async (req, res) => {
  const a = await Admin.findById(req.params.id);
  if (!a) throw new HttpError(404, 'Admin not found');
  if (a.isSuperAdmin || a.id === req.admin.id) throw new HttpError(400, 'Cannot delete the super admin or yourself');
  await a.deleteOne();
  audit(req.admin, 'Admin deleted', 'Admins', a.email);
  res.json({ ok: true });
}));
module.exports = router;
