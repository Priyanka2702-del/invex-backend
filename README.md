# INVEX Backend

Node.js (Express) + MongoDB (Mongoose). One API for the **admin panel** (`invex-broker-admin`) and the **user app** (`invex-trade`).
Implements every section of *Admin Panel — Complete Functional Requirements* (§1–§9).

## Run it

```bash
cp .env.example .env        # set JWT_SECRET (32+ random chars), MONGODB_URI, ADMIN_EMAIL, ADMIN_PASSWORD
npm install
npm run seed                # super admin + the 5 system ranks + 4 account types (safe to re-run)
npm run dev                 # http://localhost:5001/api
npm test                    # logic tests always run; API tests need a MongoDB (see below)
```

The admin app already points at `http://localhost:5001/api` and logs in with `POST /admin-auth/login` → `{ token, admin }`; nothing to change there.
API tests use `MONGODB_URI_TEST` (default `mongodb://127.0.0.1:27017`; a throw-away database is created and dropped) and skip themselves if no server is reachable.

## Postman

Import `postman/INVEX-Backend.postman_collection.json` (147 requests, every route). Edit the collection variables (`baseUrl`, `adminEmail`, `adminPassword`, `mt5Key`), then run the **1 · Start here** folder first; tokens and ids are saved automatically.

## How the PDF maps to the API (all under `/api/admin`, Bearer admin token)

| PDF | Endpoints |
|---|---|
| §1 Rebate dashboard | `GET /rebate-system/cards/:card?from&to` (`total-rebate-commission`, `total-rebate-distribution`, `24h-rebate-commission`, `24h-revenue-commission`; each card has its own date/time filter), `GET /rebate-system/summary`, `GET /rebate-system/history`, `GET/PUT /rebate-system/defaults` |
| §2 System Rank | `GET /system-ranks`, `GET /system-ranks/:id/members` (User ID, name, total team deposit, rank), CRUD, `POST /system-ranks/recalculate` |
| §3 Equity bonus | `GET /equity-bonus?month=`, `GET /equity-bonus/user/:id`, `POST /equity-bonus/snapshot`, `/finalize`, `/pay`, `GET /equity-bonus/tiers` |
| §4 Copy trading | `GET /copy-trading/overview`, `/investors`, `/users/:id/history`, `GET/PUT /copy-trading/settings` (profit cut %, timeline conditions) |
| §5 PAM | `GET /pam/overview`, `/history`, `/clients`, `/clients/:id`, `GET/PUT /pam/settings` (profit share %, monthly return %) |
| §6 Separate management | `GET /account-types`, `GET/PUT /account-types/:key` (separate per lot + leverage; each type is independent) |
| §7 Revenue link | `GET /revenue-link/summary`, `/history`, `/structure`, `PUT /revenue-link/structure` |
| §8 User profile | `GET /users`, `GET /users/:id`, `PUT /users/:id/upline`, `GET /users/:id/trades`, `/deposits`, `/withdrawals`, `POST /users/:id/ban`, `/warn`, `/impersonate`, `PATCH /users/:id/status`, `/verification`, `POST /users/:id/balance` (`target: wallet or equity`, `op: add or minus`), `PUT/DELETE /users/:id/custom-ib`, `PUT /users/:id/ib-rank`, `/system-rank`, `/revenue-link`, `POST/DELETE /users/:id/marketing`, `PATCH /transactions/:id` (edit any transaction) |
| §9 Templates & promotions | `/templates/media` (upload/replace/edit/delete, multipart field `file`), `/templates/promotions` (CRUD) |
| extras | `/dashboard`, `/deposits`, `/withdrawals` (+ `/review`), `/trades`, `/audit-logs`, `/admins` (super admin only) |

**User app:** `POST /api/auth/register` (`ref` = referral code), `POST /api/auth/login`, `GET /api/me`, `/me/affiliate` (Revenue Link only if approved, §8.11), `/me/team`, `/me/system-rank`, `/me/equity-bonus`, `/me/deposits`, `/me/withdrawals`, `/me/copy`, `/me/pam`, `GET /api/public/promotions`.

**MT5 bridge** (header `x-api-key: MT5_WEBHOOK_KEY`): `POST /api/integrations/mt5/trades`, `POST /api/integrations/mt5/equity`.

**Live updates:** socket.io (auth `{ token }` = admin JWT) emits `rebate:created`, `revenue:created`, `withdrawal:new`, `trades:synced`.

List endpoints return `{ data, total, page, limit, pages }` and accept `page`, `limit`, `from`, `to`.

## Design decisions

- **Team tree** is a materialised path (`ancestors` on each user), so "Level N of X" and "whole team of X" are single indexed queries. Changing an upline rewrites the moved subtree and shifts team-deposit totals; loops are refused.
- **System Rank** = Total Team Deposit of the *downline only* (own deposits excluded), updated incrementally when a deposit is approved or edited. Auto-promotion only goes up (lifetime); a manually assigned rank is never changed automatically; removing it resumes auto.
- **Money** only moves through `services/ledger.js` (atomic `$inc` + append-only ledger row). Withdrawals are debited when requested and refunded if rejected. Dummy dollars live in a separate balance and can never be withdrawn.
- **Commissions** are generated once per closed trade (atomic claim + unique `(tradeId, level)` index), so duplicate MT5 pushes cannot double-pay. A banned upline's commission is stored as *On Hold*.
- MongoDB multi-document transactions are **not** used (they need a replica set); operations are atomic per document and idempotent instead.
- Cron (UTC): daily equity snapshot 00:05, month-end finalize on the 1st at 00:30, nightly rank/team-deposit recompute 03:00. All idempotent.

## Alpaca stock trading + market data (paper by default)

Add to `.env`: `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` (paper keys). Defaults point at `https://paper-api.alpaca.markets` and `https://data.alpaca.markets` with the free `iex` feed. **The server refuses to start talking to the live host `api.alpaca.markets` unless `ALPACA_ALLOW_LIVE=true`.** Keys never reach the browser.

**User app** (Bearer user token): market data `GET /api/market/quote|trade|bar|snapshot/:symbol`, `/market/price/:symbol`, `/market/bars/:symbol?timeframe=1Day&start&end&limit`, `/market/snapshots?symbols=AAPL,MSFT`, `/market/news`, `/market/clock`, `/market/assets/:symbol` (Alpaca's JSON, cached ~2 s, 120 req/min per user). Trading: `POST /api/me/orders` `{symbol, side: buy|sell, type: market|limit, qty, limitPrice?, timeInForce: day|gtc}`, `GET /api/me/orders`, `GET /api/me/orders/:id`, `DELETE /api/me/orders/:id` (cancel), `GET /api/me/positions` (with last price and unrealised P&L).

**Admin** (`/api/admin/trading`): `GET /provider` (environment + Alpaca account status), `GET/PUT /settings` (kill switch `enabled`, `lotSize`, `maxOrderValue`, `buyReserveBufferPct`), `GET /orders`, `GET /positions`, `POST /orders/:id/cancel`, `POST /sync`. Socket.io events: `order:new`, `order:updated`.

**How the money works.** All users trade through ONE shared Alpaca paper account; our database is the per-user book.
- Buy: cash is reserved from the user's wallet (market buys hold a 5 % buffer; limit buys hold exactly qty x limit), the fill is booked into the user's position (weighted average cost), and the unused reserve is refunded when the order ends.
- Sell: shares are locked in the position, proceeds are credited per fill, and short selling is blocked.
- Every sell fill creates a **Closed trade** (`accountId: "alpaca"`, volume = shares / `lotSize`, profit = (sell price - average cost) x shares), so the existing rebate, revenue-link and rank logic runs unchanged.
- Our order id is sent as Alpaca's `client_order_id`; a lost response is reconciled by looking the order up with `orders:by_client_order_id`. Fills are picked up by polling (`ALPACA_SYNC_INTERVAL_MS`, default 5 s; the guide documents polling, not streaming).
- Only `Active`, `Approved` and `Warned` accounts can trade; Pending/Banned cannot.

**Read this before going further**
1. **Paper/testing only.** One shared Alpaca account holding everyone's orders is not how real customer money should be handled; for live customers Alpaca's *Broker API* (one Alpaca account per customer) is the product designed for it, and this module would be adapted to it.
2. **Rebates are "$ per lot".** For stocks a lot is `lotSize` = 100 shares (editable), so with the defaults an upline earns $10 per 100 shares sold at Level 1. Confirm the intended rebate rule for stocks with your client.
3. **Equity bonus (§3) reads `mt5Equity`.** Stock accounts do not update that field yet; decide whether equity for stock users = cash + market value of positions.
4. Stocks only (no crypto/options); fractional shares only where Alpaca allows it; the free `iex` feed is not the full consolidated market.
5. Booking relies on MongoDB's atomic single-document `findOneAndUpdate` (a compare-and-set on `appliedQty`), so a fill is booked exactly once even if the request, the sync job and an admin act at the same time. Use real MongoDB or Atlas (not an emulator). There are no multi-document transactions, so a crash in the instant after a fill is claimed would need a manual ledger check.
6. `npm test` includes `tests/alpaca.test.js`, which runs against an in-process fake Alpaca (`tests/helpers/fakeAlpaca.js`); it has not been run against the real Alpaca servers (no keys here). Do a first run with your paper keys using the Postman flow in your guide.

## Assumptions to confirm with the client (the PDF is ambiguous)

1. **Equity bonus amount** = tier % x the Level-2 equity maintained that month (e.g. $10,000 -> 1% -> $100). The PDF gives only percentages.
2. **"Failure"** = a daily check where Level-2 equity is below the tier the IB held at the first check of the month; max one per day; the 3rd means no bonus. The bonus % uses the *lowest* equity seen in the month ("maintained the whole month"). Warnings are exposed as `warnings` (1, 2) and status `Forfeited` (3).
3. **"24-Hour Revenue Commission"** is the Revenue-Link commission total (what the existing admin screens show), not company P&L.
4. **Revenue profit case:** for every unlocked level, that upline pays its % of the user's profit to the user (so a user can receive up to 50% extra). Upline wallets may go negative for these deductions.
5. **Dummy dollars:** the amount is entered by the admin when approving a Marketing Account (or granted later); the PDF gives no default.
6. **Copy trading / PAM:** the PDF defines viewing + configuring (profit cut %, timeline conditions, profit share %, monthly return %). Nothing computes or pays profit/returns yet; that needs the actual payout rules.
7. **Deposits** are created as *Pending* and credited on admin approval; plug a payment gateway into `services/transactions.js` when you have one.

## Before production

- Real MT5: implement your bridge against `services/mt5.js` (`MT5_API_URL`) and have it push trades/equity to the integration endpoints. Until `MT5_API_URL` is set, Add/Minus **Equity** only updates the cached equity (logged as simulated).
- Use a MongoDB **replica set** (e.g. Atlas) with backups, serve over HTTPS, set a strong `JWT_SECRET` and `CORS_ORIGINS`.
- Not built (not in the PDF): email/SMS verification, password reset, KYC document upload, notifications. *Login as user* returns `{ token, url }`; the user app needs an `/impersonate?token=` page that stores the token.
