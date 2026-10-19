const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const env = require('./config/env');
const { notFound, errorHandler } = require('./middleware/error');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind a reverse proxy (needed for correct client IPs in rate limiting)
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } })); // uploads are shown on other origins
app.use(cors({ origin: env.corsOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(path.resolve(env.UPLOAD_DIR), { maxAge: '7d', index: false, dotfiles: 'deny' }));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: env.NODE_ENV === 'test' ? 1000 : 20, standardHeaders: true, legacyHeaders: false, message: { message: 'Too many attempts, try again later' } });
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api/admin-auth/login', loginLimiter);
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/register', loginLimiter);

app.use('/api/admin-auth', require('./routes/admin/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/integrations', require('./routes/integrations'));
app.use('/api', require('./routes/user'));

app.use(notFound);
app.use(errorHandler);
module.exports = app;
