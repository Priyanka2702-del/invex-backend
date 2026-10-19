const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { Admin } = require('../../models');
const { sign, adminAuth } = require('../../middleware/auth');
const HttpError = require('../../utils/httpError');
const asyncHandler = require('../../utils/asyncHandler');
const audit = require('../../services/audit');

const shape = (a) => ({ email: a.email, name: a.name, role: a.role, isSuperAdmin: a.isSuperAdmin });
// Matches the admin app: POST /admin-auth/login -> { token, admin }
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const admin = await Admin.findOne({ email: email.toLowerCase() });
  // same message + still hash-compare on unknown email, so responses don't reveal which emails exist
  const ok = await bcrypt.compare(password, admin?.passwordHash || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi');
  if (!admin || !ok) throw new HttpError(401, 'Invalid email or password');
  audit(admin.name, 'Admin login', 'Auth', `Signed in from ${req.ip}`);
  res.json({ token: sign({ sub: admin.id, role: admin.role }, 'admin'), admin: shape(admin) });
}));
router.get('/me', adminAuth, (req, res) => res.json({ admin: shape(req.admin) }));
module.exports = router;
