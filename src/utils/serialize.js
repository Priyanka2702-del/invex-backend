/** Small helper so list endpoints return the same envelope: { data, total, page, limit }. */
const paged = (data, total, { page, limit }) => ({ data, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
module.exports = { paged, esc };
/** Optional ?from=&to= filter on a date field (no params => no filter). */
const HttpError = require('./httpError');
function rangeFilter(query, field = 'createdAt') {
  if (!query.from && !query.to) return {};
  const f = query.from ? new Date(query.from) : null, t = query.to ? new Date(query.to) : null;
  if ((f && isNaN(f)) || (t && isNaN(t))) throw new HttpError(400, 'Invalid from/to date');
  return { [field]: { ...(f && { $gte: f }), ...(t && { $lte: t }) } };
}
module.exports.rangeFilter = rangeFilter;

/** First/last activity per user for one page of users (kept out of the big $group so it stays cheap and portable). */
async function datesByUser(Model, ids) {
  const rows = await Model.find({ userId: { $in: ids } }).select('userId createdAt').sort({ createdAt: 1 }).lean();
  const m = new Map();
  for (const r of rows) { const d = m.get(r.userId) || { firstAt: r.createdAt, lastAt: r.createdAt }; d.lastAt = r.createdAt; m.set(r.userId, d); }
  return m;
}
module.exports.datesByUser = datesByUser;
