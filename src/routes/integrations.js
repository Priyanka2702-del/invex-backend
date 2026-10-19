const router = require('express').Router();
const { z } = require('zod');
const { Trade, User } = require('../models');
const { mt5Key } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const HttpError = require('../utils/httpError');
const { processClosedTrade } = require('../services/commission');
const realtime = require('../services/realtime');

router.use(mt5Key);
const num = z.number().finite();
const tradeSchema = z.object({
  ticket: z.number().int().positive(), login: z.string().min(1), symbol: z.string().min(1), side: z.enum(['BUY', 'SELL']),
  volume: num.positive(), openPrice: num, closePrice: num.nullable().optional(), openTime: z.coerce.date(), closeTime: z.coerce.date().nullable().optional(),
  profit: num.default(0), commission: num.default(0), swap: num.default(0), sl: num.nullable().optional(), tp: num.nullable().optional(),
  status: z.enum(['Open', 'Closed']),
});

/** MT5 bridge pushes trades here (open, update, close). Closing triggers rebate + revenue commissions exactly once. */
router.post('/mt5/trades', asyncHandler(async (req, res) => {
  const list = z.array(tradeSchema).min(1).max(500).parse(Array.isArray(req.body) ? req.body : [req.body]);
  const out = [];
  for (const t of list) {
    const user = await User.findOne({ mt5Login: t.login }).select('_id');
    if (!user) { out.push({ ticket: t.ticket, error: 'unknown MT5 login' }); continue; }
    const { login, ...fields } = t;
    const existing = await Trade.findOne({ ticket: t.ticket });
    if (existing?.commissionsProcessedAt) { out.push({ ticket: t.ticket, skipped: 'already settled' }); continue; } // closed trades are final
    const trade = existing ? Object.assign(existing, fields) : new Trade({ ...fields, userId: user.id, accountId: login });
    if (existing && existing.userId !== user.id) { out.push({ ticket: t.ticket, error: 'ticket belongs to another account' }); continue; }
    await trade.save();
    const r = trade.status === 'Closed' ? await processClosedTrade(trade.id) : null;
    out.push({ ticket: t.ticket, id: trade.id, commissions: r });
  }
  realtime.emit('trades:synced', { count: out.length });
  res.json({ results: out });
}));

/** MT5 bridge pushes current equity for accounts (used by the Level-2 equity bonus). */
router.post('/mt5/equity', asyncHandler(async (req, res) => {
  const list = z.array(z.object({ login: z.string().min(1), equity: num.min(0) })).min(1).max(5000).parse(Array.isArray(req.body) ? req.body : [req.body]);
  const r = await User.bulkWrite(list.map((e) => ({ updateOne: { filter: { mt5Login: e.login }, update: { $set: { mt5Equity: e.equity } } } })));
  res.json({ matched: r.matchedCount, requested: list.length });
}));
module.exports = router;
