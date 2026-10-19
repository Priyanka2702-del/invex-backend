const mongoose = require('mongoose');
const jsonPlugin = require('./plugins');
const { genId } = require('../utils/ids');
const C = require('../constants');

const { Schema } = mongoose;
const money = { type: Number, default: 0 };
const idField = (prefix) => ({ type: String, default: () => genId(prefix) });
const make = (name, schema, opts) => {
  schema.plugin(jsonPlugin, opts);
  return mongoose.models[name] || mongoose.model(name, schema);
};

/* ---- counter: sequential numeric user ids starting at 10000 (matches the admin UI) ---- */
const Counter = make('Counter', new Schema({ _id: String, seq: { type: Number, default: 0 } }));
async function nextUserId() {
  const c = await Counter.findOneAndUpdate({ _id: 'user' }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return String(9999 + c.seq);
}

/* ---- admins ---- */
const Admin = make('Admin', new Schema({
  _id: idField('ADM'),
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['superadmin', 'admin', 'support'], default: 'admin' },
  isSuperAdmin: { type: Boolean, default: false },
}, { timestamps: true }), { hide: ['passwordHash'] });

/* ---- system ranks (§2) ---- */
const SystemRank = make('SystemRank', new Schema({
  _id: idField('RANK'),
  name: { type: String, required: true, unique: true },
  minTeamDeposit: { type: Number, required: true },
  position: { type: Number, required: true },
  description: { type: String, default: '' },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
}, { timestamps: true }));

/* ---- users ---- */
const userSchema = new Schema({
  _id: { type: String },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, default: '' },
  country: { type: String, default: '' },
  passwordHash: { type: String, required: true },
  emailVerified: { type: Boolean, default: false },
  phoneVerified: { type: Boolean, default: false },
  kycStatus: { type: String, enum: C.KYC_STATUSES, default: 'Unverified' },
  kycDetails: { type: Schema.Types.Mixed, default: {} },
  accountStatus: { type: String, enum: C.ACCOUNT_STATUSES, default: 'Active' },
  warningCount: { type: Number, default: 0 },

  /* network. `ancestors` = [direct upline, upline's upline, ...] (materialised path). Level N of X = users with ancestors[N-1] == X */
  uplineId: { type: String, ref: 'User', default: null },
  ancestors: { type: [String], default: [] }, // hidden from JSON; small (one id per level)
  registrationType: { type: String, enum: C.REGISTRATION_TYPES, default: 'Direct' },
  referralSource: { type: String, default: 'Direct' },
  referralCode: { type: String, unique: true, sparse: true },   // Rebate Link
  revenueCode: { type: String, unique: true, sparse: true },    // Revenue Link (only after approval, §8.11)
  revenueLink: { type: String, enum: ['None', 'Pending', 'Approved', 'Rejected'], default: 'None' },
  isIb: { type: Boolean, default: false },
  ibRank: { type: String, enum: C.IB_RANKS, default: 'Basic' },
  customIb: { type: { rebate: [Number], revenue: [Number] }, default: undefined, _id: false }, // §8.7 per-level overrides (null = use default)

  /* system rank (§2/§3.1/§8.9) */
  systemRankId: { type: String, ref: 'SystemRank', default: null },
  systemRankSource: { type: String, enum: ['auto', 'manual', null], default: null },
  teamDeposit: money, // denormalised Total Team Deposit (whole downline, excludes own)

  /* money */
  walletBalance: money,  // "Index Wallet"
  dummyBalance: money,   // marketing-only (§8.10) — never withdrawable
  mt5Login: { type: String, default: null },
  mt5Equity: money,      // cached from MT5
  accountType: { type: String, enum: C.ACCOUNT_TYPES, default: 'standard' },

  marketing: { type: { assignedAt: Date, approvedBy: String }, default: undefined, _id: false },
}, { timestamps: true });
userSchema.index({ uplineId: 1 });
userSchema.index({ ancestors: 1 });
userSchema.index({ 'ancestors.1': 1 });
userSchema.index({ systemRankId: 1 });
const User = make('User', userSchema, { hide: ['passwordHash', 'ancestors'] });

/* ---- deposits & withdrawals ---- */
const Transaction = make('Transaction', new Schema({
  _id: { type: String, default: function () { return genId(this.kind === 'withdrawal' ? 'WDR' : 'DEP'); } },
  kind: { type: String, enum: ['deposit', 'withdrawal'], required: true },
  userId: { type: String, ref: 'User', required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  method: { type: String, default: '' },
  txId: { type: String, default: '' },
  destination: { type: String, default: null },
  status: { type: String, enum: ['Successful', 'Pending', 'Rejected'], default: 'Pending' },
  note: String,
  processedBy: String,
  processedAt: Date,
}, { timestamps: true }));
Transaction.schema.index({ kind: 1, status: 1, createdAt: -1 });

/* ---- trades (mirrored from MT5) ---- */
const Trade = make('Trade', new Schema({
  _id: idField('TRD'),
  ticket: { type: Number, required: true, unique: true },
  userId: { type: String, ref: 'User', required: true, index: true },
  accountId: { type: String, default: '' },
  symbol: { type: String, required: true },
  side: { type: String, enum: ['BUY', 'SELL'], required: true },
  volume: { type: Number, required: true },
  openPrice: { type: Number, required: true },
  closePrice: { type: Number, default: null },
  openTime: { type: Date, required: true },
  closeTime: { type: Date, default: null },
  profit: money, commission: money, swap: money,
  sl: { type: Number, default: null }, tp: { type: Number, default: null },
  status: { type: String, enum: ['Open', 'Closed'], default: 'Open' },
  commissionsProcessedAt: { type: Date, default: null }, // idempotency guard for rebate + revenue
}));
Trade.schema.index({ closeTime: -1 });

/* ---- commissions ---- */
const rebateSchema = new Schema({
  _id: idField('RBT'),
  tradeId: { type: String, ref: 'Trade', required: true },
  level: { type: Number, required: true },
  ibUserId: { type: String, ref: 'User', required: true, index: true },
  traderId: { type: String, ref: 'User', required: true },
  volume: Number, rate: Number, amount: Number,
  status: { type: String, enum: ['Distributed', 'Pending', 'On Hold'], default: 'Distributed' },
}, { timestamps: true });
rebateSchema.index({ tradeId: 1, level: 1 }, { unique: true });
rebateSchema.index({ createdAt: -1 });
const RebateCommission = make('RebateCommission', rebateSchema);

const revenueSchema = new Schema({
  _id: idField('RVL'),
  tradeId: { type: String, ref: 'Trade', required: true },
  level: { type: Number, required: true },
  uplineId: { type: String, ref: 'User', required: true, index: true },
  traderId: { type: String, ref: 'User', required: true },
  uplineRank: String,
  rate: Number, pl: Number, amount: Number,
  accountPlus: money,   // loss   -> credited to upline
  accountMinus: money,  // profit -> deducted from upline, paid to the user
  status: { type: String, enum: ['Settled', 'On Hold'], default: 'Settled' },
}, { timestamps: true });
revenueSchema.index({ tradeId: 1, level: 1 }, { unique: true });
revenueSchema.index({ createdAt: -1 });
const RevenueCommission = make('RevenueCommission', revenueSchema);

/* ---- money ledger (append-only audit trail of every balance change) ---- */
const LedgerEntry = make('LedgerEntry', new Schema({
  _id: idField('LED'),
  userId: { type: String, ref: 'User', required: true },
  account: { type: String, enum: ['wallet', 'equity', 'dummy'], required: true },
  amount: { type: Number, required: true }, // signed
  balanceAfter: Number,
  type: { type: String, required: true }, // deposit | withdrawal | admin_add | admin_minus | rebate | revenue_plus | revenue_minus | equity_bonus | copy_* | pam_* | marketing_grant
  refId: String, note: String, createdBy: String,
}, { timestamps: { createdAt: true, updatedAt: false } }));
LedgerEntry.schema.index({ userId: 1, createdAt: -1 });

/* ---- equity bonus (§3) ---- */
const eqSchema = new Schema({
  _id: idField('EQM'),
  ibUserId: { type: String, ref: 'User', required: true },
  month: { type: String, required: true }, // YYYY-MM
  requiredEquity: money,            // tier floor the IB had to hold (tier at first check of the month)
  minEquity: { type: Number, default: null }, // lowest L2 equity seen = "maintained"
  failures: [{ _id: false, day: String, equity: Number, required: Number }],
  failureCount: { type: Number, default: 0 },
  status: { type: String, default: 'Qualified' }, // Qualified | Warning | Forfeited | Not qualified
  pct: money, maintainedEquity: money, bonus: money,
  finalized: { type: Boolean, default: false },
  paid: { type: Boolean, default: false },
  paidAt: Date,
}, { timestamps: true });
eqSchema.index({ ibUserId: 1, month: 1 }, { unique: true });
const EquityMonth = make('EquityMonth', eqSchema);

/* ---- copy trading (§4) & PAM (§5) ledgers ---- */
const CopyTransaction = make('CopyTransaction', new Schema({
  _id: idField('CPY'),
  userId: { type: String, ref: 'User', required: true },
  type: { type: String, enum: ['invest', 'withdraw', 'profit', 'profit_cut'], required: true },
  amount: { type: Number, required: true }, note: String,
}, { timestamps: { createdAt: true, updatedAt: false } }));
CopyTransaction.schema.index({ userId: 1, createdAt: -1 });

const PamTransaction = make('PamTransaction', new Schema({
  _id: idField('PAM'),
  userId: { type: String, ref: 'User', required: true },
  type: { type: String, enum: ['deposit', 'withdraw', 'return', 'profit_share'], required: true },
  amount: { type: Number, required: true }, note: String,
}, { timestamps: { createdAt: true, updatedAt: false } }));
PamTransaction.schema.index({ userId: 1, createdAt: -1 });

/* ---- settings & account types ---- */
const Setting = make('Setting', new Schema({ _id: String, value: Schema.Types.Mixed, updatedBy: String }, { timestamps: true }));
const AccountType = make('AccountType', new Schema({
  _id: { type: String, enum: C.ACCOUNT_TYPES }, // standard | zero | ecn | cent
  label: String,
  separatePerLot: { type: Number, default: 0, min: 0 },
  leverage: { type: String, enum: C.LEVERAGES, default: '1:100' }, // e.g. '1:500' (same format as the admin UI)
  updatedBy: String,
}, { timestamps: true }));

/* ---- templates & promotions (§9) ---- */
const MediaAsset = make('MediaAsset', new Schema({
  _id: idField('MED'),
  title: { type: String, required: true },
  kind: { type: String, enum: ['image', 'banner', 'graphic', 'other'], default: 'image' },
  url: { type: String, required: true },
  filename: String,
  text: { type: String, default: '' },
}, { timestamps: true }));
const Promotion = make('Promotion', new Schema({
  _id: idField('PRM'),
  title: { type: String, required: true },
  type: { type: String, enum: ['Bonus', 'Contest', 'Special Offer', 'Other'], default: 'Special Offer' },
  description: { type: String, default: '' },
  mediaId: { type: String, ref: 'MediaAsset', default: null },
  settings: { type: Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['Draft', 'Active', 'Paused', 'Ended'], default: 'Draft' },
  startsAt: Date, endsAt: Date,
}, { timestamps: true }));

/* ---- stock trading via Alpaca ---- */
const orderSchema = new Schema({
  _id: idField('ORD'), // also sent to Alpaca as client_order_id => retries can never create a duplicate order
  userId: { type: String, ref: 'User', required: true },
  symbol: { type: String, required: true },
  side: { type: String, enum: ['buy', 'sell'], required: true },
  type: { type: String, enum: ['market', 'limit'], default: 'market' },
  timeInForce: { type: String, enum: ['day', 'gtc'], default: 'day' },
  qty: { type: Number, required: true },
  limitPrice: { type: Number, default: null },
  alpacaOrderId: { type: String, index: { unique: true, sparse: true } },
  status: { type: String, default: 'pending_submit' }, // Alpaca status, or pending_submit / submitting (not yet confirmed)
  statusMessage: String,
  filledQty: { type: Number, default: 0 }, filledAvgPrice: { type: Number, default: null },
  appliedQty: { type: Number, default: 0 },   // part of the fill already booked to the user's cash/position
  appliedValue: { type: Number, default: 0 },
  reservedAmount: { type: Number, default: 0 }, // buy: cash held from the wallet
  reservedQty: { type: Number, default: 0 },    // sell: shares held in the position
  finalized: { type: Boolean, default: false }, finalizedAt: Date, submittedAt: Date,
}, { timestamps: true });
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ finalized: 1, createdAt: 1 });
const Order = make('Order', orderSchema);

const positionSchema = new Schema({
  _id: idField('POS'),
  userId: { type: String, ref: 'User', required: true },
  symbol: { type: String, required: true },
  qty: { type: Number, default: 0 }, reservedQty: { type: Number, default: 0 }, // reservedQty = shares locked by open sell orders
  avgPrice: { type: Number, default: 0 }, openedAt: Date,
}, { timestamps: true });
positionSchema.index({ userId: 1, symbol: 1 }, { unique: true });
const Position = make('Position', positionSchema);

/** Trade tickets for Alpaca trades live far above MT5 ticket numbers so they can never collide. */
async function nextTicket() {
  const c = await Counter.findOneAndUpdate({ _id: 'ticket' }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return 9_000_000_000_000 + c.seq;
}

/* ---- audit ---- */
const AuditLog = make('AuditLog', new Schema({
  _id: idField('AUD'),
  admin: { type: String, required: true },
  action: { type: String, required: true },
  module: { type: String, required: true },
  userId: String,
  description: { type: String, default: '' },
}, { timestamps: { createdAt: 'timestamp', updatedAt: false } }));
AuditLog.schema.index({ timestamp: -1 });

/** Builds every index from the final schemas (some are declared after model compilation). Call once at startup. */
const ensureIndexes = () => Promise.all(Object.values(mongoose.models).map((m) => m.createIndexes()));

module.exports = {
  ensureIndexes,
  Admin, SystemRank, User, Transaction, Trade, RebateCommission, RevenueCommission, LedgerEntry,
  EquityMonth, CopyTransaction, PamTransaction, Setting, AccountType, MediaAsset, Promotion, AuditLog,
  Order, Position, nextTicket, nextUserId,
};
