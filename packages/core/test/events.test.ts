import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeToolUse, normalize, reduce, reduceAll } from '../src/events.ts';
import type { AgentEvent, AgentState, SpoolRecord } from '../src/events.ts';

/** Build a spool record the way the shell hook does. */
function record(payload: Record<string, unknown>, over: Partial<SpoolRecord> = {}): SpoolRecord {
  return {
    source: 'claude',
    pane: '%3',
    tmux: '/tmp/tmux-501/default,123,1',
    arg: '',
    recvAt: 1_000,
    env: { child: '0', sessionId: 'env-session', pid: '4242' },
    payload,
    ...over,
  };
}

function claudeEvent(name: string, extra: Record<string, unknown> = {}): AgentEvent {
  const e = normalize(record({ session_id: 's1', hook_event_name: name, ...extra }));
  assert.ok(e, `expected ${name} to normalize`);
  return e;
}

test('normalize maps a Claude Code tool call to a readable activity', () => {
  const e = claudeEvent('PreToolUse', {
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test --filter core' },
    cwd: '/Users/k/projects/atlas',
  });
  assert.equal(e.tool, 'claude');
  assert.equal(e.event, 'PreToolUse');
  assert.equal(e.sessionId, 's1');
  assert.equal(e.pane, '%3');
  assert.equal(e.cwd, '/Users/k/projects/atlas');
  assert.equal(e.activity, 'Bash: pnpm test --filter core');
  assert.equal(e.hookPid, 4242);
});

test('normalize prefers the payload session id over the inherited env one', () => {
  // The env var belongs to whichever agent spawned the shell, not necessarily
  // the agent that fired the hook.
  assert.equal(claudeEvent('SessionStart').sessionId, 's1');
  const noPayloadId = normalize(record({ hook_event_name: 'SessionStart' }));
  assert.equal(noPayloadId?.sessionId, 'env-session');
});

test('normalize rejects records it cannot interpret', () => {
  assert.equal(normalize(record({})), undefined);
  assert.equal(normalize(record({ hook_event_name: 'SomeFutureHook' })), undefined);
  assert.equal(normalize({ source: 'claude', recvAt: 1 }), undefined);
});

test('normalize reads cursor events from argv, mapped onto Claude vocabulary', () => {
  const e = normalize({
    source: 'cursor',
    pane: '%9',
    arg: 'beforeShellExecution',
    recvAt: 5,
    payload: { command: 'rm -rf build', conversation_id: 'conv-7' },
  });
  assert.equal(e?.tool, 'cursor');
  assert.equal(e?.event, 'PreToolUse');
  assert.equal(e?.sessionId, 'conv-7');
  assert.equal(e?.activity, 'Shell: rm -rf build');
});

test('cursor stop carries per-turn token fields; other cursor events do not', () => {
  const stop = normalize({
    source: 'cursor',
    pane: '%9',
    arg: 'stop',
    recvAt: 10,
    payload: {
      conversation_id: 'conv-9',
      model: 'grok-4.5',
      transcript_path: '/tmp/conv-9.jsonl',
      input_tokens: 191_551,
      output_tokens: 1_789,
      cache_read_tokens: 176_032,
      cache_write_tokens: 0,
    },
  });
  assert.equal(stop?.event, 'Stop');
  assert.equal(stop?.transcript, '/tmp/conv-9.jsonl');
  assert.deepEqual(stop?.turnUsage, {
    model: 'grok-4.5',
    inputTokens: 191_551,
    outputTokens: 1_789,
    cacheReadTokens: 176_032,
    cacheWriteTokens: 0,
  });

  const submit = normalize({
    source: 'cursor',
    arg: 'beforeSubmitPrompt',
    recvAt: 9,
    payload: { conversation_id: 'conv-9', prompt: 'hi', input_tokens: 99 },
  });
  // Token fields on a non-stop event are ignored — only stop is authoritative.
  assert.equal(submit?.turnUsage, undefined);
});

test('cursor stop without token fields is still a stop, just unpriced', () => {
  const e = normalize({
    source: 'cursor',
    arg: 'stop',
    recvAt: 11,
    payload: { conversation_id: 'conv-10', status: 'completed', loop_count: 0 },
  });
  assert.equal(e?.event, 'Stop');
  assert.equal(e?.turnUsage, undefined);
});

test('cursor stop turns accumulate spend on the agent state', () => {
  const first = normalize({
    source: 'cursor',
    arg: 'stop',
    recvAt: 20,
    payload: {
      conversation_id: 'c1',
      model: 'composer-2.5',
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
  });
  const second = normalize({
    source: 'cursor',
    arg: 'stop',
    recvAt: 30,
    payload: {
      conversation_id: 'c1',
      model: 'composer-2.5',
      input_tokens: 500_000,
      output_tokens: 0,
      cache_read_tokens: 400_000,
      cache_write_tokens: 0,
    },
  });
  assert.ok(first && second);
  const state = fold([first, second]);
  assert.ok(state.usage);
  // First turn: 1M in @ $3 + 1M out @ $15 = $18.
  // Second: 100k fresh @ $3 + 400k read @ $0.20 = $0.30 + $0.08 = $0.38.
  assert.equal(state.usage.costUsd, 18.38);
  assert.equal(state.usage.messages, 2);
  assert.equal(state.usage.inputTokens, 1_100_000);
  assert.equal(state.usage.cacheReadTokens, 400_000);
  assert.deepEqual(state.usage.models, ['composer-2.5']);
});

test('describeToolUse summarises the tools that matter, falls back safely', () => {
  assert.equal(describeToolUse('Edit', { file_path: '/a/b/procScan.ts' }), 'Edit: procScan.ts');
  assert.equal(describeToolUse('Task', { description: 'audit auth flow' }), 'Task: audit auth flow');
  assert.equal(describeToolUse('Grep', { pattern: 'TODO' }), 'Grep: TODO');
  assert.equal(describeToolUse('SomeMcpTool', {}), 'SomeMcpTool');
  assert.equal(describeToolUse('Bash', undefined), 'Bash');
});

// --- status folding --------------------------------------------------------

function fold(events: AgentEvent[]): AgentState {
  const states = reduceAll(events);
  const state = [...states.values()][0];
  assert.ok(state);
  return state;
}

test('a full turn walks idle → working → idle', () => {
  const state = fold([
    { ...claudeEvent('SessionStart'), at: 100 },
    { ...claudeEvent('UserPromptSubmit', { prompt: 'fix the flaky test' }), at: 110 },
    { ...claudeEvent('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pnpm test' } }), at: 111 },
    { ...claudeEvent('PostToolUse', { tool_name: 'Bash' }), at: 120 },
    { ...claudeEvent('Stop'), at: 130 },
  ]);

  assert.equal(state.status, 'idle');
  assert.equal(state.since, 130);
  assert.equal(state.turns, 1);
  assert.equal(state.toolCalls, 1);
  // Activity survives Stop, so an idle agent still shows what it just did.
  assert.equal(state.activity, 'Bash: pnpm test');
  assert.equal(state.currentTool, undefined);
});

test('a permission request is the status that means "you are the bottleneck"', () => {
  const state = fold([
    { ...claudeEvent('UserPromptSubmit', { prompt: 'ship it' }), at: 200 },
    { ...claudeEvent('PermissionRequest', { tool_name: 'Write', tool_input: { file_path: '/x.ts' } }), at: 205 },
  ]);
  assert.equal(state.status, 'blocked_permission');
  assert.equal(state.since, 205);
  assert.equal(state.currentTool, 'Write');
  assert.equal(state.activity, 'Write: x.ts');
});

test('Notification means waiting on the human, distinctly from a permission prompt', () => {
  const state = fold([{ ...claudeEvent('Notification', { message: 'waiting for your input' }), at: 300 }]);
  assert.equal(state.status, 'blocked_input');
  assert.equal(state.activity, 'waiting for your input');
});

test('subagents are counted without disturbing the parent status', () => {
  const state = fold([
    { ...claudeEvent('UserPromptSubmit'), at: 400 },
    { ...claudeEvent('SubagentStart'), at: 401 },
    { ...claudeEvent('SubagentStart'), at: 402 },
    { ...claudeEvent('SubagentStop'), at: 403 },
  ]);
  assert.equal(state.subagents, 1);
  assert.equal(state.status, 'working');
  assert.equal(state.since, 400, 'subagent churn must not reset the working clock');
});

test('subagent counts never go negative', () => {
  const state = fold([
    { ...claudeEvent('SessionStart'), at: 500 },
    { ...claudeEvent('SubagentStop'), at: 501 },
  ]);
  assert.equal(state.subagents, 0);
});

test('failures are counted while the agent keeps working', () => {
  const state = fold([
    { ...claudeEvent('PreToolUse', { tool_name: 'Bash' }), at: 600 },
    { ...claudeEvent('PostToolUseFailure', { tool_name: 'Bash' }), at: 601 },
  ]);
  assert.equal(state.errorCount, 1);
  assert.equal(state.status, 'working');
});

test('SessionEnd is terminal', () => {
  const state = fold([
    { ...claudeEvent('UserPromptSubmit'), at: 700 },
    { ...claudeEvent('SessionEnd'), at: 701 },
  ]);
  assert.equal(state.status, 'gone');
});

test('the status clock only resets when the status actually changes', () => {
  const state = fold([
    { ...claudeEvent('UserPromptSubmit'), at: 800 },
    { ...claudeEvent('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/a.ts' } }), at: 850 },
    { ...claudeEvent('PostToolUse', { tool_name: 'Read' }), at: 860 },
  ]);
  assert.equal(state.status, 'working');
  assert.equal(state.since, 800, 'still the same working spell');
});

test('out-of-order delivery does not let an old event overwrite a newer status', () => {
  // The spool is ordered by mtime, but a slow hook can still land late.
  const stop = { ...claudeEvent('Stop'), at: 900 };
  const older = { ...claudeEvent('PreToolUse', { tool_name: 'Bash' }), at: 890 };
  const state = fold([stop, older]);
  assert.equal(state.status, 'idle', 'the newer Stop wins');
  assert.equal(state.toolCalls, 1, 'but the late event is still counted');
});

test('reduce is pure — folding does not mutate the previous state', () => {
  const first = reduce(undefined, { ...claudeEvent('SessionStart'), at: 10 });
  const snapshot = structuredClone(first);
  reduce(first, { ...claudeEvent('UserPromptSubmit'), at: 20 });
  assert.deepEqual(first, snapshot);
});

test('agents are keyed separately per session and per tool', () => {
  const states = reduceAll([
    { ...claudeEvent('SessionStart'), at: 1, sessionId: 'a' },
    { ...claudeEvent('SessionStart'), at: 2, sessionId: 'b' },
    { ...claudeEvent('SessionStart'), at: 3, sessionId: 'a', tool: 'cursor' },
  ]);
  assert.deepEqual([...states.keys()].sort(), ['claude:a', 'claude:b', 'cursor:a']);
});

test('an event with neither session id nor pane is dropped rather than merged', () => {
  const states = reduceAll([{ ...claudeEvent('SessionStart'), sessionId: undefined, pane: undefined }]);
  assert.equal(states.size, 0);
});

test('a pane-only agent still gets a stable key', () => {
  const states = reduceAll([{ ...claudeEvent('SessionStart'), sessionId: undefined }]);
  assert.deepEqual([...states.keys()], ['claude:pane:%3']);
});
