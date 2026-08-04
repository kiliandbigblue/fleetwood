import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addUsage,
  describeUsage,
  formatCost,
  formatMoney,
  formatTokens,
  normalizeModel,
  readTranscriptUsage,
  resetCache,
  sumUsage,
} from '../src/usage.ts';

/**
 * Fixtures mirror the real shape of a Claude Code transcript line, including the
 * two things that make the naive reading wrong: the per-content-block repetition
 * of one message, and the 5m/1h split inside `cache_creation`.
 */
function line(args: {
  id: string;
  model?: string;
  input?: number;
  output?: number;
  write5m?: number;
  write1h?: number;
  writeFlat?: number;
  read?: number;
  sidechain?: boolean;
}): string {
  const usage: Record<string, unknown> = {
    input_tokens: args.input ?? 0,
    output_tokens: args.output ?? 0,
    cache_read_input_tokens: args.read ?? 0,
  };
  if (args.writeFlat !== undefined) {
    usage.cache_creation_input_tokens = args.writeFlat;
  } else {
    usage.cache_creation_input_tokens = (args.write5m ?? 0) + (args.write1h ?? 0);
    usage.cache_creation = {
      ephemeral_5m_input_tokens: args.write5m ?? 0,
      ephemeral_1h_input_tokens: args.write1h ?? 0,
    };
  }
  return `${JSON.stringify({
    type: 'assistant',
    requestId: `req_${args.id}`,
    isSidechain: args.sidechain ?? false,
    message: { id: `msg_${args.id}`, model: args.model ?? 'claude-opus-5', usage },
  })}\n`;
}

async function withTranscript(
  body: (path: string) => Promise<void>,
  initial = '',
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fw-usage-'));
  const path = join(dir, 'session.jsonl');
  try {
    await writeFile(path, initial, 'utf8');
    resetCache();
    await body(path);
  } finally {
    resetCache();
    await rm(dir, { recursive: true, force: true });
  }
}

test('prices input, output and both cache tiers off the model rate', async () => {
  // Opus 5 at $5/$25 per MTok: 1M in, 1M out, 1M written 5m (1.25x), 1M written
  // 1h (2x), 1M read (0.1x) → 5 + 25 + 6.25 + 10 + 0.5.
  await withTranscript(
    async (path) => {
      const usage = await readTranscriptUsage(path);
      assert.ok(usage);
      assert.equal(usage.costUsd, 46.75);
      assert.equal(usage.inputTokens, 1_000_000);
      assert.equal(usage.outputTokens, 1_000_000);
      assert.equal(usage.cacheWriteTokens, 2_000_000);
      assert.equal(usage.cacheReadTokens, 1_000_000);
      assert.equal(usage.totalTokens, 5_000_000);
      assert.equal(usage.unpriced, false);
    },
    line({
      id: 'a',
      input: 1_000_000,
      output: 1_000_000,
      write5m: 1_000_000,
      write1h: 1_000_000,
      read: 1_000_000,
    }),
  );
});

test('an older transcript without the cache_creation split bills writes at the 5m rate', async () => {
  await withTranscript(
    async (path) => {
      const usage = await readTranscriptUsage(path);
      // 1M written at 5 * 1.25 — not the 1h rate, which would double it.
      assert.equal(usage?.costUsd, 6.25);
      assert.equal(usage?.cacheWriteTokens, 1_000_000);
    },
    line({ id: 'a', writeFlat: 1_000_000 }),
  );
});

test('rates differ per model, and a turn may switch models mid-session', async () => {
  await withTranscript(
    async (path) => {
      const usage = await readTranscriptUsage(path);
      // 1M output on opus-5 ($25) plus 1M on haiku-4-5 ($5).
      assert.equal(usage?.costUsd, 30);
      assert.deepEqual(usage?.models, ['claude-opus-5', 'claude-haiku-4-5']);
    },
    line({ id: 'a', model: 'claude-opus-5', output: 1_000_000 }) +
      line({ id: 'b', model: 'claude-haiku-4-5', output: 1_000_000 }),
  );
});

test('one message repeated per content block is counted once', async () => {
  // This is the bug that would otherwise roughly double every figure on screen:
  // thinking, text and two tool_use blocks each get their own line carrying the
  // same cumulative usage under the same message id.
  const repeated = line({ id: 'a', output: 1_000_000 }).repeat(4);
  await withTranscript(async (path) => {
    const usage = await readTranscriptUsage(path);
    assert.equal(usage?.messages, 1);
    assert.equal(usage?.outputTokens, 1_000_000);
    assert.equal(usage?.costUsd, 25);
  }, repeated);
});

test('subagent (sidechain) turns count toward the session that spawned them', async () => {
  await withTranscript(
    async (path) => {
      const usage = await readTranscriptUsage(path);
      assert.equal(usage?.messages, 2);
      assert.equal(usage?.outputTokens, 2_000_000);
    },
    line({ id: 'a', output: 1_000_000 }) +
      line({ id: 'b', output: 1_000_000, sidechain: true }),
  );
});

test('an unknown model contributes tokens but is flagged rather than priced', async () => {
  await withTranscript(
    async (path) => {
      const usage = await readTranscriptUsage(path);
      assert.equal(usage?.unpriced, true);
      assert.equal(usage?.outputTokens, 1_500_000);
      // Only the priced half of the work is charged.
      assert.equal(usage?.costUsd, 12.5);
    },
    line({ id: 'a', model: 'claude-opus-5', output: 500_000 }) +
      line({ id: 'b', model: 'claude-opus-9-unreleased', output: 1_000_000 }),
  );
});

test('synthetic messages are skipped entirely', async () => {
  await withTranscript(
    async (path) => {
      const usage = await readTranscriptUsage(path);
      assert.equal(usage?.messages, 0);
      assert.equal(usage?.costUsd, 0);
      assert.equal(usage?.unpriced, false);
    },
    line({ id: 'a', model: '<synthetic>', output: 1_000_000 }),
  );
});

test('normalizes bedrock prefixes, dated snapshots and the 1m marker', () => {
  assert.equal(normalizeModel('anthropic.claude-opus-5'), 'claude-opus-5');
  assert.equal(normalizeModel('claude-opus-4-5-20251101'), 'claude-opus-4-5');
  assert.equal(normalizeModel('claude-opus-5[1m]'), 'claude-opus-5');
  assert.equal(normalizeModel('claude-opus-5'), 'claude-opus-5');
});

test('a dated snapshot id is priced like its alias', async () => {
  await withTranscript(
    async (path) => {
      const usage = await readTranscriptUsage(path);
      assert.equal(usage?.unpriced, false);
      assert.equal(usage?.costUsd, 15);
    },
    line({ id: 'a', model: 'claude-sonnet-4-5-20250929', output: 1_000_000 }),
  );
});

test('appended lines accumulate without re-counting what was already folded', async () => {
  await withTranscript(
    async (path) => {
      const first = await readTranscriptUsage(path);
      assert.equal(first?.messages, 1);
      assert.equal(first?.outputTokens, 1_000_000);

      await appendFile(path, line({ id: 'b', output: 2_000_000 }), 'utf8');
      const second = await readTranscriptUsage(path);
      assert.equal(second?.messages, 2);
      assert.equal(second?.outputTokens, 3_000_000);

      // No growth: the poll re-reads nothing and the totals stand.
      const third = await readTranscriptUsage(path);
      assert.equal(third?.messages, 2);
      assert.equal(third?.outputTokens, 3_000_000);
    },
    line({ id: 'a', output: 1_000_000 }),
  );
});

test('a message split across two reads is folded once, not twice', async () => {
  // The dedupe set has to outlive a single read: a block of the same message
  // arriving in the next append must not add its usage again.
  await withTranscript(
    async (path) => {
      await readTranscriptUsage(path);
      await appendFile(path, line({ id: 'a', output: 1_000_000 }), 'utf8');
      const usage = await readTranscriptUsage(path);
      assert.equal(usage?.messages, 1);
      assert.equal(usage?.outputTokens, 1_000_000);
    },
    line({ id: 'a', output: 1_000_000 }),
  );
});

test('a truncated file resets rather than reading on from a stale offset', async () => {
  await withTranscript(
    async (path) => {
      const before = await readTranscriptUsage(path);
      assert.equal(before?.messages, 2);

      // Session cleared, or the path reused for a different session.
      await writeFile(path, line({ id: 'c', output: 1_000_000 }), 'utf8');
      const after = await readTranscriptUsage(path);
      assert.equal(after?.messages, 1);
      assert.equal(after?.outputTokens, 1_000_000);
    },
    line({ id: 'a', output: 1_000_000 }) + line({ id: 'b', output: 1_000_000 }),
  );
});

test('a half-written trailing line is skipped, then folded once complete', async () => {
  const complete = line({ id: 'a', output: 1_000_000 });
  const partial = line({ id: 'b', output: 2_000_000 });
  const cut = partial.slice(0, 30);
  await withTranscript(
    async (path) => {
      const first = await readTranscriptUsage(path);
      // The fragment has no newline, so it is left unread rather than parsed.
      assert.equal(first?.messages, 1);
      assert.equal(first?.outputTokens, 1_000_000);

      await appendFile(path, partial.slice(30), 'utf8');
      const second = await readTranscriptUsage(path);
      assert.equal(second?.messages, 2);
      assert.equal(second?.outputTokens, 3_000_000);
    },
    complete + cut,
  );
});

test('unparseable and usage-free lines are absorbed, not thrown', async () => {
  await withTranscript(
    async (path) => {
      const usage = await readTranscriptUsage(path);
      assert.equal(usage?.messages, 1);
      assert.equal(usage?.outputTokens, 1_000_000);
    },
    '{"type":"mode"}\nnot json at all\n{"type":"user","message":{"role":"user"}}\n' +
      line({ id: 'a', output: 1_000_000 }),
  );
});

test('an empty transcript folds to zero, a missing one to nothing at all', async () => {
  await withTranscript(async (path) => {
    const empty = await readTranscriptUsage(path);
    // Started but not yet spent — zero is the honest answer.
    assert.equal(empty?.messages, 0);
    assert.equal(empty?.costUsd, 0);

    // Absent means "we cannot know", which the UI renders as no figure.
    assert.equal(await readTranscriptUsage(join(path, 'nope.jsonl')), undefined);
  });
});

test('money reads at a glance across four orders of magnitude', () => {
  assert.equal(formatMoney(0), '$0');
  // A fraction of a cent is not free, and "$0.00" would say it was.
  assert.equal(formatMoney(0.004), '<$0.01');
  assert.equal(formatMoney(0.26), '$0.26');
  assert.equal(formatMoney(4.678), '$4.68');
  // Cents stop earning their place once a session is into three figures.
  assert.equal(formatMoney(101.05), '$101');
});

test('token counts collapse to one significant unit', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(847), '847');
  assert.equal(formatTokens(12_400), '12k');
  assert.equal(formatTokens(1_600_000), '1.6M');
  assert.equal(formatTokens(130_900_000), '130.9M');
});

test('an unpriced figure is marked as a floor, in the badge and the tooltip', () => {
  const base = {
    inputTokens: 21_000,
    outputTokens: 34_000,
    cacheWriteTokens: 290_000,
    cacheReadTokens: 1_300_000,
    totalTokens: 1_645_000,
    costUsd: 4.67,
    unpriced: false,
    models: ['claude-opus-5'],
    messages: 12,
  };

  assert.equal(formatCost(base), '$4.67');
  assert.equal(formatCost({ ...base, unpriced: true }), '~$4.67');

  const title = describeUsage(base);
  assert.equal(
    title,
    '1.6M tokens · 21k in · 34k out · 290k cache write · 1.3M cache read · claude-opus-5 · estimated at API rates',
  );
  assert.match(describeUsage({ ...base, unpriced: true }), /at least this much/);
});

test('sumUsage rolls agents up and stays undefined when none reported', () => {
  assert.equal(sumUsage([undefined, undefined]), undefined);

  const a = {
    inputTokens: 1,
    outputTokens: 2,
    cacheWriteTokens: 3,
    cacheReadTokens: 4,
    totalTokens: 10,
    costUsd: 1.5,
    unpriced: false,
    models: ['claude-opus-5'],
    messages: 1,
  };
  const b = { ...a, costUsd: 2.5, unpriced: true, models: ['claude-haiku-4-5'] };

  const total = sumUsage([a, undefined, b]);
  assert.equal(total?.costUsd, 4);
  assert.equal(total?.totalTokens, 20);
  assert.equal(total?.messages, 2);
  // One unpriced model makes the whole rollup a floor.
  assert.equal(total?.unpriced, true);
  assert.deepEqual(total?.models, ['claude-opus-5', 'claude-haiku-4-5']);

  // Same model on both sides is listed once.
  assert.deepEqual(addUsage(a, a).models, ['claude-opus-5']);
});
