const { User, SystemRank, Transaction } = require('../models');
const { autoRankDecision } = require('../logic/rank');

const activeRanks = () => SystemRank.find({ status: 'Active' }).sort({ minTeamDeposit: 1 }).lean();

/** §2.3/§3.1: promote on Total Team Deposit. Auto only ever upgrades; manual ranks are never touched. */
async function evaluateRank(userId) {
  const [u, ranks] = await Promise.all([User.findById(userId).select('teamDeposit systemRankId systemRankSource'), activeRanks()]);
  if (!u || !ranks.length) return null;
  const current = u.systemRankId ? ranks.find((r) => r._id === u.systemRankId)?.name : null;
  const next = autoRankDecision({ current, source: u.systemRankSource }, u.teamDeposit, ranks.map((r) => ({ name: r.name, minTeamDeposit: r.minTeamDeposit })));
  if (!next) return null;
  const rank = ranks.find((r) => r.name === next);
  await User.updateOne({ _id: userId }, { systemRankId: rank._id, systemRankSource: 'auto' });
  return rank;
}

/** A deposit of `delta` (negative = reversal) by `userId` changes the team deposit of every ancestor. */
async function adjustTeamDeposit(userId, delta) {
  if (!delta) return;
  const u = await User.findById(userId).select('+ancestors');
  if (!u?.ancestors?.length) return;
  await User.updateMany({ _id: { $in: u.ancestors } }, { $inc: { teamDeposit: delta } });
  if (delta > 0) for (const id of u.ancestors) await evaluateRank(id);
}

/** Repair tool / nightly safety net: rebuild every teamDeposit from the transaction history. */
async function recomputeAll() {
  const own = new Map((await Transaction.aggregate([{ $match: { kind: 'deposit', status: 'Successful' } }, { $group: { _id: '$userId', t: { $sum: '$amount' } } }])).map((r) => [r._id, r.t]));
  const users = await User.find().select('+ancestors').lean();
  const team = new Map();
  for (const u of users) { const d = own.get(u._id) || 0; if (d) for (const a of u.ancestors || []) team.set(a, (team.get(a) || 0) + d); }
  await User.bulkWrite(users.map((u) => ({ updateOne: { filter: { _id: u._id }, update: { $set: { teamDeposit: team.get(u._id) || 0 } } } })));
  let promoted = 0;
  for (const u of users) if ((team.get(u._id) || 0) > 0 && (await evaluateRank(u._id))) promoted++;
  return { users: users.length, promoted };
}
module.exports = { evaluateRank, adjustTeamDeposit, recomputeAll, activeRanks };
