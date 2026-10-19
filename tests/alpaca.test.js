/** Alpaca integration tests: market data proxy, order lifecycle, accounting, safety guards (fake Alpaca + real MongoDB). */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-1234';
process.env.ENABLE_CRON = 'false';
process.env.ALPACA_SYNC_INTERVAL_MS = '0';
process.env.ALPACA_KEY_ID = 'test-key';
process.env.ALPACA_SECRET_KEY = 'test-secret';
const base = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017';
process.env.MONGODB_URI = `${base}/invex_alpaca_${Date.now()}`;

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { createFakeAlpaca } = require('./helpers/fakeAlpaca');

const fake = createFakeAlpaca();
let up = false, atomic = false, admin, support, A, B, tokB;
const S = {}; // shared ids between tests
const app = () => require('../src/app');
const M = () => require('../src/models');
const trading = () => require('../src/services/trading');
const alpaca = () => require('../src/services/alpaca');
const env = () => require('../src/config/env');
const call = (tok) => ({
  get: (u) => request(app()).get(u).set('Authorization', `Bearer ${tok}`),
  post: (u, b) => request(app()).post(u).set('Authorization', `Bearer ${tok}`).send(b),
  put: (u, b) => request(app()).put(u).set('Authorization', `Bearer ${tok}`).send(b),
  del: (u) => request(app()).delete(u).set('Authorization', `Bearer ${tok}`),
});
const wallet = async (id) => (await M().User.findById(id)).walletBalance;
const position = (id, symbol) => M().Position.findOne({ userId: id, symbol });
const buy = (symbol, qty, extra = {}) => call(tokB).post('/api/me/orders', { symbol, side: 'buy', qty, ...extra });
const sell = (symbol, qty, extra = {}) => call(tokB).post('/api/me/orders', { symbol, side: 'sell', qty, ...extra });

before(async () => {
  const url = await fake.listen();
  process.env.ALPACA_TRADING_URL = url; process.env.ALPACA_DATA_URL = url;
  try { await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 2500 }); up = true; } catch (e) { console.warn('[tests] MongoDB not reachable, skipping:', e.message); return; }
  await M().ensureIndexes();
  // The booking claim relies on MongoDB's single-document atomic findOneAndUpdate. Some emulators don't provide it, so probe first.
  const probe = mongoose.connection.collection('cas_probe'); let multi = 0;
  for (let i = 0; i < 8; i++) {
    await probe.deleteMany({}); await probe.insertOne({ _id: 'o', x: 0 });
    const res = await Promise.all(Array.from({ length: 6 }, () => probe.findOneAndUpdate({ _id: 'o', x: 0 }, { $set: { x: 1 } })));
    if (res.filter((r) => (r && r.value !== undefined ? r.value : r)).length > 1) multi++;
  }
  atomic = multi === 0;
  if (!atomic) console.warn('[tests] this database does NOT make findOneAndUpdate atomic (an emulator?): the concurrent-booking test is skipped. Run against real MongoDB to exercise it.');
  await M().Admin.create({ email: 'root@t.io', name: 'Root', role: 'superadmin', isSuperAdmin: true, passwordHash: await bcrypt.hash('rootpassword1', 4) });
  await M().Admin.create({ email: 'sup@t.io', name: 'Support', role: 'support', passwordHash: await bcrypt.hash('supportpass1', 4) });
  admin = call((await request(app()).post('/api/admin-auth/login').send({ email: 'root@t.io', password: 'rootpassword1' })).body.token);
  support = call((await request(app()).post('/api/admin-auth/login').send({ email: 'sup@t.io', password: 'supportpass1' })).body.token);
  const reg = async (name, ref) => (await request(app()).post('/api/auth/register').send({ name, email: `${name}@t.io`, password: 'password123', ref })).body;
  A = (await reg('Anna')).user.id;
  const b = await reg('Ben', (await M().User.findById(A)).referralCode); // Ben signs up under Anna's rebate link
  B = b.user.id; tokB = b.token;
  await require('../src/services/ledger').post({ userId: B, amount: 10_000, type: 'admin_add', note: 'seed' });
});
after(async () => { if (up) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } await fake.close(); });
const t = (name, fn) => it(name, async (c) => { if (!up) return c.skip('no MongoDB reachable'); await fn(); });

describe('market data proxy', () => {
  t('requires login and keeps the provider keys server-side', async () => {
    assert.equal((await request(app()).get('/api/market/quote/AAPL')).status, 401);
    const r = await call(tokB).get('/api/market/quote/AAPL');
    assert.equal(r.status, 200); assert.equal(r.body.quote.ap, 100);
    assert.ok(!JSON.stringify(r.body).includes('test-secret'));
  });
  t('caches short-lived quotes (one upstream call for many users) and sends the iex feed', async () => {
    alpaca().clearCache(); fake.state.calls.quote = 0;
    await call(tokB).get('/api/market/quote/AAPL'); await call(tokB).get('/api/market/quote/AAPL'); await call(tokB).get('/api/market/quote/AAPL');
    assert.equal(fake.state.calls.quote, 1);
    assert.equal(fake.state.lastQuery.feed, 'iex');
  });
  t('bars, price, validation and unknown symbols', async () => {
    const bars = await call(tokB).get('/api/market/bars/AAPL?timeframe=1Day&start=2026-10-01T00:00:00Z&end=2026-10-15T00:00:00Z&limit=10');
    assert.equal(bars.status, 200); assert.equal(bars.body.bars.length, 1);
    assert.equal(fake.state.lastQuery.timeframe, '1Day'); assert.equal(fake.state.lastQuery.limit, '10');
    assert.equal((await call(tokB).get('/api/market/bars/AAPL?timeframe=bogus')).status, 400);
    assert.equal((await call(tokB).get('/api/market/quote/AA$PL')).status, 400);
    assert.equal((await call(tokB).get('/api/market/quote/ZZZZ')).status, 404);
    const p = (await call(tokB).get('/api/market/price/MSFT')).body; assert.deepEqual([p.price, p.source], [200, 'quote']);
  });
  t('bad provider credentials surface as a clean 502 (no secrets leaked)', async () => {
    alpaca().clearCache(); const old = env().ALPACA_SECRET_KEY; env().ALPACA_SECRET_KEY = 'wrong';
    const r = await call(tokB).get('/api/market/quote/AAPL'); env().ALPACA_SECRET_KEY = old; alpaca().clearCache();
    assert.equal(r.status, 502); assert.match(r.body.message, /credentials/); assert.ok(!JSON.stringify(r.body).includes('wrong'));
  });
  t('the live-trading host is refused unless explicitly allowed', async () => {
    const e = env(), old = e.ALPACA_TRADING_URL; e.ALPACA_TRADING_URL = 'https://api.alpaca.markets';
    assert.throws(() => alpaca().ensureReady(), /Live Alpaca trading is blocked/);
    e.ALPACA_ALLOW_LIVE = 'true'; assert.doesNotThrow(() => alpaca().ensureReady());
    e.ALPACA_ALLOW_LIVE = 'false'; e.ALPACA_TRADING_URL = old;
  });
});

describe('buy / sell lifecycle and accounting', () => {
  t('market buy reserves cash (with buffer); the fill books the position and refunds the unused reserve', async () => {
    const r = await buy('aapl', 10);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'accepted'); assert.equal(r.body.reservedAmount, 1050); // 10 x $100 x 1.05 buffer
    assert.equal(await wallet(B), 8950);
    S.buy = r.body;
    fake.fill(S.buy.alpacaOrderId, { qty: 10, price: 101 });
    assert.equal((await admin.post('/api/admin/trading/sync', {})).body.updated, 1);
    assert.equal(await wallet(B), 8990); // paid exactly 10 x 101 = 1010
    const pos = await position(B, 'AAPL'); assert.deepEqual([pos.qty, pos.avgPrice], [10, 101]);
    assert.equal((await M().Order.findById(S.buy.id)).finalized, true);
  });
  t('partial sell fills credit cash, close trades with P&L, and feed the upline rebate', async () => {
    const r = await sell('AAPL', 4); assert.equal(r.status, 201, JSON.stringify(r.body)); S.sell = r.body;
    assert.equal((await position(B, 'AAPL')).reservedQty, 4);
    fake.fill(S.sell.alpacaOrderId, { qty: 1, price: 110, status: 'partially_filled' });
    await trading().sync();
    assert.equal(await wallet(B), 9100); // +110
    fake.fill(S.sell.alpacaOrderId, { qty: 4, price: 111.5 }); // cumulative: 1 @110 + 3 @112
    await trading().sync();
    assert.equal(await wallet(B), 9436); // +446 in total
    const pos = await position(B, 'AAPL'); assert.deepEqual([pos.qty, pos.reservedQty], [6, 0]);
    const trades = await M().Trade.find({ userId: B }).sort({ ticket: 1 });
    assert.deepEqual(trades.map((x) => x.profit), [9, 33]); // (110-101)x1, (112-101)x3
    assert.deepEqual(trades.map((x) => x.volume), [0.01, 0.03]); // 100 shares = 1 lot
    assert.ok(trades.every((x) => x.status === 'Closed' && x.accountId === 'alpaca' && x.ticket > 9e12));
    assert.equal(await wallet(A), 0.4); // Anna (L1): $10 per lot x 0.04 lots
    assert.equal((await M().RebateCommission.countDocuments({ ibUserId: A })), 2);
  });
  t('replaying the same fill is a no-op (idempotent booking)', async () => {
    const w = await wallet(B);
    const r = await buy('MSFT', 1); assert.equal(r.status, 201);
    assert.equal(await wallet(B), w - 210);
    fake.fill(r.body.alpacaOrderId, { qty: 1, price: 200 });
    const alp = fake.state.orders.get(r.body.alpacaOrderId);
    for (let i = 0; i < 3; i++) await trading().applyUpdate(r.body.id, alp);
    assert.equal((await position(B, 'MSFT')).qty, 1);
    assert.equal(await wallet(B), w - 200);
    S.msftWallet = await wallet(B);
  });
  it('simultaneous callers (request + sync job + admin) book a fill exactly once', async (c) => {
    if (!up) return c.skip('no MongoDB reachable');
    if (!atomic) return c.skip('database does not provide atomic findOneAndUpdate (emulator); verify on real MongoDB');
    const w = await wallet(B);
    const r = await buy('MSFT', 1); assert.equal(r.status, 201);
    fake.fill(r.body.alpacaOrderId, { qty: 1, price: 200 });
    const alp = fake.state.orders.get(r.body.alpacaOrderId);
    await Promise.all([1, 2, 3, 4].map(() => trading().applyUpdate(r.body.id, alp)));
    assert.equal((await position(B, 'MSFT')).qty, 2); // 1 from before + exactly 1 now
    assert.equal(await wallet(B), w - 200);
  });
  t('cannot sell more than held; shares in open sell orders are locked; cancel unlocks', async () => {
    assert.equal((await sell('AAPL', 7)).status, 409);
    const s6 = await sell('AAPL', 6); assert.equal(s6.status, 201);
    const again = await sell('AAPL', 1); assert.equal(again.status, 409); assert.match(again.body.message, /Insufficient AAPL/);
    const c = await call(tokB).del(`/api/me/orders/${s6.body.id}`); assert.equal(c.status, 200); assert.equal(c.body.status, 'canceled');
    const pos = await position(B, 'AAPL'); assert.deepEqual([pos.qty, pos.reservedQty], [6, 0]);
    assert.equal((await sell('AAPL', 1)).status, 201); // shares are free again
    await call(tokB).del(`/api/me/orders/${(await M().Order.findOne({ userId: B, side: 'sell', finalized: false })).id}`);
  });
  t('limit buy reserves exactly the limit value and a cancel refunds it', async () => {
    const w = await wallet(B);
    const r = await buy('AAPL', 5, { type: 'limit', limitPrice: 90, timeInForce: 'gtc' });
    assert.equal(r.status, 201); assert.equal(await wallet(B), w - 450);
    assert.equal((await call(tokB).del(`/api/me/orders/${r.body.id}`)).status, 200);
    assert.equal(await wallet(B), w);
    // another user cannot touch this order
    const o = (await buy('AAPL', 1, { type: 'limit', limitPrice: 80 })).body;
    const other = (await request(app()).post('/api/auth/register').send({ name: 'Eve', email: 'eve@t.io', password: 'password123' })).body.token;
    assert.equal((await call(other).del(`/api/me/orders/${o.id}`)).status, 404);
    S.adminCancel = o.id;
  });
  t('provider rejection undoes the reservation', async () => {
    const w = await wallet(B);
    const r = await buy('REJ', 1);
    assert.equal(r.status, 422); assert.match(r.body.message, /insufficient buying power/);
    assert.equal(await wallet(B), w);
    const o = await M().Order.findOne({ userId: B, symbol: 'REJ' }); assert.deepEqual([o.status, o.finalized], ['rejected', true]);
  });
  t('a lost submit response is reconciled via client_order_id (no duplicate, no lost funds)', async () => {
    const w = await wallet(B);
    const r = await buy('DROP', 2);
    assert.equal(r.status, 502); assert.ok(r.body.details.orderId);
    const id = r.body.details.orderId;
    assert.equal((await M().Order.findById(id)).status, 'submitting');
    assert.equal(await wallet(B), w - 105); // still held
    await trading().sync();
    const o = await M().Order.findById(id); assert.equal(o.status, 'accepted'); assert.ok(o.alpacaOrderId);
    assert.equal(fake.state.orders.size >= 1 && [...fake.state.orders.values()].filter((x) => x.symbol === 'DROP').length, 1);
    fake.fill(o.alpacaOrderId, { qty: 2, price: 50 });
    await trading().sync();
    assert.equal(await wallet(B), w - 100); assert.equal((await position(B, 'DROP')).qty, 2);
  });
});

describe('guards and admin controls', () => {
  t('rejects bad orders before touching money', async () => {
    const w = await wallet(B), n = await M().Order.countDocuments();
    assert.equal((await buy('AAPL', 500)).status, 409);                       // not enough cash
    assert.equal((await buy('HALT', 1)).status, 422);                          // not tradable
    assert.equal((await buy('BTCUSD', 1)).status, 422);                        // not a US stock
    assert.equal((await buy('ZZZZ', 1)).status, 404);                          // unknown
    assert.equal((await buy('WHOLE', 1.5)).status, 422);                       // whole shares only
    assert.equal((await buy('AAPL', 0)).status, 400);
    assert.equal((await buy('AAPL', 1, { type: 'limit' })).status, 400);       // limit needs a price
    assert.equal((await call(tokB).post('/api/me/orders', { symbol: 'AAPL', side: 'short', qty: 1 })).status, 400);
    assert.equal(await wallet(B), w); assert.equal(await M().Order.countDocuments(), n);
  });
  t('kill switch, per-order cap and account-status checks', async () => {
    assert.equal((await support.put('/api/admin/trading/settings', { enabled: false })).status, 403); // support is read-only
    await admin.put('/api/admin/trading/settings', { maxOrderValue: 500 });
    assert.equal((await buy('AAPL', 10)).status, 400);
    await admin.put('/api/admin/trading/settings', { maxOrderValue: 100000, enabled: false });
    assert.equal((await buy('AAPL', 1)).status, 503);
    await admin.put('/api/admin/trading/settings', { enabled: true });
    await M().User.updateOne({ _id: B }, { accountStatus: 'Pending' });
    assert.equal((await buy('AAPL', 1)).status, 403);
    await M().User.updateOne({ _id: B }, { accountStatus: 'Active' });
    assert.equal((await buy('AAPL', 1, { type: 'limit', limitPrice: 80 })).status, 201);
  });
  t('admin can see provider status, list orders/positions and cancel any order', async () => {
    const p = (await admin.get('/api/admin/trading/provider')).body;
    assert.deepEqual([p.configured, p.live, p.account.status], [true, false, 'ACTIVE']);
    const orders = (await admin.get(`/api/admin/trading/orders?userId=${B}`)).body;
    assert.ok(orders.total >= 8); assert.equal(orders.data[0].userName, 'Ben');
    assert.equal((await admin.get(`/api/admin/trading/orders?userId=${B}&open=true`)).body.data.every((o) => !o.finalized), true);
    const pos = (await admin.get(`/api/admin/trading/positions?userId=${B}`)).body;
    assert.deepEqual(pos.data.map((x) => x.symbol).sort(), ['AAPL', 'DROP', 'MSFT']);
    const w = await wallet(B);
    const c = await admin.post(`/api/admin/trading/orders/${S.adminCancel}/cancel`, {}); assert.equal(c.status, 200); assert.equal(c.body.status, 'canceled');
    assert.equal(await wallet(B), w + 80);
    const mine = (await call(tokB).get('/api/me/positions')).body.find((x) => x.symbol === 'AAPL');
    assert.deepEqual([mine.qty, mine.availableQty, mine.lastPrice, mine.unrealizedPL], [6, 6, 100, -6]);
  });
});
