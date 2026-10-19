const router = require('express').Router();
const { AuditLog } = require('../../models');
const asyncHandler = require('../../utils/asyncHandler');
const { page } = require('../../utils/pagination');
const { paged, esc, rangeFilter } = require('../../utils/serialize');

router.get('/', asyncHandler(async (req, res) => {
  const p = page(req.query), q = { ...rangeFilter(req.query, 'timestamp') };
  for (const k of ['admin', 'module', 'userId']) if (req.query[k]) q[k] = req.query[k];
  if (req.query.search) { const r = new RegExp(esc(req.query.search), 'i'); q.$or = [{ action: r }, { description: r }]; }
  const [rows, total] = await Promise.all([AuditLog.find(q).sort({ timestamp: -1 }).skip(p.skip).limit(p.limit), AuditLog.countDocuments(q)]);
  res.json(paged(rows, total, p));
}));
module.exports = router;
