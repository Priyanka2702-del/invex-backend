const test = require('node:test');
const assert = require('node:assert/strict');
const { rankForTeamDeposit, autoRankDecision, nextRankProgress } = require('../src/logic/rank');
const { equityTierFor, evaluateEquityMonth } = require('../src/logic/equity');
const { calcRebate, calcRevenue, levelUnlocked, rebateRate, revenueRate } = require('../src/logic/commission');

test('§2.3 system rank thresholds (team deposit)', () => {
  assert.equal(rankForTeamDeposit(9999), null);
  assert.equal(rankForTeamDeposit(10000), 'Master');
  assert.equal(rankForTeamDeposit(19999), 'Master');
  assert.equal(rankForTeamDeposit(20000), 'Royal');
  assert.equal(rankForTeamDeposit(40000), 'Empire'); // doc example
  assert.equal(rankForTeamDeposit(70000), 'Ambassador');
  assert.equal(rankForTeamDeposit(100000), 'Crown Ambassador');
  assert.equal(rankForTeamDeposit(5_000_000), 'Crown Ambassador');
});

test('§3.1 rank is lifetime: auto never downgrades', () => {
  // team deposit dropped to 15k but user already holds Empire -> no change
  assert.equal(autoRankDecision({ current: 'Empire', source: 'auto' }, 15000), undefined);
  // upgrade works
  assert.equal(autoRankDecision({ current: 'Master', source: 'auto' }, 45000), 'Empire');
  assert.equal(autoRankDecision({ current: null, source: 'auto' }, 10000), 'Master');
});

test('§8.9 manual rank is never overridden automatically', () => {
  assert.equal(autoRankDecision({ current: 'Master', source: 'manual' }, 100000), undefined);
  assert.equal(autoRankDecision({ current: null, source: 'manual' }, 100000), undefined);
});

test('rank progress', () => {
  assert.deepEqual(nextRankProgress(15000, 'Master'), { next: 'Royal', remaining: 5000, percent: 50 });
  assert.equal(nextRankProgress(150000, 'Crown Ambassador').next, null);
});

test('§3.3 equity tiers (Level 2 equity)', () => {
  assert.equal(equityTierFor(9999), null);
  assert.equal(equityTierFor(10000).pct, 1);
  assert.equal(equityTierFor(19999).pct, 1);
  assert.equal(equityTierFor(20000).pct, 2);
  assert.equal(equityTierFor(39999).pct, 2);
  assert.equal(equityTierFor(40000).pct, 3);
  assert.equal(equityTierFor(70000).pct, 4);
  assert.equal(equityTierFor(99999).pct, 4);
  assert.equal(equityTierFor(100000).pct, 5);
});

test('§3.4 bonus % comes from maintained equity, not rank ($10k equity => 1% even for an Ambassador)', () => {
  const r = evaluateEquityMonth({ maintained: 10000, failureCount: 0 });
  assert.equal(r.pct, 1);
  assert.equal(r.bonus, 100);
});

test('§3.5 warnings and forfeiture', () => {
  assert.equal(evaluateEquityMonth({ maintained: 40000, failureCount: 0 }).status, 'Qualified');
  assert.equal(evaluateEquityMonth({ maintained: 40000, failureCount: 1 }).status, 'Warning');
  assert.equal(evaluateEquityMonth({ maintained: 40000, failureCount: 2 }).status, 'Warning');
  const third = evaluateEquityMonth({ maintained: 40000, failureCount: 3 });
  assert.equal(third.status, 'Forfeited');
  assert.equal(third.bonus, 0);
  assert.equal(evaluateEquityMonth({ maintained: 5000, failureCount: 0 }).status, 'Not qualified');
});

test('§8.7 default rebate/revenue structure and per-user overrides', () => {
  assert.equal(rebateRate({}, 0), 10);
  assert.equal(rebateRate({}, 4), 5);
  assert.equal(revenueRate({}, 0), 30);
  assert.equal(rebateRate({ customIb: { rebate: [12, 6] } }, 1), 6);
  assert.equal(rebateRate({ customIb: { rebate: [12, 6] } }, 2), 5); // falls back to default
  assert.equal(calcRebate(10, 2.5), 25);
});

test('§7.2 level unlocking by IB rank', () => {
  assert.equal(levelUnlocked('Basic', 1), true);
  assert.equal(levelUnlocked('Basic', 2), false);
  assert.equal(levelUnlocked('Starter', 2), true);
  assert.equal(levelUnlocked('Prime', 3), true);
  assert.equal(levelUnlocked('Crown', 5), false);
  assert.equal(levelUnlocked('Master', 5), true);
});

test('§7.3 revenue: loss -> Account Plus, profit -> Account Minus (doc example: $100 @ 30% = $30)', () => {
  assert.deepEqual(calcRevenue(-100, 30), { amount: 30, accountPlus: 30, accountMinus: 0 });
  assert.deepEqual(calcRevenue(100, 30), { amount: 30, accountPlus: 0, accountMinus: 30 });
  assert.equal(calcRevenue(-33.33, 5).amount, 1.67);
});
