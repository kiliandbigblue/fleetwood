import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchCursorUsage,
  formatUsd,
  parseCursorPeriod,
  sumOnDemandCents,
} from '../src/cursorUsage.ts';

const NOW = 1_789_032_000;

/**
 * A real `GetCurrentPeriodUsage` payload, trimmed but otherwise verbatim.
 *
 * Recorded 2026-09-10 against a Team seat: included $20 at 100%, bonus $230.72
 * (ignored), seat on-demand $192.80. Keep this honest — the whole point of the
 * parse is not to confuse bonus with what the seat actually billed.
 */
const PERIOD = {
  billingCycleStart: '1787917225000',
  billingCycleEnd: '1790595625000',
  planUsage: {
    totalSpend: 25072,
    includedSpend: 2000,
    bonusSpend: 23072,
    limit: 2000,
    remainingBonus: false,
    autoPercentUsed: 100,
    apiPercentUsed: 100,
    totalPercentUsed: 100,
  },
  spendLimitUsage: {
    totalSpend: 29311,
    pooledLimit: 330000,
    pooledUsed: 29311,
    pooledRemaining: 300689,
    individualUsed: 19280,
    limitType: 'team',
  },
  displayMessage: "You've hit your usage limit",
};

test('included is the $20 allotment, not totalSpend and not bonus', () => {
  const usage = parseCursorPeriod(PERIOD, NOW);
  assert.equal(usage?.includedLimitCents, 2000);
  assert.equal(usage?.includedSpendCents, 2000);
  assert.equal(usage?.includedUtilization, 1);
  // The number that would have been wrong: $250.72 of included+bonus.
  assert.notEqual(usage?.seatCents, 25072);
});

test('seat is individualUsed, not the team pool and not bonus', () => {
  const usage = parseCursorPeriod(PERIOD, NOW);
  assert.equal(usage?.seatCents, 19280);
  assert.equal(usage?.resetsAt, 1_790_595_625);
  assert.equal(usage?.fetchedAt, NOW);
  assert.equal(usage?.todayCents, undefined);
});

test('a half-spent included allotment is a fraction of the limit', () => {
  const usage = parseCursorPeriod(
    {
      ...PERIOD,
      planUsage: { ...PERIOD.planUsage, includedSpend: 500, totalPercentUsed: 25 },
    },
    NOW,
  );
  assert.equal(usage?.includedUtilization, 0.25);
});

test('missing planUsage yields nothing rather than a zeroed gauge', () => {
  assert.equal(parseCursorPeriod({}, NOW), undefined);
  assert.equal(parseCursorPeriod(null, NOW), undefined);
  assert.equal(parseCursorPeriod('nope', NOW), undefined);
});

test('a solo plan with no spendLimitUsage still shows included, seat at zero', () => {
  const usage = parseCursorPeriod({ planUsage: PERIOD.planUsage, billingCycleEnd: PERIOD.billingCycleEnd }, NOW);
  assert.equal(usage?.seatCents, 0);
  assert.equal(usage?.includedUtilization, 1);
});

test('on-demand today ignores included-in-business retail cents', () => {
  const cents = sumOnDemandCents([
    {
      kind: 'USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS',
      isChargeable: true,
      chargedCents: 58.48,
    },
    {
      kind: 'USAGE_EVENT_KIND_USAGE_BASED',
      isChargeable: true,
      chargedCents: 33.85,
    },
    {
      kind: 'USAGE_EVENT_KIND_USAGE_BASED',
      isChargeable: false,
      chargedCents: 10,
    },
  ]);
  assert.equal(Math.round(cents), 34);
});

test('formatUsd keeps cents when the bill has them', () => {
  assert.equal(formatUsd(19280), '$192.80');
  assert.equal(formatUsd(595), '$5.95');
  assert.equal(formatUsd(600), '$6');
});

test('the feature is inert until a token command is configured', async () => {
  assert.equal(await fetchCursorUsage({}), undefined);
  assert.equal(await fetchCursorUsage({ tokenCommand: '   ' }), undefined);
});

test('a token command that fails yields nothing rather than throwing', async () => {
  assert.equal(await fetchCursorUsage({ tokenCommand: 'exit 1' }), undefined);
  assert.equal(await fetchCursorUsage({ tokenCommand: 'echo ""' }), undefined);
});
