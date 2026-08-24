import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentsInPane, buildProcTable, classify, parseElapsed, parsePs } from '../src/procScan.ts';

// Every string below is verbatim from `ps -Ao pid,ppid,pcpu,etime,command` on
// this machine, with one interactive Claude Code session running in tmux.
const REAL_CLAUDE_PANE_PROCESS =
  '/Users/kiliandemeulemeester/.local/share/claude/versions/2.1.220 --session-id 80762af1 --agent claude';
const REAL_CLAUDE_LAUNCHER = '/Users/kiliandemeulemeester/.local/bin/claude';
const REAL_CLAUDE_DAEMON =
  '/Users/kiliandemeulemeester/.local/bin/claude daemon run --origin transient --spawned-by {"label":"claude","cwd":"/Users/k","pid":78881}';
const REAL_CLAUDE_BG_PTY =
  'claude bg-pty-host --bg-pty-host /tmp/cc-daemon-501/e7c1ae69/spare/9261afdf.pty.sock 200 50 -- /Users/kiliandemeulemeester/.local/share/claude/versions/2.1.220 --bg-spare /tmp/x.claim.sock';
const REAL_CLAUDE_DESKTOP_APP = '/Applications/Claude.app/Contents/MacOS/Claude';
const REAL_CLAUDE_DESKTOP_HELPER =
  '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=gpu-process';

// Verbatim from a pane whose agent was started as `agent` (Cursor's current
// installer name) rather than `cursor-agent` — same binary, different argv0.
const REAL_CURSOR_AGENT_SHORT =
  '/Users/kiliandemeulemeester/.local/bin/agent --use-system-ca /Users/kiliandemeulemeester/.local/share/cursor-agent/versions/2026.08.11-e8db854/index.js --resume=9ee84b93-7ae9-4e78-8a4f-d9432388bb4d';

test('classify recognises the agent CLIs', () => {
  assert.equal(classify(REAL_CLAUDE_PANE_PROCESS), 'claude');
  assert.equal(classify(REAL_CLAUDE_LAUNCHER), 'claude');
  assert.equal(classify('/Users/k/.local/bin/cursor-agent'), 'cursor');
  assert.equal(classify('cursor-agent --resume'), 'cursor');
  assert.equal(classify(REAL_CURSOR_AGENT_SHORT), 'cursor');
  assert.equal(classify('/opt/homebrew/bin/codex'), 'codex');
});

test('classify does not treat an unrelated agent binary as cursor', () => {
  // The short Cursor name is just `agent`; without the share-dir path it must
  // not claim every process of that name.
  assert.equal(classify('/usr/bin/agent'), undefined);
  assert.equal(classify('/Users/k/.local/bin/agent --help'), undefined);
  assert.equal(classify('agent run something'), undefined);
});

test('classify rejects the decoys that share a Claude Code process tree', () => {
  // These are all descendants of the same pane as a real session. Counting them
  // would report five agents where there is one.
  assert.equal(classify(REAL_CLAUDE_DAEMON), undefined);
  assert.equal(classify(REAL_CLAUDE_BG_PTY), undefined);
  assert.equal(classify(REAL_CLAUDE_DESKTOP_APP), undefined);
  assert.equal(classify(REAL_CLAUDE_DESKTOP_HELPER), undefined);
});

test('classify does not match unrelated commands', () => {
  assert.equal(classify('zsh'), undefined);
  assert.equal(classify('/usr/bin/vim src/claude-notes.md'), undefined);
  assert.equal(classify('nvim packages/core/src/procScan.ts'), undefined);
  assert.equal(classify('tail -f claudelog'), undefined);
});

test('parseElapsed covers every ps duration shape', () => {
  assert.equal(parseElapsed('20:32'), 20 * 60 + 32);
  assert.equal(parseElapsed('06:08:51'), 6 * 3600 + 8 * 60 + 51);
  assert.equal(parseElapsed('2-06:08:51'), 2 * 86_400 + 6 * 3600 + 8 * 60 + 51);
  assert.equal(parseElapsed('00:01'), 1);
});

test('parsePs keeps argv containing spaces and JSON intact', () => {
  const stdout = [
    `85927 78881   7.1    20:32 ${REAL_CLAUDE_DAEMON}`,
    `78799     1  15.5 06:08:47 ${REAL_CLAUDE_PANE_PROCESS}`,
    '  501   1   0.0    01:00 zsh',
  ].join('\n');

  const rows = parsePs(stdout);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.pid, 85927);
  assert.equal(rows[0]?.ppid, 78881);
  assert.equal(rows[0]?.cpu, 7.1);
  assert.equal(rows[0]?.elapsedSeconds, 20 * 60 + 32);
  assert.equal(rows[0]?.command, REAL_CLAUDE_DAEMON);
  assert.equal(rows[2]?.command, 'zsh');
});

test('agentsInPane finds one agent per tool, outermost first', () => {
  // Shape of a real pane: zsh → claude → {daemon, bg-pty-host}
  const table = buildProcTable(
    parsePs(
      [
        `100   1   0.0 10:00 -zsh`,
        `200 100   5.0 09:00 ${REAL_CLAUDE_PANE_PROCESS}`,
        `300 200   1.0 08:00 ${REAL_CLAUDE_DAEMON}`,
        `400 300   0.5 08:00 ${REAL_CLAUDE_BG_PTY}`,
      ].join('\n'),
    ),
  );

  const agents = agentsInPane(table, 100);
  assert.equal(agents.length, 1);
  assert.equal(agents[0]?.tool, 'claude');
  assert.equal(agents[0]?.pid, 200);
  assert.equal(agents[0]?.cpu, 5.0);
});

test('agentsInPane reports two tools sharing one pane', () => {
  const table = buildProcTable(
    parsePs(
      [
        `100   1   0.0 10:00 -zsh`,
        `200 100   5.0 09:00 ${REAL_CLAUDE_PANE_PROCESS}`,
        `250 100   2.0 09:00 /Users/k/.local/bin/cursor-agent`,
      ].join('\n'),
    ),
  );
  assert.deepEqual(
    agentsInPane(table, 100)
      .map((a) => a.tool)
      .sort(),
    ['claude', 'cursor'],
  );
});

test('agentsInPane finds cursor when invoked as agent', () => {
  // Without this, a live Cursor session is reported gone: hooks still fire, but
  // process reconciliation finds nothing matching `cursor-agent` and kills the row.
  const table = buildProcTable(
    parsePs([`100   1   0.0 10:00 -zsh`, `200 100   5.0 09:00 ${REAL_CURSOR_AGENT_SHORT}`].join('\n')),
  );
  const agents = agentsInPane(table, 100);
  assert.equal(agents.length, 1);
  assert.equal(agents[0]?.tool, 'cursor');
  assert.equal(agents[0]?.pid, 200);
});

test('agentsInPane returns nothing for a plain shell', () => {
  const table = buildProcTable(parsePs('100   1   0.0 10:00 -zsh'));
  assert.deepEqual(agentsInPane(table, 100), []);
});

test('agentsInPane survives a cyclic or self-parented process table', () => {
  // Defensive: pid 1 reparenting and wrapped pids have produced cycles before.
  const table = buildProcTable(parsePs(['100 100 0.0 10:00 -zsh', '101 100 0.0 10:00 -zsh'].join('\n')));
  assert.deepEqual(agentsInPane(table, 100), []);
});
