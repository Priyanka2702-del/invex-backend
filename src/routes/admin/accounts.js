const router = require('express').Router();
const { z } = require('zod');
const { AccountType } = require('../../models');
const asyncHandler = require('../../utils/asyncHandler');
const HttpError = require('../../utils/httpError');
const audit = require('../../services/audit');
const { ACCOUNT_TYPES, LEVERAGES } = require('../../constants');

// §6 Separate Management: every account type is its OWN document, so editing one can never touch another.
router.get('/', asyncHandler(async (_req, res) => {
  const rows = await AccountType.find();
  res.json(ACCOUNT_TYPES.map((k) => rows.find((r) => r.id === k)).filter(Boolean));
}));
router.get('/:key', asyncHandler(async (req, res) => {
  const r = await AccountType.findById(req.params.key);
  if (!r) throw new HttpError(404, 'Account type not found');
  res.json({ ...r.toJSON(), allowedLeverages: LEVERAGES });
}));
router.put('/:key', asyncHandler(async (req, res) => {
  const b = z.object({ separatePerLot: z.number().min(0).max(100000), leverage: z.enum(LEVERAGES) }).partial().parse(req.body);
  const r = await AccountType.findOneAndUpdate({ _id: req.params.key }, { ...b, updatedBy: req.admin.name }, { new: true });
  if (!r) throw new HttpError(404, 'Account type not found');
  audit(req.admin, 'Account type updated', 'Separate Management', `${r.id}: ${JSON.stringify(b)}`);
  res.json(r);
}));
module.exports = router;
