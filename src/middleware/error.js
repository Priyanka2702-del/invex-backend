const { ZodError } = require('zod');
const env = require('../config/env');

const notFound = (req, res) => res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) return res.status(400).json({ message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), issues: err.issues });
  if (err.name === 'ValidationError') return res.status(400).json({ message: err.message });
  if (err.name === 'CastError') return res.status(400).json({ message: `Invalid ${err.path}` });
  if (err.code === 11000) return res.status(409).json({ message: `Already exists: ${Object.keys(err.keyPattern || {}).join(', ')}` });
  if (err.status) return res.status(err.status).json({ message: err.message, details: err.details });
  console.error(err);
  res.status(500).json({ message: env.isProd ? 'Internal server error' : err.message });
}
module.exports = { notFound, errorHandler };
