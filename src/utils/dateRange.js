const HttpError = require('./httpError');

/**
 * Parses ?from=&to= (ISO date or datetime). Powers the per-card Date & Time filter (§1.3).
 * defaultHours: when `from` is omitted, look back this many hours (e.g. 24 for the "24-hour" cards);
 * null means "all time".
 */
function parseRange(query = {}, { defaultHours = null } = {}) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : defaultHours ? new Date(to.getTime() - defaultHours * 3600e3) : new Date(0);
  if (isNaN(from) || isNaN(to)) throw new HttpError(400, 'Invalid from/to date');
  if (from > to) throw new HttpError(400, '"from" must be before "to"');
  return { from, to };
}
const ym = (d = new Date()) => d.toISOString().slice(0, 7);
module.exports = { parseRange, ym };
