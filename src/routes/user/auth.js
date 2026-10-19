const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { z } = require('zod');
const { User, nextUserId } = require('../../models');
const { sign } = require('../../middleware/auth');
const HttpError = require('../../utils/httpError');
const asyncHandler = require('../../utils/asyncHandler');
const { ancestorsFor } = require('../../services/network');

const code = () => crypto.randomBytes(5).toString('hex').toUpperCase();
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, accountStatus: u.accountStatus, kycStatus: u.kycStatus });

/**
 * Sign up. `ref` is the referral code from the Rebate Link or Revenue Link:
 *  - Rebate link code  -> registrationType "Rebate Link" (rebates flow to the upline chain)
 *  - Revenue link code -> registrationType "Revenue Link" (only valid while the referrer's Revenue Link is Approved, §8.11)
 */
router.post('/register', asyncHandler(async (req, res) => {
  const b = z.object({
    name: z.string().trim().min(2).max(100), email: z.string().email(), password: z.string().min(8).max(100),
    phone: z.string().max(30).default(''), country: z.string().max(60).default(''), ref: z.string().trim().max(40).optional(),
  }).parse(req.body);

  let upline = null, registrationType = 'Direct';
  if (b.ref) {
    const ref = b.ref.toUpperCase();
    upline = await User.findOne({ $or: [{ referralCode: ref }, { revenueCode: ref }] }).select('+ancestors');
    if (!upline) throw new HttpError(400, 'Invalid referral code');
    if (upline.accountStatus === 'Banned') throw new HttpError(400, 'Invalid referral code');
    if (upline.revenueCode === ref) {
      if (upline.revenueLink !== 'Approved') throw new HttpError(400, 'This revenue link is not active');
      registrationType = 'Revenue Link';
    } else registrationType = 'Rebate Link';
  }
  const id = await nextUserId();
  const user = await User.create({
    _id: id, name: b.name, email: b.email, phone: b.phone, country: b.country, passwordHash: await bcrypt.hash(b.password, 12),
    referralCode: code(), uplineId: upline?.id || null, ancestors: ancestorsFor(upline), registrationType,
    referralSource: upline ? `${registrationType} (${upline.id})` : 'Direct',
  });
  if (upline && !upline.isIb) await User.updateOne({ _id: upline.id }, { isIb: true });
  res.status(201).json({ token: sign({ sub: user.id }, 'user'), user: publicUser(user) });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const user = await User.findOne({ email: email.toLowerCase() });
  const ok = await bcrypt.compare(password, user?.passwordHash || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi');
  if (!user || !ok) throw new HttpError(401, 'Invalid email or password');
  if (user.accountStatus === 'Banned') throw new HttpError(403, 'Account is banned');
  res.json({ token: sign({ sub: user.id }, 'user'), user: publicUser(user) });
}));
module.exports = router;
