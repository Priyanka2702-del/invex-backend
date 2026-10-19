const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { userAuth } = require('../../middleware/auth');
const asyncHandler = require('../../utils/asyncHandler');
const HttpError = require('../../utils/httpError');
const alpaca = require('../../services/alpaca');

/**
 * Market data proxy: the browser/app never sees Alpaca keys. Responses are Alpaca's own JSON (see their Market Data docs),
 * cached for ~2s server-side so many users share one upstream call.
 */
router.use(userAuth);
router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `u:${req.user.id}`, validate: false, message: { message: 'Too many market data requests' } }));

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const symbols = (v) => { const l = list(v); if (!l.length || l.length > 50) throw new HttpError(400, 'symbols must contain 1-50 comma-separated tickers'); return l; };

router.get('/quote/:symbol', asyncHandler(async (req, res) => res.json(await alpaca.latestQuote(req.params.symbol))));
router.get('/trade/:symbol', asyncHandler(async (req, res) => res.json(await alpaca.latestTrade(req.params.symbol))));
router.get('/bar/:symbol', asyncHandler(async (req, res) => res.json(await alpaca.latestBar(req.params.symbol))));
router.get('/snapshot/:symbol', asyncHandler(async (req, res) => res.json(await alpaca.snapshot(req.params.symbol))));
router.get('/snapshots', asyncHandler(async (req, res) => res.json(await alpaca.snapshots(symbols(req.query.symbols)))));
router.get('/price/:symbol', asyncHandler(async (req, res) => res.json({ symbol: alpaca.cleanSymbol(req.params.symbol), ...(await alpaca.lastPrice(req.params.symbol)) })));
router.get('/bars/:symbol', asyncHandler(async (req, res) => {
  const q = z.object({ timeframe: z.string().default('1Day'), start: z.coerce.date().optional(), end: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(1000).default(100), pageToken: z.string().max(200).optional() }).parse(req.query);
  res.json(await alpaca.bars(req.params.symbol, { ...q, start: q.start?.toISOString(), end: q.end?.toISOString() }));
}));
router.get('/news', asyncHandler(async (req, res) => res.json(await alpaca.news({ symbols: list(req.query.symbols), limit: Math.min(Number(req.query.limit) || 10, 50) }))));
router.get('/clock', asyncHandler(async (_req, res) => res.json(await alpaca.clock())));
router.get('/assets/:symbol', asyncHandler(async (req, res) => res.json(await alpaca.asset(req.params.symbol))));
module.exports = router;
