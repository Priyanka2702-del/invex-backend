const env = require('../config/env');
const HttpError = require('../utils/httpError');

/**
 * Thin Alpaca client for the Trading API (paper-api.alpaca.markets) and Market Data API (data.alpaca.markets).
 * Keys come from env and never leave the server. Responses are returned as Alpaca sends them.
 */
const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;
const TIMEFRAME = /^\d{1,3}(Min|Hour|Day|Week|Month)$/;
const cleanSymbol = (s) => {
  const u = String(s || '').trim().toUpperCase();
  if (!SYMBOL.test(u)) throw new HttpError(400, 'Invalid symbol'); // also keeps user input out of URL paths
  return u;
};
const cleanTimeframe = (t) => { if (!TIMEFRAME.test(String(t))) throw new HttpError(400, 'Invalid timeframe (e.g. 1Min, 5Min, 1Hour, 1Day)'); return String(t); };

const configured = () => !!(env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY);
function ensureReady() {
  if (!configured()) throw new HttpError(503, 'Market data / trading provider is not configured');
  // PDF safety checklist: never hit the real-money host by accident
  if (new URL(env.ALPACA_TRADING_URL).hostname === 'api.alpaca.markets' && env.ALPACA_ALLOW_LIVE !== 'true') {
    throw new HttpError(503, 'Live Alpaca trading is blocked. Use the paper URL, or set ALPACA_ALLOW_LIVE=true on purpose.');
  }
}

function mapError(status, data) {
  const msg = (data && (data.message || data.error)) || `HTTP ${status}`;
  const upstream = { status, definite: status < 500 }; // a 5xx may or may not have been processed
  if (status === 401) return new HttpError(502, 'Market provider rejected our API credentials', { upstream });
  if (status === 403) return new HttpError(403, `Market provider refused the request: ${msg}`, { upstream });
  if (status === 404) return new HttpError(404, `Not found at market provider: ${msg}`, { upstream });
  if (status === 422 || status === 400) return new HttpError(status, msg, { upstream });
  if (status === 429) return new HttpError(503, 'Market provider rate limit reached, retry shortly', { upstream });
  return new HttpError(502, `Market provider error (${status})`, { upstream });
}

async function call(kind, method, path, { query, body } = {}) {
  ensureReady();
  const base = kind === 'data' ? env.ALPACA_DATA_URL : env.ALPACA_TRADING_URL;
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'APCA-API-KEY-ID': env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET_KEY, ...(body && { 'content-type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(502, 'Market provider unreachable', { upstream: { definite: false } }); // outcome unknown
  }
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 200) }; } }
  if (!res.ok) throw mapError(res.status, data);
  return data;
}

/* short-lived cache + in-flight de-duplication so many users can't exhaust Alpaca's rate limit */
const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.p;
  if (cache.size > 2000) for (const [k, v] of cache) if (v.exp <= Date.now()) cache.delete(k);
  const p = fn();
  cache.set(key, { p, exp: Date.now() + ttlMs });
  p.catch(() => cache.delete(key)); // never cache failures
  return p;
}
const clearCache = () => cache.clear();

const feed = () => env.ALPACA_FEED;
/* ---- market data ---- */
const latestQuote = (s) => { s = cleanSymbol(s); return cached(`q:${s}`, 2000, () => call('data', 'GET', `/v2/stocks/${s}/quotes/latest`, { query: { feed: feed() } })); };
const latestTrade = (s) => { s = cleanSymbol(s); return cached(`t:${s}`, 2000, () => call('data', 'GET', `/v2/stocks/${s}/trades/latest`, { query: { feed: feed() } })); };
const latestBar = (s) => { s = cleanSymbol(s); return cached(`lb:${s}`, 2000, () => call('data', 'GET', `/v2/stocks/${s}/bars/latest`, { query: { feed: feed() } })); };
const snapshot = (s) => { s = cleanSymbol(s); return cached(`s:${s}`, 2000, () => call('data', 'GET', `/v2/stocks/${s}/snapshot`, { query: { feed: feed() } })); };
const snapshots = (list) => { const l = [...new Set(list.map(cleanSymbol))].sort().join(','); return cached(`ss:${l}`, 2000, () => call('data', 'GET', '/v2/stocks/snapshots', { query: { symbols: l, feed: feed() } })); };
const latestTrades = (list) => { const l = [...new Set(list.map(cleanSymbol))].sort().join(','); return cached(`lts:${l}`, 2000, () => call('data', 'GET', '/v2/stocks/trades/latest', { query: { symbols: l, feed: feed() } })); };
function bars(s, { timeframe = '1Day', start, end, limit = 100, pageToken } = {}) {
  s = cleanSymbol(s); timeframe = cleanTimeframe(timeframe);
  const q = { timeframe, start, end, limit, page_token: pageToken, feed: feed() };
  return cached(`b:${s}:${JSON.stringify(q)}`, 15_000, () => call('data', 'GET', `/v2/stocks/${s}/bars`, { query: q }));
}
const news = ({ symbols, limit = 10 } = {}) => {
  const l = symbols && symbols.length ? [...new Set(symbols.map(cleanSymbol))].sort().join(',') : undefined;
  return cached(`n:${l}:${limit}`, 30_000, () => call('data', 'GET', '/v1beta1/news', { query: { symbols: l, limit } }));
};

/** Best price to estimate an order with: ask, else bid, else last trade. */
async function lastPrice(symbol) {
  try {
    const d = await latestQuote(symbol), q = d.quote || d;
    const p = Number(q.ap) || Number(q.bp);
    if (p > 0) return { price: p, source: 'quote' };
  } catch (e) { if (e.status === 400) throw e; /* otherwise fall back to the last trade */ }
  const d = await latestTrade(symbol), t = d.trade || d;
  const p = Number(t.p);
  if (!(p > 0)) throw new HttpError(503, `No price available for ${cleanSymbol(symbol)} right now`);
  return { price: p, source: 'trade' };
}

/* ---- trading ---- */
const account = () => cached('account', 3000, () => call('trading', 'GET', '/v2/account'));
const clock = () => cached('clock', 15_000, () => call('trading', 'GET', '/v2/clock'));
const calendar = ({ start, end } = {}) => cached(`cal:${start}:${end}`, 3_600_000, () => call('trading', 'GET', '/v2/calendar', { query: { start, end } }));
const asset = (s) => { s = cleanSymbol(s); return cached(`a:${s}`, 300_000, () => call('trading', 'GET', `/v2/assets/${s}`)); };
const submitOrder = (body) => call('trading', 'POST', '/v2/orders', { body });
const getOrder = (id) => call('trading', 'GET', `/v2/orders/${encodeURIComponent(id)}`);
const getOrderByClientId = (cid) => call('trading', 'GET', '/v2/orders:by_client_order_id', { query: { client_order_id: cid } });
const cancelOrder = (id) => call('trading', 'DELETE', `/v2/orders/${encodeURIComponent(id)}`);
const listOrders = (query) => call('trading', 'GET', '/v2/orders', { query });

module.exports = {
  configured, ensureReady, cleanSymbol, clearCache,
  latestQuote, latestTrade, latestBar, snapshot, snapshots, latestTrades, bars, news, lastPrice,
  account, clock, calendar, asset, submitOrder, getOrder, getOrderByClientId, cancelOrder, listOrders,
};
