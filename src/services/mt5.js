const env = require('../config/env');
const HttpError = require('../utils/httpError');
/**
 * MT5 gateway. MetaTrader's Manager/Web API is vendor-specific, so this talks to YOUR bridge over HTTP:
 *   POST {MT5_API_URL}/equity/adjust  { login, delta, comment }   -> 2xx on success
 * With MT5_API_URL unset the call is simulated (logged) so everything else works in development.
 * Inbound data (closed trades, equity) comes from the bridge via /api/integrations/mt5/*.
 */
async function adjustEquity(login, delta, comment = '') {
  if (!env.MT5_API_URL) {
    console.warn(`[mt5] SIMULATED equity adjust login=${login} delta=${delta} (${comment}) — set MT5_API_URL to apply for real`);
    return { simulated: true };
  }
  if (!login) throw new HttpError(409, 'User has no MT5 account linked');
  const res = await fetch(`${env.MT5_API_URL.replace(/\/$/, '')}/equity/adjust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.MT5_API_KEY || '' },
    body: JSON.stringify({ login, delta, comment }),
    signal: AbortSignal.timeout(10_000),
  }).catch((e) => { throw new HttpError(502, `MT5 bridge unreachable: ${e.message}`); });
  if (!res.ok) throw new HttpError(502, `MT5 bridge rejected the request (${res.status})`);
  return { simulated: false };
}
module.exports = { adjustEquity };
