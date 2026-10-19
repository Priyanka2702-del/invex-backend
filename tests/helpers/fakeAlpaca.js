/** In-process fake of the Alpaca endpoints from the Trading/Market Data guide, for tests (no network, no real keys). */
const http = require('http');

function createFakeAlpaca({ key = 'test-key', secret = 'test-secret' } = {}) {
  const state = {
    orders: new Map(), prices: { AAPL: 100, MSFT: 200, REJ: 50, DROP: 50, WHOLE: 10, HALT: 10 },
    assets: {
      AAPL: { status: 'active', tradable: true, class: 'us_equity', fractionable: true }, MSFT: { status: 'active', tradable: true, class: 'us_equity', fractionable: true },
      REJ: { status: 'active', tradable: true, class: 'us_equity', fractionable: true }, DROP: { status: 'active', tradable: true, class: 'us_equity', fractionable: true },
      WHOLE: { status: 'active', tradable: true, class: 'us_equity', fractionable: false }, HALT: { status: 'active', tradable: false, class: 'us_equity' },
      BTCUSD: { status: 'active', tradable: true, class: 'crypto' },
    },
    calls: {}, lastQuery: {}, seq: 0,
  };
  const hit = (k) => { state.calls[k] = (state.calls[k] || 0) + 1; };
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x'), parts = u.pathname.split('/').filter(Boolean);
      if (req.headers['apca-api-key-id'] !== key || req.headers['apca-api-secret-key'] !== secret) return send(res, 401, { message: 'unauthorized.' });
      state.lastQuery = Object.fromEntries(u.searchParams);
      const sym = (s) => String(s).toUpperCase();
      try {
        // ---- trading
        if (u.pathname === '/v2/account') { hit('account'); return send(res, 200, { status: 'ACTIVE', cash: '100000', equity: '100000', buying_power: '200000' }); }
        if (u.pathname === '/v2/clock') return send(res, 200, { is_open: true, next_open: '', next_close: '' });
        if (parts[0] === 'v2' && parts[1] === 'assets' && parts[2]) { const a = state.assets[sym(parts[2])]; return a ? send(res, 200, { symbol: sym(parts[2]), ...a }) : send(res, 404, { message: 'asset not found' }); }
        if (req.method === 'POST' && u.pathname === '/v2/orders') {
          hit('submit'); const b = JSON.parse(raw);
          if (b.symbol === 'REJ') return send(res, 422, { message: 'insufficient buying power' });
          if ([...state.orders.values()].some((o) => o.client_order_id === b.client_order_id)) return send(res, 422, { message: 'client_order_id must be unique' });
          const o = { id: `alp-${++state.seq}`, client_order_id: b.client_order_id, symbol: b.symbol, qty: b.qty, side: b.side, type: b.type, time_in_force: b.time_in_force, limit_price: b.limit_price || null, status: 'accepted', filled_qty: '0', filled_avg_price: null };
          state.orders.set(o.id, o);
          if (b.symbol === 'DROP') return req.socket.destroy(); // order exists at Alpaca but the response is lost
          return send(res, 200, o);
        }
        if (req.method === 'GET' && u.pathname === '/v2/orders:by_client_order_id') { const o = [...state.orders.values()].find((x) => x.client_order_id === u.searchParams.get('client_order_id')); return o ? send(res, 200, o) : send(res, 404, { message: 'order not found' }); }
        if (parts[0] === 'v2' && parts[1] === 'orders' && parts[2]) {
          const o = state.orders.get(parts[2]); if (!o) return send(res, 404, { message: 'order not found' });
          if (req.method === 'GET') { hit('getOrder'); return send(res, 200, o); }
          if (req.method === 'DELETE') { if (o.status === 'filled') return send(res, 422, { message: 'order is not cancelable' }); o.status = 'canceled'; return send(res, 204); }
        }
        // ---- market data
        if (parts[0] === 'v2' && parts[1] === 'stocks') {
          if (parts[2] === 'trades' && parts[3] === 'latest') { const trades = {}; for (const s of (u.searchParams.get('symbols') || '').split(',')) if (state.prices[s]) trades[s] = { p: state.prices[s] }; return send(res, 200, { trades }); }
          if (parts[2] === 'snapshots') return send(res, 200, {});
          const s = sym(parts[2]), p = state.prices[s];
          if (!p) return send(res, 404, { message: 'symbol not found' });
          if (parts[3] === 'quotes' && parts[4] === 'latest') { hit('quote'); return send(res, 200, { symbol: s, quote: { ap: p, bp: p - 0.05, as: 1, bs: 1, t: new Date().toISOString() } }); }
          if (parts[3] === 'trades' && parts[4] === 'latest') return send(res, 200, { symbol: s, trade: { p, s: 1, t: new Date().toISOString() } });
          if (parts[3] === 'bars' && !parts[4]) return send(res, 200, { symbol: s, bars: [{ t: '2026-10-14T04:00:00Z', o: p, h: p + 1, l: p - 1, c: p, v: 1000 }], next_page_token: null });
        }
        return send(res, 404, { message: 'not found' });
      } catch (e) { return send(res, 500, { message: e.message }); }
    });
  });

  return {
    state,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    /** simulate Alpaca filling an order (cumulative qty + average price) */
    fill(id, { qty, price, status }) { const o = state.orders.get(id); o.filled_qty = String(qty); o.filled_avg_price = String(price); o.status = status || (Number(qty) >= Number(o.qty) ? 'filled' : 'partially_filled'); },
  };
}
module.exports = { createFakeAlpaca };
