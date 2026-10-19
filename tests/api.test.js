/**
 * End-to-end tests against a real MongoDB-compatible server.
 * Set MONGODB_URI_TEST (default mongodb://127.0.0.1:27017). Skipped automatically if no server is reachable.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-1234';
process.env.ENABLE_CRON = 'false';
process.env.MT5_WEBHOOK_KEY = 'bridge-key';
process.env.UPLOAD_DIR = require('os').tmpdir() + '/invex-test-uploads';
const base = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017';
const dbName = `invex_test_${Date.now()}`;
process.env.MONGODB_URI = `${base}/${dbName}`;

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');
const bcrypt = require('bcryptjs');

let up = false;
const app = () => require('../src/app');
const M = () => require('../src/models');
let admin, support; // supertest agents helpers
const A = {}; // users
const call = (tok) => ({
  get: (u) => request(app()).get(u).set('Authorization', `Bearer ${tok}`),
  post: (u, b) => request(app()).post(u).set('Authorization', `Bearer ${tok}`).send(b),
  put: (u, b) => request(app()).put(u).set('Authorization', `Bearer ${tok}`).send(b),
  patch: (u, b) => request(app()).patch(u).set('Authorization', `Bearer ${tok}`).send(b),
  del: (u) => request(app()).delete(u).set('Authorization', `Bearer ${tok}`),
});
const register = async (name, ref) => {
  const r = await request(app()).post('/api/auth/register').send({ name, email: `${name.toLowerCase()}@t.io`, password: 'password123', ref });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.user.id;
};
const deposit = async (id, amount) => {
  const d = await request(app()).post('/api/me/deposits').set('Authorization', `Bearer ${A[id + 'tok']}`).send({ amount, method: 'bank' });
  assert.equal(d.status, 201);
  const r = await admin.post(`/api/admin/deposits/${d.body.id}/review`, { status: 'Successful' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return d.body.id;
};
const user = (id) => M().User.findById(id).select('+ancestors');
const wallet = async (id) => (await user(id)).walletBalance;
const closedTrade = (ticket, login, over = {}) => ({ ticket, login, symbol: 'EURUSD', side: 'BUY', volume: 2, openPrice: 1.1, closePrice: 1.2, openTime: new Date(Date.now() - 3600e3), closeTime: new Date(), profit: 0, status: 'Closed', ...over });
const push = (trades) => request(app()).post('/api/integrations/mt5/trades').set('x-api-key', 'bridge-key').send(trades);

before(async () => {
  try { await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 2500 }); up = true; } catch (e) { console.warn('[tests] MongoDB not reachable, skipping:', e.message); return; }
  await M().ensureIndexes();
  const { SYSTEM_RANKS, ACCOUNT_TYPES } = require('../src/constants');
  for (const [i, r] of SYSTEM_RANKS.entries()) await M().SystemRank.create({ ...r, position: i + 1 });
  for (const k of ACCOUNT_TYPES) await M().AccountType.create({ _id: k, label: k, leverage: '1:100', separatePerLot: 0 });
  await M().Admin.create({ email: 'root@t.io', name: 'Root', role: 'superadmin', isSuperAdmin: true, passwordHash: await bcrypt.hash('rootpassword1', 4) });
  await M().Admin.create({ email: 'sup@t.io', name: 'Support', role: 'support', passwordHash: await bcrypt.hash('supportpass1', 4) });
  admin = call((await request(app()).post('/api/admin-auth/login').send({ email: 'root@t.io', password: 'rootpassword1' })).body.token);
  support = call((await request(app()).post('/api/admin-auth/login').send({ email: 'sup@t.io', password: 'supportpass1' })).body.token);
});
after(async () => { if (up) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } });
const t = (name, fn) => it(name, async (c) => { if (!up) return c.skip('no MongoDB reachable'); await fn(); });

describe('auth & permissions', () => {
  t('rejects bad admin login, accepts good one', async () => {
    const bad = await request(app()).post('/api/admin-auth/login').send({ email: 'root@t.io', password: 'wrong-password' });
    assert.equal(bad.status, 401);
    const me = await admin.get('/api/admin-auth/me'); assert.equal(me.body.admin.isSuperAdmin, true);
  });
  t('support is read-only; admins list is super-admin only', async () => {
    assert.equal((await support.get('/api/admin/dashboard')).status, 200);
    assert.equal((await support.post('/api/admin/system-ranks', { name: 'X', minTeamDeposit: 1 })).status, 403);
    assert.equal((await support.get('/api/admin/admins')).status, 403);
    assert.equal((await admin.get('/api/admin/admins')).status, 200);
  });
});

describe('network, rank (§2) and team deposit', () => {
  t('builds a 5-level tree through referral links', async () => {
    A.a = await register('Anna');
    const code = (id) => user(id).then((u) => u.referralCode);
    A.b = await register('Ben', await code(A.a));
    A.c = await register('Cara', await code(A.b));
    A.d = await register('Dan', await code(A.c));
    A.e = await register('Eve', await code(A.d));
    const e = await user(A.e);
    assert.deepEqual(e.ancestors, [A.d, A.c, A.b, A.a]);
    assert.equal(e.registrationType, 'Rebate Link');
    assert.equal((await user(A.a)).isIb, true);
    for (const id of [A.a, A.b, A.c, A.d, A.e]) {
      const u = await user(id); A[id + 'tok'] = require('../src/middleware/auth').sign({ sub: id }, 'user');
    }
    assert.equal((await request(app()).post('/api/auth/register').send({ name: 'Zed', email: 'z@t.io', password: 'password123', ref: 'NOPE' })).status, 400);
  });
  t('rank follows TEAM deposit (not personal) and is lifetime', async () => {
    await deposit(A.a, 50_000); // personal deposit must NOT rank Anna
    assert.equal((await user(A.a)).systemRankId, null);
    const dc = await deposit(A.c, 10_000);
    assert.equal((await user(A.a)).teamDeposit, 10_000);
    assert.equal((await user(A.b)).teamDeposit, 10_000);
    const names = async (id) => (await M().SystemRank.findById((await user(id)).systemRankId))?.name;
    assert.equal(await names(A.a), 'Master');
    assert.equal(await names(A.b), 'Master');
    assert.equal(await names(A.c), undefined); // Cara's own team (Dan, Eve) has nothing yet
    await deposit(A.d, 30_000); // Anna team = 40k -> Empire (skips Royal)
    assert.equal(await names(A.a), 'Empire');
    // reduce the deposit: rank stays (§3.1 lifetime)
    const e = await admin.patch(`/api/admin/transactions/${dc}`, { amount: 1_000 });
    assert.equal(e.status, 200);
    assert.equal((await user(A.a)).teamDeposit, 31_000);
    assert.equal(await names(A.a), 'Empire');
    assert.equal(await wallet(A.c), 1_000); // edit corrected the wallet too
  });
  t('rank members list shows the §2.4 fields', async () => {
    const ranks = (await admin.get('/api/admin/system-ranks')).body;
    assert.deepEqual(ranks.map((r) => r.name), ['Master', 'Royal', 'Empire', 'Ambassador', 'Crown Ambassador']);
    const empire = ranks.find((r) => r.name === 'Empire');
    const m = (await admin.get(`/api/admin/system-ranks/${empire.id}/members`)).body;
    assert.equal(m.data[0].userId, A.a);
    assert.equal(m.data[0].totalTeamDeposit, 31_000);
    assert.equal(m.data[0].currentSystemRank, 'Empire');
  });
  t('manual rank is never overridden; removing it resumes auto', async () => {
    const royal = (await admin.get('/api/admin/system-ranks')).body.find((r) => r.name === 'Royal');
    await admin.put(`/api/admin/users/${A.a}/system-rank`, { rankId: royal.id });
    await deposit(A.e, 100_000); // would be Crown Ambassador automatically
    assert.equal((await user(A.a)).systemRankId, royal.id);
    assert.equal((await user(A.a)).systemRankSource, 'manual');
    const r = await admin.put(`/api/admin/users/${A.a}/system-rank`, { rankId: null });
    assert.equal(r.body.systemRankSource, 'auto');
    assert.equal((await M().SystemRank.findById(r.body.systemRankId)).name, 'Crown Ambassador');
  });
  t('changing upline moves the subtree and team deposits; loops are refused', async () => {
    const before = (await user(A.b)).teamDeposit; // Ben: Cara+Dan+Eve = 1k+30k+100k
    assert.equal(before, 131_000);
    assert.equal((await admin.put(`/api/admin/users/${A.a}/upline`, { uplineId: A.e })).status, 400); // Anna under her own descendant
    assert.equal((await admin.put(`/api/admin/users/${A.a}/upline`, { uplineId: A.a })).status, 400);
    // move Cara (with Dan, Eve) from Ben to directly under Anna
    assert.equal((await admin.put(`/api/admin/users/${A.c}/upline`, { uplineId: A.a })).status, 200);
    assert.deepEqual((await user(A.e)).ancestors, [A.d, A.c, A.a]);
    assert.equal((await user(A.b)).teamDeposit, 0);
    assert.equal((await user(A.a)).teamDeposit, 131_000 + 0); // Ben's 0 + Cara's subtree
  });
});

describe('rebates (§1, §8.7)', () => {
  t('pays $/lot per level to the upline chain, once, and feeds the dashboard cards', async () => {
    // Eve's chain is now Dan(L1), Cara(L2), Anna(L3). Re-link Eve's MT5 login & trade 2 lots.
    await admin.patch(`/api/admin/users/${A.e}`, { mt5Login: '9001' });
    const w0 = { d: await wallet(A.d), c: await wallet(A.c), a: await wallet(A.a) };
    const r = await push([closedTrade(1001, '9001')]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.results[0].commissions.rebates, 3);
    assert.equal((await wallet(A.d)) - w0.d, 20); // L1 $10 x 2 lots
    assert.equal((await wallet(A.c)) - w0.c, 10); // L2 $5 x 2
    assert.equal((await wallet(A.a)) - w0.a, 10); // L3 $5 x 2
    const again = await push([closedTrade(1001, '9001')]);
    assert.equal(again.body.results[0].skipped, 'already settled');
    assert.equal((await wallet(A.d)) - w0.d, 20); // not paid twice
    const cards = (await admin.get('/api/admin/rebate-system/summary')).body;
    assert.equal(cards['total-rebate-commission'].amount, 40);
    assert.equal(cards['total-rebate-distribution'].amount, 40);
    assert.equal(cards['24h-rebate-commission'].amount, 40);
    const old = await admin.get('/api/admin/rebate-system/cards/total-rebate-commission?from=2000-01-01&to=2000-01-02');
    assert.equal(old.body.amount, 0); // date filter works
  });
  t('custom per-IB rebate overrides the default; banned IB is put On Hold', async () => {
    await admin.put(`/api/admin/users/${A.d}/custom-ib`, { rebate: [25], revenue: [] });
    await admin.post(`/api/admin/users/${A.c}/ban`, {});
    const wd = await wallet(A.d), wc = await wallet(A.c);
    await push([closedTrade(1002, '9001', { volume: 1 })]);
    assert.equal((await wallet(A.d)) - wd, 25);
    assert.equal((await wallet(A.c)) - wc, 0);
    const hold = (await admin.get('/api/admin/rebate-system/history?status=On%20Hold')).body;
    assert.equal(hold.total, 1);
    await admin.patch(`/api/admin/users/${A.c}/status`, { status: 'Active' });
  });
});

describe('revenue link (§7)', () => {
  t('revenue code only works once approved; loss -> Account Plus, profit -> Account Minus', async () => {
    const aCode = (await user(A.a)).revenueCode;
    assert.equal(aCode, undefined);
    await admin.put(`/api/admin/users/${A.a}/revenue-link`, { status: 'Approved' });
    const code = (await user(A.a)).revenueCode;
    assert.ok(code);
    A.f = await register('Finn', code);
    A.g = await register('Gina', (await user(A.f)).revenueCode ?? 'x').catch(() => null);
    assert.equal((await user(A.f)).registrationType, 'Revenue Link');
    A['f' + 'tok'] = require('../src/middleware/auth').sign({ sub: A.f }, 'user');
    await admin.patch(`/api/admin/users/${A.f}`, { mt5Login: '9100' });
    // user app: Revenue Link visible only when approved
    const aff = await request(app()).get('/api/me/affiliate').set('Authorization', `Bearer ${A[A.a + 'tok']}`);
    assert.ok(aff.body.revenueLink); 
    const aff2 = await request(app()).get('/api/me/affiliate').set('Authorization', `Bearer ${A[A.b + 'tok']}`);
    assert.equal(aff2.body.revenueLink, null);

    const a0 = await wallet(A.a), f0 = await wallet(A.f);
    await push([closedTrade(2001, '9100', { profit: -100 })]);
    assert.equal((await wallet(A.a)) - a0, 30); // 30% of a $100 loss
    await push([closedTrade(2002, '9100', { profit: 100 })]);
    assert.equal((await wallet(A.a)) - a0, 0); // +30 then -30
    assert.equal((await wallet(A.f)) - f0, 30); // paid to the user
    const s = (await admin.get('/api/admin/revenue-link/summary')).body;
    assert.equal(s.accountPlus, 30); assert.equal(s.accountMinus, 30);
  });
  t('IB rank unlocks deeper levels (Basic = L1 only, Starter = up to L2)', async () => {
    const code = (await user(A.f)).revenueCode;
    assert.equal(code, undefined); // Finn has no revenue link himself
    await admin.put(`/api/admin/users/${A.f}/revenue-link`, { status: 'Approved' });
    A.h = await register('Hugo', (await user(A.f)).revenueCode);
    await admin.patch(`/api/admin/users/${A.h}`, { mt5Login: '9200' });
    const f0 = await wallet(A.f), a0 = await wallet(A.a);
    await push([closedTrade(3001, '9200', { profit: -200 })]);
    assert.equal((await wallet(A.f)) - f0, 60); // L1 30%
    assert.equal((await wallet(A.a)) - a0, 0);  // Anna is Basic: L2 locked
    await admin.put(`/api/admin/users/${A.a}/ib-rank`, { rank: 'Starter' });
    await push([closedTrade(3002, '9200', { profit: -200 })]);
    assert.equal((await wallet(A.a)) - a0, 10); // L2 5%
  });
});

describe('equity bonus (§3)', () => {
  const eq = require('../src/services/equity');
  t('only Level-2 equity counts; 3 failures forfeit; rank does not set the %', async () => {
    // Anna's Level 2 = users with ancestors[1] == Anna. Her direct team: Ben, Cara, Finn; L2: Dan (under Cara) & Hugo (under Finn)
    const l2 = await M().User.find({ 'ancestors.1': A.a }).select('_id');
    assert.deepEqual(l2.map((u) => u.id).sort(), [A.d, A.h].sort());
    await M().User.updateOne({ _id: A.d }, { mt5Equity: 6_000 });
    await M().User.updateOne({ _id: A.h }, { mt5Equity: 4_500 });
    await M().User.updateOne({ _id: A.c }, { mt5Equity: 999_999 }); // Level 1: must be ignored
    const r1 = await eq.runDailySnapshot(new Date('2026-09-02T10:00:00Z'));
    assert.ok(r1.checked >= 1);
    const row = await M().EquityMonth.findOne({ ibUserId: A.a, month: '2026-09' });
    assert.equal(row.requiredEquity, 10_000); // 10,500 -> 1% tier floor
    assert.equal(row.failureCount, 0);
    // equity drops below the floor on 3 different days
    await M().User.updateOne({ _id: A.h }, { mt5Equity: 3_000 });
    for (const day of ['03', '04']) await eq.runDailySnapshot(new Date(`2026-09-${day}T10:00:00Z`));
    let cur = await M().EquityMonth.findOne({ ibUserId: A.a, month: '2026-09' });
    assert.equal(cur.failureCount, 2); assert.equal(cur.status, 'Warning');
    await eq.runDailySnapshot(new Date('2026-09-04T18:00:00Z')); // same day again -> not a new failure
    cur = await M().EquityMonth.findOne({ ibUserId: A.a, month: '2026-09' });
    assert.equal(cur.failureCount, 2);
    await eq.runDailySnapshot(new Date('2026-09-05T10:00:00Z'));
    cur = await M().EquityMonth.findOne({ ibUserId: A.a, month: '2026-09' });
    assert.equal(cur.failureCount, 3); assert.equal(cur.status, 'Forfeited');
    await eq.finalizeMonth('2026-09');
    cur = await M().EquityMonth.findOne({ ibUserId: A.a, month: '2026-09' });
    assert.equal(cur.bonus, 0);
    const w = await wallet(A.a);
    const pay = await eq.payMonth('2026-09', 'tester');
    assert.equal(await wallet(A.a), w); // forfeited -> nothing paid
    assert.ok(pay.paid >= 0);
  });
  t('maintained all month: bonus = tier % of maintained L2 equity, paid once, regardless of system rank', async () => {
    await M().User.updateOne({ _id: A.d }, { mt5Equity: 10_000 }); // Anna: Crown Ambassador-ish rank, but only 10k L2 equity
    await M().User.updateOne({ _id: A.h }, { mt5Equity: 0 });
    for (const day of ['01', '02', '03']) await eq.runDailySnapshot(new Date(`2026-08-${day}T10:00:00Z`));
    await eq.finalizeMonth('2026-08');
    const row = await M().EquityMonth.findOne({ ibUserId: A.a, month: '2026-08' });
    assert.equal(row.pct, 1); assert.equal(row.status, 'Qualified'); assert.equal(row.bonus, 100);
    const w = await wallet(A.a);
    await admin.post('/api/admin/equity-bonus/pay', { month: '2026-08' });
    await admin.post('/api/admin/equity-bonus/pay', { month: '2026-08' }); // idempotent
    assert.equal((await wallet(A.a)) - w, 100);
  });
});

describe('profile actions (§8)', () => {
  t('wallet vs equity plus/minus stay separate and guarded', async () => {
    await admin.patch(`/api/admin/users/${A.b}`, { mt5Login: '7777' });
    const w = await wallet(A.b);
    const r = await admin.post(`/api/admin/users/${A.b}/balance`, { target: 'wallet', op: 'add', amount: 500, reason: 'goodwill' });
    assert.equal(r.status, 200);
    let u = await user(A.b); assert.equal(u.walletBalance, w + 500); assert.equal(u.mt5Equity, 0);
    await admin.post(`/api/admin/users/${A.b}/balance`, { target: 'equity', op: 'add', amount: 300, reason: 'promo credit' });
    u = await user(A.b); assert.equal(u.walletBalance, w + 500); assert.equal(u.mt5Equity, 300);
    assert.equal((await admin.post(`/api/admin/users/${A.b}/balance`, { target: 'wallet', op: 'minus', amount: 9_999_999, reason: 'too much' })).status, 409);
    assert.equal((await admin.post(`/api/admin/users/${A.b}/balance`, { target: 'equity', op: 'minus', amount: 301, reason: 'too much' })).status, 409);
    assert.equal((await admin.post(`/api/admin/users/${A.b}/balance`, { target: 'wallet', op: 'minus', amount: 100, reason: '' })).status, 400); // reason required
  });
  t('withdrawal holds funds, rejection refunds; marketing dummy dollars are not withdrawable', async () => {
    const w = await wallet(A.b);
    const wd = await request(app()).post('/api/me/withdrawals').set('Authorization', `Bearer ${A[A.b + 'tok']}`).send({ amount: 200, destination: 'bank-123' });
    assert.equal(wd.status, 201); assert.equal(await wallet(A.b), w - 200);
    await admin.post(`/api/admin/withdrawals/${wd.body.id}/review`, { status: 'Rejected' });
    assert.equal(await wallet(A.b), w);
    assert.equal((await admin.post(`/api/admin/withdrawals/${wd.body.id}/review`, { status: 'Successful' })).status, 409); // already processed
    await admin.post(`/api/admin/users/${A.b}/marketing`, { dummyDollars: 5_000 });
    const u = await user(A.b); assert.equal(u.dummyBalance, 5_000); assert.equal(u.walletBalance, w);
    const big = await request(app()).post('/api/me/withdrawals').set('Authorization', `Bearer ${A[A.b + 'tok']}`).send({ amount: w + 1, destination: 'bank-123' });
    assert.equal(big.status, 409); // only the real wallet can be withdrawn
  });
  t('status, warn, ban, impersonation and audit trail', async () => {
    assert.equal((await admin.post(`/api/admin/users/${A.e}/warn`, {})).body.accountStatus, 'Warned');
    assert.equal((await admin.patch(`/api/admin/users/${A.e}/status`, { status: 'Pending' })).body.accountStatus, 'Pending');
    const imp = await admin.post(`/api/admin/users/${A.e}/impersonate`, {});
    const me = await request(app()).get('/api/me').set('Authorization', `Bearer ${imp.body.token}`);
    assert.equal(me.body.id, A.e); assert.equal(me.body.impersonated, true);
    await new Promise((r) => setTimeout(r, 150));
    const logs = (await admin.get(`/api/admin/audit-logs?userId=${A.e}`)).body;
    assert.ok(logs.total >= 3);
  });
  t('profile returns upline, verification and network summary', async () => {
    const p = (await admin.get(`/api/admin/users/${A.h}`)).body;
    assert.equal(p.upline.id, A.f); assert.equal(p.verification.kycStatus, 'Unverified'); assert.equal(p.network.directs, 0);
    const list = (await admin.get('/api/admin/users?registrationType=Revenue%20Link&search=hugo')).body;
    assert.equal(list.total, 1);
  });
});

describe('copy trading, PAM, account types, templates', () => {
  t('copy trading overview + settings; PAM overview + settings', async () => {
    await admin.post(`/api/admin/users/${A.a}/balance`, { target: 'wallet', op: 'add', amount: 5_000, reason: 'test funds' });
    const tok = A[A.a + 'tok'], me = (u, b) => request(app()).post(u).set('Authorization', `Bearer ${tok}`).send(b);
    assert.equal((await me('/api/me/copy/invest', { amount: 1_000 })).status, 201);
    assert.equal((await me('/api/me/pam/deposit', { amount: 2_000 })).status, 201);
    assert.equal((await me('/api/me/copy/invest', { amount: 99_999_999 })).status, 400);
    const ov = (await admin.get('/api/admin/copy-trading/overview')).body;
    assert.equal(ov.totalInvestment, 1_000); assert.equal(ov.activeCopiers, 1); assert.equal(ov.investmentLast24h, 1_000);
    assert.equal((await admin.get(`/api/admin/copy-trading/users/${A.a}/history`)).body.total, 1);
    assert.equal((await admin.put('/api/admin/copy-trading/settings', { profitCutPct: 30, timeline: [{ label: 'Lock', days: 30 }] })).body.profitCutPct, 30);
    const pam = (await admin.get('/api/admin/pam/overview')).body; assert.deepEqual([pam.totalDeposit, pam.totalClients], [2_000, 1]);
    assert.equal((await admin.put('/api/admin/pam/settings', { profitSharePct: 25, monthlyReturnPct: 4 })).body.monthlyReturnPct, 4);
    assert.equal((await admin.put('/api/admin/copy-trading/settings', { profitCutPct: 130 })).status, 400);
  });
  t('account types are independent', async () => {
    await admin.put('/api/admin/account-types/ecn', { separatePerLot: 3.5, leverage: '1:500' });
    const all = (await admin.get('/api/admin/account-types')).body;
    assert.deepEqual(all.map((x) => x.id), ['standard', 'zero', 'ecn', 'cent']);
    assert.deepEqual(all.find((x) => x.id === 'ecn') && [all[2].separatePerLot, all[2].leverage], [3.5, '1:500']);
    assert.deepEqual([all[0].separatePerLot, all[0].leverage], [0, '1:100']); // others untouched
  });
  t('media upload/replace/delete + promotions; public feed shows only live ones', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const up1 = await request(app()).post('/api/admin/templates/media').set('Authorization', `Bearer ${(await request(app()).post('/api/admin-auth/login').send({ email: 'root@t.io', password: 'rootpassword1' })).body.token}`)
      .field('title', 'Summer banner').field('kind', 'banner').field('text', '50% bonus').attach('file', png, { filename: 'b.png', contentType: 'image/png' });
    assert.equal(up1.status, 201, JSON.stringify(up1.body));
    const bad = await request(app()).post('/api/admin/templates/media').set('Authorization', `Bearer ${(await request(app()).post('/api/admin-auth/login').send({ email: 'root@t.io', password: 'rootpassword1' })).body.token}`)
      .field('title', 'x').attach('file', Buffer.from('<svg/>'), { filename: 'x.svg', contentType: 'image/svg+xml' });
    assert.equal(bad.status, 400);
    const live = await admin.post('/api/admin/templates/promotions', { title: 'Welcome bonus', type: 'Bonus', status: 'Active', mediaId: up1.body.id });
    await admin.post('/api/admin/templates/promotions', { title: 'Draft contest', type: 'Contest' });
    await admin.post('/api/admin/templates/promotions', { title: 'Expired', status: 'Active', endsAt: '2020-01-01' });
    const pub = (await request(app()).get('/api/public/promotions')).body;
    assert.deepEqual(pub.map((p) => p.title), ['Welcome bonus']);
    assert.equal(pub[0].media.text, '50% bonus');
    assert.equal((await admin.patch(`/api/admin/templates/promotions/${live.body.id}`, { status: 'Paused' })).body.status, 'Paused');
    assert.equal((await admin.del(`/api/admin/templates/media/${up1.body.id}`)).status, 200);
    assert.equal((await M().Promotion.findById(live.body.id)).mediaId, null);
  });
});
