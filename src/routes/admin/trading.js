const router = require('express').Router();
const { z } = require('zod');
const { Order, Position, User } = require('../../models');
const asyncHandler = require('../../utils/asyncHandler');
const { page } = require('../../utils/pagination');
const { paged, rangeFilter } = require('../../utils/serialize');
const trading = require('../../services/trading');
const alpaca = require('../../services/alpaca');
const settings = require('../../services/settings');
const audit = require('../../services/audit');
const env = require('../../config/env');

// provider connectivity: which environment we point at and the shared Alpaca account's status
router.get('/provider', asyncHandler(async (_req, res) => {
  const out = { configured: alpaca.configured(), tradingUrl: env.ALPACA_TRADING_URL, feed: env.ALPACA_FEED, live: new URL(env.ALPACA_TRADING_URL).hostname === 'api.alpaca.markets' };
  if (out.configured) {
    try { const a = await alpaca.account(); out.account = { status: a.status, cash: a.cash, equity: a.equity, buyingPower: a.buying_power }; out.clock = await alpaca.clock(); }
    catch (e) { out.error = e.message; }
  }
  res.json(out);
}));
// kill switch, shares-per-lot (rebates are $ per lot), per-order cap, market-buy cash buffer
router.get('/settings', asyncHandler(async (_req, res) => res.json(await settings.get('trading'))));
router.put('/settings', asyncHandler(async (req, res) => {
  const b = z.object({ enabled: z.boolean(), lotSize: z.number().positive().max(1e6), maxOrderValue: z.number().positive(), buyReserveBufferPct: z.number().min(0).max(50) }).partial().parse(req.body);
  const next = await settings.set('trading', { ...(await settings.get('trading')), ...b }, req.admin.name);
  audit(req.admin, 'Trading settings changed', 'Trading', JSON.stringify(b));
  res.json(next);
}));
router.get('/orders', asyncHandler(async (req, res) => {
  const p = page(req.query), q = { ...rangeFilter(req.query) };
  for (const k of ['userId', 'symbol', 'side', 'status']) if (req.query[k]) q[k] = req.query[k];
  if (req.query.open === 'true') q.finalized = false;
  const [rows, total] = await Promise.all([Order.find(q).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit), Order.countDocuments(q)]);
  const names = new Map((await User.find({ _id: { $in: rows.map((r) => r.userId) } }).select('name').lean()).map((u) => [u._id, u.name]));
  res.json(paged(rows.map((r) => ({ ...r.toJSON(), userName: names.get(r.userId) })), total, p));
}));
router.get('/positions', asyncHandler(async (req, res) => {
  const p = page(req.query), q = { qty: { $gt: 1e-9 } };
  if (req.query.userId) q.userId = req.query.userId; if (req.query.symbol) q.symbol = alpaca.cleanSymbol(req.query.symbol);
  const [rows, total] = await Promise.all([Position.find(q).sort({ updatedAt: -1 }).skip(p.skip).limit(p.limit), Position.countDocuments(q)]);
  res.json(paged(rows, total, p));
}));
router.post('/orders/:id/cancel', asyncHandler(async (req, res) => {
  const o = await trading.cancel(req.params.id);
  audit(req.admin, 'Order cancelled by admin', 'Trading', o.id, o.userId);
  res.json(o);
}));
router.post('/sync', asyncHandler(async (_req, res) => res.json(await trading.sync())));
module.exports = router;
