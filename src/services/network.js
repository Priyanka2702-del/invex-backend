const { User, Transaction } = require('../models');
const HttpError = require('../utils/httpError');
const { MAX_NETWORK_LEVELS } = require('../constants');

/** Upline chain, index 0 = Level 1 (direct upline). Takes a user doc loaded with +ancestors. */
async function uplineChain(user, max = MAX_NETWORK_LEVELS) {
  const ids = (user.ancestors || []).slice(0, max);
  if (!ids.length) return [];
  const docs = await User.find({ _id: { $in: ids } });
  const byId = new Map(docs.map((d) => [d.id, d]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}
/** Build the materialised path for a new/moved user under `upline` (or none). */
const ancestorsFor = (upline) => (upline ? [upline.id, ...(upline.ancestors || [])] : []);

/** Users exactly `level` levels below `rootId`. */
const levelQuery = (rootId, level) => ({ [`ancestors.${level - 1}`]: rootId });

const ownDeposits = async (userId) => {
  const [r] = await Transaction.aggregate([{ $match: { userId, kind: 'deposit', status: 'Successful' } }, { $group: { _id: null, t: { $sum: '$amount' } } }]);
  return r?.t || 0;
};

/**
 * §8.1 change a user's Upline. Rewrites the materialised path of the whole moved subtree and moves the
 * team-deposit totals between the old and new chains. Refuses cycles.
 */
async function setUpline(userId, newUplineId) {
  const user = await User.findById(userId).select('+ancestors');
  if (!user) throw new HttpError(404, 'User not found');
  let upline = null;
  if (newUplineId) {
    if (newUplineId === userId) throw new HttpError(400, 'A user cannot be their own upline');
    upline = await User.findById(newUplineId).select('+ancestors');
    if (!upline) throw new HttpError(404, 'New upline not found');
    if (upline.ancestors.includes(userId)) throw new HttpError(400, 'That user is in this user\'s downline — it would create a loop');
  }
  const oldAnc = user.ancestors;
  const newAnc = ancestorsFor(upline);

  const subtree = await User.find({ ancestors: userId }).select('+ancestors');
  const ops = [{ updateOne: { filter: { _id: userId }, update: { $set: { uplineId: upline ? upline.id : null, ancestors: newAnc } } } }];
  for (const d of subtree) {
    const idx = d.ancestors.indexOf(userId);
    ops.push({ updateOne: { filter: { _id: d.id }, update: { $set: { ancestors: [...d.ancestors.slice(0, idx + 1), ...newAnc] } } } });
  }
  await User.bulkWrite(ops);

  const moved = (await ownDeposits(userId)) + (user.teamDeposit || 0);
  if (moved) {
    if (oldAnc.length) await User.updateMany({ _id: { $in: oldAnc } }, { $inc: { teamDeposit: -moved } });
    if (newAnc.length) await User.updateMany({ _id: { $in: newAnc } }, { $inc: { teamDeposit: moved } });
  }
  if (upline && !upline.isIb) await User.updateOne({ _id: upline.id }, { isIb: true });
  return { oldUplineId: user.uplineId, newUplineId: upline?.id || null, newAnc };
}

/** Level-2 team current equity for every IB at once (§3.2: only Level 2 counts). */
async function level2EquityMap() {
  // Group by the whole ancestor path (one group per distinct upline chain), then bucket by ancestors[1] in JS.
  const rows = await User.aggregate([
    { $match: { 'ancestors.1': { $exists: true } } },
    { $group: { _id: '$ancestors', equity: { $sum: '$mt5Equity' } } },
  ]);
  const map = new Map();
  for (const r of rows) map.set(r._id[1], (map.get(r._id[1]) || 0) + r.equity);
  return map;
}
const level2Equity = async (ibId) => (await level2EquityMap()).get(ibId) || 0;

module.exports = { uplineChain, ancestorsFor, levelQuery, setUpline, level2EquityMap, level2Equity, ownDeposits };
