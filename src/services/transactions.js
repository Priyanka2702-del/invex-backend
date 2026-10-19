const { Transaction, User } = require('../models');
const HttpError = require('../utils/httpError');
const ledger = require('./ledger');
const { adjustTeamDeposit } = require('./rank');
const realtime = require('./realtime');

/** User asks to deposit (funds are credited only when an admin/gateway marks it Successful). */
async function createDeposit(userId, { amount, method, txId, note }) {
  return Transaction.create({ kind: 'deposit', userId, amount, method, txId, note, status: 'Pending' });
}
/** Withdrawal: funds are debited from the wallet immediately (held) and refunded if rejected. Dummy dollars can never be withdrawn. */
async function createWithdrawal(userId, { amount, method, destination, note }) {
  const u = await User.findById(userId).select('accountStatus');
  if (!u) throw new HttpError(404, 'User not found');
  if (u.accountStatus === 'Banned') throw new HttpError(403, 'Account is banned');
  const t = await Transaction.create({ kind: 'withdrawal', userId, amount, method, destination, note, status: 'Pending' });
  try { await ledger.post({ userId, amount: -amount, type: 'withdrawal', refId: t.id, note: 'Withdrawal requested (held)' }); }
  catch (e) { await Transaction.deleteOne({ _id: t.id }); throw e; }
  realtime.emit('withdrawal:new', t.toJSON());
  return t;
}

/** Approve / reject a pending deposit or withdrawal (atomic claim => no double processing). */
async function review(kind, id, status, { note, adminName }) {
  const t = await Transaction.findOneAndUpdate({ _id: id, kind, status: 'Pending' }, { status, note, processedBy: adminName, processedAt: new Date() }, { new: true });
  if (!t) {
    const ex = await Transaction.exists({ _id: id, kind });
    throw new HttpError(ex ? 409 : 404, ex ? 'Already processed' : `${kind} not found`);
  }
  if (kind === 'deposit' && status === 'Successful') {
    await ledger.post({ userId: t.userId, amount: t.amount, type: 'deposit', refId: t.id, createdBy: adminName });
    await adjustTeamDeposit(t.userId, t.amount); // §2.3 feeds the uplines' Total Team Deposit
  }
  if (kind === 'withdrawal' && status === 'Rejected') {
    await ledger.post({ userId: t.userId, amount: t.amount, type: 'withdrawal_refund', refId: t.id, createdBy: adminName, note: 'Withdrawal rejected — refunded' });
  }
  return t;
}

/**
 * §8.12 Edit any transaction. If money is currently "in effect" the balance (and team deposit) is corrected by the
 * difference, so histories and balances stay consistent. Status changes go through review().
 */
async function edit(id, patch, adminName) {
  const t = await Transaction.findById(id);
  if (!t) throw new HttpError(404, 'Transaction not found');
  const oldAmount = t.amount;
  const { amount, method, txId, destination, note, createdAt } = patch;
  if (amount !== undefined && amount !== oldAmount) {
    const delta = amount - oldAmount;
    if (t.kind === 'deposit' && t.status === 'Successful') {
      await ledger.post({ userId: t.userId, amount: delta, type: 'tx_edit', refId: t.id, createdBy: adminName, note: `Deposit edited ${oldAmount} -> ${amount}` });
      await adjustTeamDeposit(t.userId, delta);
    } else if (t.kind === 'withdrawal' && t.status !== 'Rejected') {
      await ledger.post({ userId: t.userId, amount: -delta, type: 'tx_edit', refId: t.id, createdBy: adminName, note: `Withdrawal edited ${oldAmount} -> ${amount}` });
    }
    t.amount = amount;
  }
  if (method !== undefined) t.method = method;
  if (txId !== undefined) t.txId = txId;
  if (destination !== undefined) t.destination = destination;
  if (note !== undefined) t.note = note;
  await t.save();
  if (createdAt !== undefined) { // createdAt is immutable in Mongoose; admin edits of the date are explicit
    await Transaction.updateOne({ _id: t.id }, { $set: { createdAt } }, { timestamps: false, overwriteImmutable: true });
    t.createdAt = createdAt;
  }
  return t;
}
module.exports = { createDeposit, createWithdrawal, review, edit };
