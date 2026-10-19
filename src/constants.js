/** Single source of truth for business rules from the Admin Panel requirements doc. */

// §2 System Rank — based on TOTAL TEAM DEPOSIT (whole downline), never personal deposit. Order matters.
const SYSTEM_RANKS = [
  { name: 'Master', minTeamDeposit: 10000 },
  { name: 'Royal', minTeamDeposit: 20000 },
  { name: 'Empire', minTeamDeposit: 40000 },
  { name: 'Ambassador', minTeamDeposit: 70000 },
  { name: 'Crown Ambassador', minTeamDeposit: 100000 },
];

// §7.2 IB (Revenue Link) ranks and the commission levels each one unlocks.
const IB_RANKS = ['Basic', 'Starter', 'Prime', 'Crown', 'Master'];
const IB_LEVELS = { Basic: 1, Starter: 2, Prime: 3, Crown: 4, Master: 5 };

const MAX_NETWORK_LEVELS = 5;
const REBATE_DEFAULT = [10, 5, 5, 5, 5]; // $ per lot, Level 1..5   (§8.7)
const REVENUE_DEFAULT = [30, 5, 5, 5, 5]; // % of loss/profit, Level 1..5 (§7.1)

// §3.3 Equity bonus tiers — monthly, Level 2 team current equity ONLY.
const EQUITY_TIERS = [
  { min: 10000, max: 19999.99, pct: 1 },
  { min: 20000, max: 39999.99, pct: 2 },
  { min: 40000, max: 69999.99, pct: 3 },
  { min: 70000, max: 99999.99, pct: 4 },
  { min: 100000, max: Infinity, pct: 5 },
];
const EQUITY_MAX_FAILURES = 3; // 1st & 2nd = warnings, 3rd = no bonus this month (§3.5)

const ACCOUNT_TYPES = ['standard', 'zero', 'ecn', 'cent'];
const LEVERAGES = ['1:25', '1:50', '1:100', '1:200', '1:300', '1:400', '1:500', '1:1000'];

const ACCOUNT_STATUSES = ['Active', 'Warned', 'Banned', 'Pending', 'Approved'];
const KYC_STATUSES = ['Approved', 'Pending', 'Unverified', 'Rejected'];
const REGISTRATION_TYPES = ['Direct', 'Rebate Link', 'Revenue Link'];

module.exports = {
  SYSTEM_RANKS, IB_RANKS, IB_LEVELS, MAX_NETWORK_LEVELS, REBATE_DEFAULT, REVENUE_DEFAULT,
  EQUITY_TIERS, EQUITY_MAX_FAILURES, ACCOUNT_TYPES, LEVERAGES, ACCOUNT_STATUSES, KYC_STATUSES, REGISTRATION_TYPES,
};
