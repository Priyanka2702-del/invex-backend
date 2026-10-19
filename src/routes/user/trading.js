const router = require('express').Router();
const { z } = require('zod');
const { Order, Position } = require('../../models');
const asyncHandler = require('../../utils/asyncHandler');
const HttpError = require('../../utils/httpError');
const { page } = require('../../utils/pagination');
const { paged } = require('../../utils/serialize');
const trading = require('../../services/trading');
const alpaca = require('../../services/alpaca');

// mounted inside /api/me (userAuth already applied)
const orderBody = z.object({
  symbol: z.string().min(1).max(10), side: z.enum(['buy', 'sell']), type: z.enum(['market', 'limit']).default('market'),
  qty: z.number().positive().max(1_000_000), limitPrice: z.number().positive().optional(), timeInForce: z.enum(['day', 'gtc']).default('day'),
}).refine((o) => o.type !== 'limit' || o.limitPrice, { message: 'limitPrice is required for limit orders', path: ['limitPrice'] });

router.post('/orders', asyncHandler(async (req, res) => res.status(201).json(await trading.place(req.user.id, orderBody.parse(req.body)))));
router.get('/orders', asyncHandler(async (req, res) => {
  const p = page(req.query), q = { userId: req.user.id };
  if (req.query.status === 'open') q.finalized = false; else if (req.query.status === 'closed') q.finalized = true;
  if (req.query.symbol) q.symbol = alpaca.cleanSymbol(req.query.symbol);
  const [rows, total] = await Promise.all([Order.find(q).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit), Order.countDocuments(q)]);
  res.json(paged(rows, total, p));
}));
router.get('/orders/:id', asyncHandler(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, userId: req.user.id });
  if (!o) throw new HttpError(404, 'Order not found');
  res.json(o);
}));
router.delete('/orders/:id', asyncHandler(async (req, res) => res.json(await trading.cancel(req.params.id, { userId: req.user.id }))));

// open positions with the latest price and unrealised P&L (prices are best-effort: positions still load if the provider is down)
router.get('/positions', asyncHandler(async (req, res) => {
  const pos = (await Position.find({ userId: req.user.id, qty: { $gt: 1e-9 } }).sort({ symbol: 1 })).map((p) => p.toJSON());
  let prices = {};
  if (pos.length && alpaca.configured()) {
    try { const d = await alpaca.latestTrades(pos.map((p) => p.symbol)); for (const [s, t] of Object.entries(d.trades || {})) prices[s] = Number(t.p); } catch { /* ignore */ }
  }
  res.json(pos.map((p) => {
    const last = prices[p.symbol] ?? null;
    return { ...p, availableQty: Math.round((p.qty - p.reservedQty) * 1e6) / 1e6, lastPrice: last, marketValue: last == null ? null : Math.round(last * p.qty * 100) / 100, unrealizedPL: last == null ? null : Math.round((last - p.avgPrice) * p.qty * 100) / 100 };
  }));
}));
module.exports = router;
