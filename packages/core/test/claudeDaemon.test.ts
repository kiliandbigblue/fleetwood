import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoster, workerAlive } from '../src/claudeDaemon.ts';
import { buildProcTable, parsePs } from '../src/procScan.ts';

/**
 * Verbatim `~/.claude/daemon/roster.json` from this machine — one daemon-hosted
 * session, launched from a tmux pane with `/`, still running — with the auth
 * tokens replaced. The fields fleetwood reads are `sessionId`, `pid`, `cwd` and
 * `cliVersion`; the rest is here so a shape change shows up as a test failure
 * rather than as a silently empty fleet.
 */
const REAL_ROSTER = `{
 "proto": 1,
 "supervisorPid": 7694,
 "updatedAt": 1785805200814,
 "workers": {
  "21ad03a2": {
   "pid": 85935,
   "procStart": "Mon Aug  3 18:31:52 2026",
   "sessionId": "21ad03a2-af31-4e13-82e7-1c58aca3156c",
   "rendezvousSock": "/tmp/cc-daemon-501/e7c1ae69/rv/21ad03a2.sock",
   "ptySock": "/tmp/cc-daemon-501/e7c1ae69/spare/9261afdf.pty.sock",
   "cliVersion": "2.1.220",
   "startedAt": 1785781912116,
   "attempt": 1,
   "cwd": "/Users/kiliandemeulemeester/projects/fleetwood",
   "dispatch": { "proto": 1, "short": "21ad03a2", "source": "slash" },
   "rvAuth": "redacted",
   "ptyAuth": "redacted"
  }
 }
}`;

/** Verbatim `ps` rows for that worker and its pooled hook helper. */
const PS = `
85935     1    17:52:12 claude bg-pty-host --bg-pty-host /tmp/cc-daemon-501/e7c1ae69/spare/9261afdf.pty.sock 200 50 -- /Users/kiliandemeulemeester/.local/share/claude/versions/2.1.220 --bg-spare /tmp/x.claim.sock
85944 85935    17:52:12 claude bg-spare --bg-spare /tmp/cc-daemon-501/e7c1ae69/spare/9261afdf.claim.sock
`;

function procTable(text: string): ReturnType<typeof buildProcTable> {
  // parsePs wants pcpu too; ps rows above omit it for readability.
  const withCpu = text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => l.replace(/^(\s*\d+\s+\d+\s+)/, '$1 0.0 '))
    .join('\n');
  return buildProcTable(parsePs(withCpu));
}

test('the roster maps a session id onto the process the agent really runs in', () => {
  const workers = parseRoster(REAL_ROSTER);
  const worker = workers.get('21ad03a2-af31-4e13-82e7-1c58aca3156c');
  assert.ok(worker, 'keyed by full session id, which is what hooks report');
  assert.equal(worker.pid, 85935);
  assert.equal(worker.cwd, '/Users/kiliandemeulemeester/projects/fleetwood');
  assert.equal(worker.cliVersion, '2.1.220');
});

test('an unreadable or reshaped roster means "no daemon sessions", never a crash', () => {
  // Another program's private file: fleetwood degrades, it does not take the
  // panel down.
  assert.equal(parseRoster('').size, 0);
  assert.equal(parseRoster('{').size, 0, 'half-written read');
  assert.equal(parseRoster('null').size, 0);
  assert.equal(parseRoster('{"proto":1}').size, 0, 'no workers key');
  assert.equal(parseRoster('{"workers":[]}').size, 0);
  assert.equal(parseRoster('{"workers":{"a":{"pid":1}}}').size, 0, 'no session id to key on');
  assert.equal(parseRoster('{"workers":{"a":{"sessionId":"s"}}}').size, 0, 'no pid to check');
});

test('a rostered worker counts as alive only while its process is really there', () => {
  const worker = parseRoster(REAL_ROSTER).get('21ad03a2-af31-4e13-82e7-1c58aca3156c');
  assert.ok(worker);
  assert.equal(workerAlive(procTable(PS), worker), true);

  // The roster keeps entries for workers that exited, so a missing pid is dead…
  assert.equal(workerAlive(procTable('99999 1 00:01 zsh'), worker), false);
  // …and a recycled pid running something else is dead too.
  assert.equal(workerAlive(procTable('85935 1 00:01 /opt/homebrew/bin/rg pattern'), worker), false);
});
