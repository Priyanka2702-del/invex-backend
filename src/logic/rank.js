const { SYSTEM_RANKS } = require('../constants');

/** Highest system rank whose Total Team Deposit threshold is met, or null. */
function rankForTeamDeposit(total, ranks = SYSTEM_RANKS) {
  let found = null;
  for (const r of ranks) if (total >= r.minTeamDeposit) found = r.name;
  return found;
}
const rankIndex = (name, ranks = SYSTEM_RANKS) => ranks.findIndex((r) => r.name === name); // -1 = no rank

/**
 * Automatic evaluation. Ranks are LIFETIME: auto can only upgrade, never downgrade (§3.1).
 * A manually-set rank (source === 'manual') is owned by the admin and never touched automatically.
 * Returns the new rank name, or `undefined` for "no change".
 */
function autoRankDecision({ current, source }, teamDeposit, ranks = SYSTEM_RANKS) {
  if (source === 'manual') return undefined;
  const achieved = rankForTeamDeposit(teamDeposit, ranks);
  return rankIndex(achieved, ranks) > rankIndex(current, ranks) ? achieved : undefined;
}

function nextRankProgress(teamDeposit, current, ranks = SYSTEM_RANKS) {
  const next = ranks[rankIndex(current, ranks) + 1];
  if (!next) return { next: null, remaining: 0, percent: 100 };
  const prev = ranks[rankIndex(current, ranks)]?.minTeamDeposit ?? 0;
  const span = next.minTeamDeposit - prev;
  return {
    next: next.name,
    remaining: Math.max(next.minTeamDeposit - teamDeposit, 0),
    percent: Math.min(100, Math.max(0, Math.round(((teamDeposit - prev) / span) * 100))),
  };
}
module.exports = { rankForTeamDeposit, rankIndex, autoRankDecision, nextRankProgress };
