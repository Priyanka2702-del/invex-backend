/* Idempotent first-run setup: super admin, the 5 system ranks, the 4 account types. Run: npm run seed */
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const env = require('../src/config/env');
const { Admin, SystemRank, AccountType, ensureIndexes } = require('../src/models');
const { SYSTEM_RANKS, ACCOUNT_TYPES } = require('../src/constants');

(async () => {
  await mongoose.connect(env.MONGODB_URI);
  await ensureIndexes();
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 10) {
    console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (min 10 chars) in .env to create the super admin.'); process.exit(1);
  }
  const email = env.ADMIN_EMAIL.toLowerCase();
  if (!(await Admin.exists({ email }))) {
    await Admin.create({ email, name: 'Super Admin', role: 'superadmin', isSuperAdmin: true, passwordHash: await bcrypt.hash(env.ADMIN_PASSWORD, 12) });
    console.log(`Created super admin ${email}`);
  } else console.log('Super admin already exists (password unchanged)');
  for (const [i, r] of SYSTEM_RANKS.entries()) await SystemRank.updateOne({ name: r.name }, { $setOnInsert: { name: r.name, minTeamDeposit: r.minTeamDeposit, position: i + 1 } }, { upsert: true });
  for (const k of ACCOUNT_TYPES) await AccountType.updateOne({ _id: k }, { $setOnInsert: { label: `${k[0].toUpperCase()}${k.slice(1)} Account`, leverage: '1:100', separatePerLot: 0 } }, { upsert: true });
  console.log('Ranks and account types ready.');
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
