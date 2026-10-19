function page(query, { defaultLimit = 50, maxLimit = 500 } = {}) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  const p = Math.max(parseInt(query.page, 10) || 1, 1);
  return { limit, skip: (p - 1) * limit, page: p };
}
module.exports = { page };
