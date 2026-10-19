const { User, LedgerEntry } = require('../models');
const HttpError = require('../utils/httpError');
const { round2 } = require('../utils/money');

const FIELD = { wallet: 'walletBalance', equity: 'mt5Equity', dummy: 'dummyBalance' };
/**
 * The ONLY way balances change. Atomic $inc (with a >= guard on debits) + an append-only ledger row.
 * `allowNegative` is for revenue-link "Account Minus" deductions from an upline (§7.3).
 */
async function post({ userId, account = 'wallet', amount, type, refId, note, createdBy, allowNegative = false }) {
  amount = round2(amount);
  if (!amount) return null;
  const field = FIELD[account];
  const filter = { _id: userId };
  if (amount < 0 && !allowNegative) filter[field] = { $gte: -amount };
  const u = await User.findOneAndUpdate(filter, { $inc: { [field]: amount } }, { new: true });
  if (!u) {
    const exists = await User.exists({ _id: userId });
    throw new HttpError(exists ? 409 : 404, exists ? `Insufficient ${account} balance` : 'User not found');
  }
  return LedgerEntry.create({ userId, account, amount, balanceAfter: round2(u[field]), type, refId, note, createdBy });
}
module.exports = { post };
