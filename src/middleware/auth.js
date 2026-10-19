const jwt = require('jsonwebtoken');
const env = require('../config/env');
const HttpError = require('../utils/httpError');
const { Admin, User } = require('../models');

const sign = (payload, audience, expiresIn = env.JWT_EXPIRES_IN) => jwt.sign(payload, env.JWT_SECRET, { audience, expiresIn });
const bearer = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
};
function verify(req, audience) {
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'Authentication required');
  try { return jwt.verify(token, env.JWT_SECRET, { audience }); }
  catch { throw new HttpError(401, 'Invalid or expired token'); }
}

/** Admin panel auth. Re-reads the admin so removed admins/role changes take effect immediately. */
async function adminAuth(req, _res, next) {
  try {
    const p = verify(req, 'admin');
    const admin = await Admin.findById(p.sub);
    if (!admin) throw new HttpError(401, 'Admin no longer exists');
    req.admin = admin;
    next();
  } catch (e) { next(e); }
}
const requireRole = (...roles) => (req, _res, next) =>
  req.admin && (req.admin.isSuperAdmin || roles.includes(req.admin.role)) ? next() : next(new HttpError(403, 'Insufficient permissions'));

/** User app auth (also accepts the short-lived "login as user" token an admin issues, §8.3). */
async function userAuth(req, _res, next) {
  try {
    const p = verify(req, 'user');
    const user = await User.findById(p.sub).select('+ancestors');
    if (!user) throw new HttpError(401, 'Account not found');
    if (user.accountStatus === 'Banned' && !p.imp) throw new HttpError(403, 'Account is banned');
    req.user = user;
    req.impersonatedBy = p.imp || null;
    next();
  } catch (e) { next(e); }
}

/** MT5 bridge -> API shared secret (x-api-key). Constant-time compare. */
function mt5Key(req, _res, next) {
  const crypto = require('crypto');
  const given = Buffer.from(String(req.headers['x-api-key'] || ''));
  const want = Buffer.from(env.MT5_WEBHOOK_KEY || '');
  if (!want.length || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return next(new HttpError(401, 'Invalid API key'));
  next();
}
module.exports = { sign, adminAuth, requireRole, userAuth, mt5Key };
