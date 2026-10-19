const { Order, Position, Trade, User, nextTicket } = require('../models');
const { genId } = require('../utils/ids');
const HttpError = require('../utils/httpError');
const { round2 } = require('../utils/money');
const alpaca = require('./alpaca');
const ledger = require('./ledger');
const settings = require('./settings');
const realtime = require('./realtime');
const { processClosedTrade } = require('./commission');

const TERMINAL = new Set(['filled', 'canceled', 'expired', 'rejected', 'replaced']);
const CAN_TRADE = new Set(['Active', 'Approved', 'Warned']); // Pending and Banned accounts cannot trade
const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;
const EPS = 1e-9;

/* ------------------------------------------------------------------ placing orders */
async function reserveShares(userId, symbol, qty) {
  for (let i = 0; i < 5; i++) {
    const pos = await Position.findOne({ userId, symbol });
    const avail = pos ? round(pos.qty - pos.reservedQty) : 0;
    if (avail < qty - EPS) throw new HttpError(409, `Insufficient ${symbol} shares (available: ${avail})`);
    // compare-and-set so two simultaneous sells can't reserve the same shares
    if (await Position.findOneAndUpdate({ _id: pos.id, qty: pos.qty, reservedQty: pos.reservedQty }, { $inc: { reservedQty: qty } })) return;
  }
  throw new HttpError(409, 'Position is busy, please retry');
}

/**
 * Buy: cash is reserved from the wallet first (market buys keep a small buffer for price movement), the unused part
 * is refunded when the order ends. Sell: shares are reserved in the position. Short selling is not allowed.
 * The order id is sent to Alpaca as client_order_id, so a retry can never create a second order.
 */
async function place(userId, input) {
  alpaca.ensureReady();
  const s = await settings.get('trading');
  if (!s.enabled) throw new HttpError(503, 'Trading is currently disabled');
  const user = await User.findById(userId);
  if (!user) throw new HttpError(404, 'User not found');
  if (!CAN_TRADE.has(user.accountStatus)) throw new HttpError(403, `Trading is not available for ${user.accountStatus} accounts`);

  const symbol = alpaca.cleanSymbol(input.symbol);
  const asset = await alpaca.asset(symbol);
  const cls = asset.class || asset.asset_class;
  if (asset.status !== 'active' || !asset.tradable) throw new HttpError(422, `${symbol} is not tradable`);
  if (cls && cls !== 'us_equity') throw new HttpError(422, 'Only US stocks can be traded here');
  const qty = round(input.qty);
  if (!(qty > 0)) throw new HttpError(400, 'qty must be positive');
  if (asset.fractionable === false && !Number.isInteger(qty)) throw new HttpError(422, `${symbol} can only be traded in whole shares`);

  const limit = input.type === 'limit' ? input.limitPrice : null;
  const ref = limit ?? (await alpaca.lastPrice(symbol)).price;
  if (qty * ref > s.maxOrderValue) throw new HttpError(400, `Order value exceeds the per-order limit of ${s.maxOrderValue}`);

  const order = new Order({ userId, symbol, side: input.side, type: input.type, timeInForce: input.timeInForce, qty, limitPrice: limit });
  if (order.side === 'buy') {
    order.reservedAmount = round2(qty * ref * (order.type === 'market' ? 1 + s.buyReserveBufferPct / 100 : 1));
    await ledger.post({ userId, amount: -order.reservedAmount, type: 'order_reserve', refId: order.id, note: `Reserved for buy ${qty} ${symbol}` }); // 409 if not enough cash
  } else {
    await reserveShares(userId, symbol, qty);
    order.reservedQty = qty;
  }
  try { await order.save(); } catch (e) { await releaseHold(order, 0, 0); throw e; }

  let resp;
  try {
    resp = await alpaca.submitOrder({
      symbol, qty: String(qty), side: order.side, type: order.type, time_in_force: order.timeInForce,
      ...(limit && { limit_price: String(limit) }), client_order_id: order.id,
    });
  } catch (e) {
    if (e.details?.upstream?.definite) { await applyUpdate(order.id, { status: 'rejected', filled_qty: '0', message: e.message }); throw e; } // provider said no => undo holds
    await Order.updateOne({ _id: order.id }, { status: 'submitting', statusMessage: 'Awaiting confirmation from the provider' });
    throw new HttpError(502, 'The order could not be confirmed with the market provider. It will be reconciled automatically; check your orders shortly.', { orderId: order.id });
  }
  const fresh = await applyUpdate(order.id, resp);
  realtime.emit('order:new', fresh.toJSON());
  return fresh;
}

/* ------------------------------------------------------------------ applying provider updates (exactly once) */
async function addToPosition(userId, symbol, dQty, dValue) {
  try { await Position.updateOne({ userId, symbol }, { $setOnInsert: { _id: genId('POS'), qty: 0, reservedQty: 0, avgPrice: 0 } }, { upsert: true }); } catch (e) { if (e.code !== 11000) throw e; }
  for (let i = 0; i < 8; i++) {
    const p = await Position.findOne({ userId, symbol });
    const newQty = round(p.qty + dQty);
    const set = { qty: newQty, avgPrice: newQty > 0 ? round((p.qty * p.avgPrice + dValue) / newQty) : 0 }; // weighted average cost
    if (p.qty <= EPS) set.openedAt = new Date();
    if (await Position.findOneAndUpdate({ _id: p.id, qty: p.qty }, { $set: set })) return;
  }
  throw new Error('position update contention');
}

async function applySellFill(o, dQty, dValue, cashDelta, lotSize) {
  const pos = await Position.findOne({ userId: o.userId, symbol: o.symbol });
  const avg = pos?.avgPrice || 0;
  await Position.updateOne({ userId: o.userId, symbol: o.symbol }, { $inc: { qty: -dQty, reservedQty: -dQty } });
  const fillPrice = dValue / dQty;
  await ledger.post({ userId: o.userId, amount: cashDelta, type: 'sell_proceeds', refId: o.id, note: `Sold ${dQty} ${o.symbol} @ ${fillPrice.toFixed(4)}` });
  // a sell closes (part of) a long position => one Closed trade, which drives rebates / revenue-link / ranks
  const trade = await Trade.create({
    ticket: await nextTicket(), userId: o.userId, accountId: 'alpaca', symbol: o.symbol, side: 'BUY',
    volume: round(dQty / lotSize), openPrice: avg, closePrice: round(fillPrice), openTime: pos?.openedAt || o.createdAt, closeTime: new Date(),
    profit: round2((fillPrice - avg) * dQty), status: 'Closed',
  });
  await processClosedTrade(trade.id);
}

/** Give back whatever the order still holds (unused cash / unsold shares) once it has ended. */
async function releaseHold(o, filledQty, value) {
  if (o.side === 'buy') {
    const refund = round2(o.reservedAmount - round2(value));
    if (refund > 0) await ledger.post({ userId: o.userId, amount: refund, type: 'order_release', refId: o.id, note: `Unused reserve for buy ${o.symbol}` });
    else if (refund < 0) await ledger.post({ userId: o.userId, amount: refund, type: 'order_adjust', refId: o.id, allowNegative: true, note: 'Fill cost above reserved amount' });
  } else {
    const remaining = round(o.reservedQty - filledQty);
    if (remaining > EPS) await Position.updateOne({ userId: o.userId, symbol: o.symbol }, { $inc: { reservedQty: -remaining } });
  }
}

/**
 * Book the new part of a fill and, when the order has ended, release the hold.
 * Safe to call from the request, the sync job and the admin at once: a compare-and-set on appliedQty means only one
 * caller books each increment. (No multi-document transactions: a crash right after the claim needs the ledger to reconcile.)
 */
async function applyUpdate(id, alp) {
  const o = await Order.findById(id);
  if (!o || o.finalized) return o;
  const status = String(alp.status || o.status);
  const terminal = TERMINAL.has(status);
  const filledQty = round(Number(alp.filled_qty ?? o.appliedQty));
  if (filledQty < o.appliedQty - EPS) return o; // stale snapshot
  const avg = alp.filled_avg_price != null ? Number(alp.filled_avg_price) : o.filledAvgPrice;
  const value = filledQty > 0 ? round((avg || 0) * filledQty, 4) : 0;
  const dQty = round(filledQty - o.appliedQty);

  const set = { status, filledQty, filledAvgPrice: avg ?? null };
  if (alp.message) set.statusMessage = String(alp.message).slice(0, 300);
  if (alp.id) { set.alpacaOrderId = alp.id; if (!o.submittedAt) set.submittedAt = new Date(); }
  if (dQty <= EPS && !terminal) { await Order.updateOne({ _id: id, finalized: false }, { $set: set }); return Order.findById(id); }

  Object.assign(set, { appliedQty: filledQty, appliedValue: value });
  if (terminal) Object.assign(set, { finalized: true, finalizedAt: new Date() });
  const won = await Order.findOneAndUpdate({ _id: id, appliedQty: o.appliedQty, finalized: false }, { $set: set });
  if (!won) return Order.findById(id); // someone else booked it

  try {
    if (dQty > EPS) {
      const dValue = value - o.appliedValue;
      if (o.side === 'buy') await addToPosition(o.userId, o.symbol, dQty, dValue);
      else await applySellFill(o, dQty, dValue, round2(value) - round2(o.appliedValue), (await settings.get('trading')).lotSize);
    }
    if (terminal) await releaseHold(o, filledQty, value);
  } catch (e) { console.error(`[trading] CRITICAL: booking failed after claiming order ${id}`, e); throw e; }
  const fresh = await Order.findById(id);
  realtime.emit('order:updated', fresh.toJSON());
  return fresh;
}

/* ------------------------------------------------------------------ cancel & reconcile */
async function resolveProviderOrder(o) {
  if (o.alpacaOrderId) return alpaca.getOrder(o.alpacaOrderId);
  return alpaca.getOrderByClientId(o.id); // submission response was lost: find it by our id
}

async function cancel(orderId, { userId } = {}) {
  const o = await Order.findOne({ _id: orderId, ...(userId && { userId }) });
  if (!o) throw new HttpError(404, 'Order not found');
  if (o.finalized) throw new HttpError(409, 'Order is already closed');
  let alp;
  try { alp = await resolveProviderOrder(o); }
  catch (e) {
    if (e.status === 404 && Date.now() - o.createdAt > 120_000) return applyUpdate(o.id, { status: 'canceled', filled_qty: String(o.appliedQty), message: 'Order never reached the provider' });
    throw e.status === 404 ? new HttpError(409, 'Order is still being confirmed, try again in a moment') : e;
  }
  if (!TERMINAL.has(alp.status)) {
    try { await alpaca.cancelOrder(alp.id); } catch (e) { if (e.status !== 422 && e.status !== 404) throw e; } // 422: already filled/closed — the refresh below shows the truth
    alp = await alpaca.getOrder(alp.id);
  }
  return applyUpdate(o.id, alp);
}

/** Poll the provider for every order that has not ended (the Trading API guide's GET /v2/orders/{id} + by_client_order_id). */
async function sync({ limit = 200 } = {}) {
  if (!alpaca.configured()) return { skipped: 'not configured' };
  const open = await Order.find({ finalized: false }).sort({ createdAt: 1 }).limit(limit);
  let updated = 0, errors = 0;
  for (const o of open) {
    try {
      let alp;
      try { alp = await resolveProviderOrder(o); }
      catch (e) {
        if (e.status === 404 && !o.alpacaOrderId && Date.now() - o.createdAt > 120_000) alp = { status: 'rejected', filled_qty: '0', message: 'Order never reached the provider' };
        else throw e;
      }
      await applyUpdate(o.id, alp); updated++;
    } catch (e) { errors++; if (e.status === 503) break; /* rate limited: stop this round */ }
  }
  return { checked: open.length, updated, errors };
}

module.exports = { place, cancel, sync, applyUpdate, TERMINAL };
