require('dotenv').config();
const { z } = require('zod');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(5001),
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/invex'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3001'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:5001'),
  UPLOAD_DIR: z.string().default('uploads'),
  MT5_WEBHOOK_KEY: z.string().default(''),
  MT5_API_URL: z.string().optional(), // optional: your MT5 bridge (used to apply Add/Minus Equity)
  MT5_API_KEY: z.string().optional(),
  USER_APP_URL: z.string().default('http://localhost:3000'),
  ENABLE_CRON: z.enum(['true', 'false']).default('true'),
  /* Alpaca (Trading API + Market Data API). Keys stay on the server only. */
  ALPACA_KEY_ID: z.string().optional(),
  ALPACA_SECRET_KEY: z.string().optional(),
  ALPACA_TRADING_URL: z.string().url().default('https://paper-api.alpaca.markets'),
  ALPACA_DATA_URL: z.string().url().default('https://data.alpaca.markets'),
  ALPACA_FEED: z.enum(['iex', 'sip']).default('iex'),            // iex = free feed
  ALPACA_ALLOW_LIVE: z.enum(['true', 'false']).default('false'), // safety: live host is refused unless 'true'
  ALPACA_SYNC_INTERVAL_MS: z.coerce.number().int().min(0).default(5000), // 0 disables order polling
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:\n', parsed.error.issues.map((i) => ` - ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}
const env = parsed.data;
env.corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
env.isProd = env.NODE_ENV === 'production';
module.exports = env;
