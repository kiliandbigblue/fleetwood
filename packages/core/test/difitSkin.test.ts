import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { difitSkinCss, injectSkin, reviewPane, reviewPrompt, SKIN_PREFIX } from '../src/difitSkin.ts';
import type { DifitThread } from '../src/difitSkin.ts';
import { startReviewProxy } from '../src/difitProxy.ts';
import type { FleetAgent, FleetSession } from '../src/fleet.ts';
import { THEMES } from '../src/theme.ts';
import type { PaneInfo } from '../src/types.ts';

const illuminate = THEMES['helldivers-illuminate'].palette;

const DIFIT_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>difit - Git Diff Viewer</title>
    <script type="module" crossorigin src="/assets/index-CARSg-Mi.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-8wvzNuE_.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

test("the skin fills difit's variables from the palette, over its inline theme", () => {
  const css = difitSkinCss(illuminate);
  // difit sets these inline on <html>, so only `!important` wins.
  assert.match(css, /--color-github-bg-primary: #17151c !important;/);
  assert.match(css, /--color-github-text-primary: #e2deeb !important;/);
  assert.match(css, /--color-yellow-btn-text: #b892d4 !important;/);
  // Syntax follows helldivers.lua: functions in the accent, keywords in branch blue.
  assert.match(css, /\.token\.function[^{]*\{ color: #b892d4 !important;/);
  assert.match(css, /\.token\.keyword[^{]*\{ color: #8aafc4 !important;/);
});

test("the script lands before difit's module, the stylesheet after its own", () => {
  const page = injectSkin(DIFIT_PAGE);
  const script = page.indexOf(`${SKIN_PREFIX}/page.js`);
  const style = page.indexOf(`${SKIN_PREFIX}/skin.css`);
  // The script has to ask for dark before difit reads its appearance.
  assert.ok(script > 0 && script < page.indexOf('/assets/index-CARSg-Mi.js'));
  assert.ok(style > page.indexOf('/assets/index-8wvzNuE_.css') && style < page.indexOf('</head>'));
});

test('a page of a shape difit no longer serves is left alone', () => {
  assert.equal(injectSkin('<p>no head</p>'), '<p>no head</p>');
});

const thread = (over: Partial<DifitThread> = {}): DifitThread => ({
  id: 't1',
  filePath: 'packages/core/src/actions.ts',
  position: { side: 'new', line: 12 },
  codeSnapshot: { content: 'const a = 1;', language: 'typescript' },
  messages: [{ body: 'name this for what it holds' }],
  ...over,
});

test('the prompt reads like the nvim review did: where, the code, what was said', () => {
  const prompt = reviewPrompt([thread()], '/w/fleetwood-x', '/w/fleetwood-x');
  assert.equal(
    prompt,
    [
      'Review comments on your changes. Address each one, and say so if you disagree with any.',
      '',
      '## packages/core/src/actions.ts:12',
      '```typescript',
      'const a = 1;',
      '```',
      'name this for what it holds',
    ].join('\n'),
  );
});

test('a path is written from where the agent stands, and a range and the old side say so', () => {
  const t = thread({ position: { side: 'old', line: { start: 3, end: 5 } }, messages: [{ body: 'why?' }, { body: 'legacy', author: 'claude' }] });
  // An agent in the task folder sees the worktree as a subdirectory.
  const fromTask = reviewPrompt([t], '/tasks/x/fleetwood-x', '/tasks/x');
  assert.match(fromTask, /^## fleetwood-x\/packages\/core\/src\/actions\.ts:3-5 \(the code before your change\)$/m);
  assert.match(fromTask, /^Reply \(claude\):\nlegacy$/m);
  // One somewhere else entirely gets the absolute path.
  assert.match(reviewPrompt([t], '/tasks/x/fleetwood-x', '/elsewhere'), /^## \/tasks\/x\/fleetwood-x\/packages/m);
  // A one-line range reads as the line.
  assert.match(reviewPrompt([thread({ position: { side: 'new', line: { start: 7, end: 7 } } })], '/w'), /:7$/m);
});

function pane(paneId: string, cwd: string): PaneInfo {
  return {
    paneId,
    paneIndex: 1,
    windowId: '@1',
    sessionId: '$1',
    sessionName: 'task',
    pid: 100,
    command: '2.1.280',
    cwd,
    title: `agent ${paneId}`,
    active: false,
    width: 200,
    height: 50,
  };
}

function agent(paneId: string, cwd: string, over: Partial<FleetAgent> = {}): FleetAgent {
  return {
    key: `claude:${paneId}`,
    tool: 'claude',
    pane: paneId,
    cwd,
    status: 'idle',
    provenance: 'hook',
    since: 0,
    lastEventAt: 0,
    lastEvent: 'Stop',
    turns: 1,
    toolCalls: 1,
    errorCount: 0,
    subagents: 0,
    alive: true,
    nested: false,
    forSeconds: 60,
    ...over,
  };
}

function session(agents: FleetAgent[]): FleetSession {
  return {
    sessionId: '$1',
    name: 'task',
    attached: 1,
    createdAt: 1000,
    path: '/tasks/x',
    meta: {},
    windows: [
      {
        windowId: '@1',
        index: 1,
        name: 'main',
        active: true,
        panes: agents.map((a) => pane(a.pane as string, a.cwd as string)),
      },
    ],
    agents,
    needsAttention: false,
  };
}

test('a review goes back to the agent working in that worktree', () => {
  const sessions = [
    session([agent('%1', '/tasks/x/graphy-x'), agent('%2', '/tasks/x/reflow-x/pkg')]),
  ];
  assert.deepEqual(reviewPane(sessions, 'task', '/tasks/x/reflow-x'), {
    paneId: '%2',
    cwd: '/tasks/x/reflow-x/pkg',
    label: 'main: agent %2',
  });
  // No agent in it: the task's first Claude is the best guess left.
  assert.equal(reviewPane(sessions, 'task', '/tasks/x/proto-x')?.paneId, '%1');
});

test('only a Claude at a terminal, in the task’s own session, can take a review', () => {
  const nested = session([agent('%1', '/tasks/x', { nested: true }), agent('%2', '/tasks/x', { tool: 'cursor' })]);
  assert.equal(reviewPane([nested], 'task', '/tasks/x'), undefined);
  assert.equal(reviewPane([session([agent('%1', '/tasks/x')])], 'other', '/tasks/x'), undefined);
  assert.equal(reviewPane([session([agent('%1', '/tasks/x')])], undefined, '/tasks/x'), undefined);
});

/** A stand-in difit: its page, its comment API, and a heartbeat stream. */
async function fakeDifit(threads: DifitThread[]) {
  const deleted: string[] = [];
  let heartbeatClosed = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': DIFIT_PAGE.length });
      res.end(DIFIT_PAGE);
    } else if (url.pathname === '/api/comments-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 1, threads: threads.filter((t) => !deleted.includes(t.id)) }));
    } else if (url.pathname.startsWith('/api/comments/') && req.method === 'DELETE') {
      deleted.push(decodeURIComponent(url.pathname.slice('/api/comments/'.length)));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"success":true}');
    } else if (url.pathname === '/api/heartbeat') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: connected\n\n');
      req.on('close', () => {
        heartbeatClosed = true;
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    deleted,
    heartbeatClosed: () => heartbeatClosed,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

test('the proxy serves difit’s page skinned, and its own stylesheet beside it', async () => {
  const difit = await fakeDifit([]);
  const proxy = await startReviewProxy({ upstream: difit.url, palette: illuminate, send: async () => ({ ok: true, detail: '' }) });
  try {
    const page = await (await fetch(`${proxy.url}/`)).text();
    assert.match(page, /__fleetwood\/skin\.css/);
    const css = await (await fetch(`${proxy.url}${SKIN_PREFIX}/skin.css`)).text();
    assert.match(css, /#17151c/);
  } finally {
    proxy.close();
    difit.close();
  }
});

test('closing the tab’s heartbeat reaches difit through the proxy, so it still shuts down', async () => {
  const difit = await fakeDifit([]);
  const proxy = await startReviewProxy({ upstream: difit.url, palette: illuminate, send: async () => ({ ok: true, detail: '' }) });
  try {
    const controller = new AbortController();
    const res = await fetch(`${proxy.url}/api/heartbeat`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /connected/);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(difit.heartbeatClosed(), true);
  } finally {
    proxy.close();
    difit.close();
  }
});

test('sent comments are resolved; ones that only reached the clipboard stay', async () => {
  const threads = [thread({ id: 'a' }), thread({ id: 'b' })];

  const difit = await fakeDifit(threads);
  let given: DifitThread[] = [];
  const proxy = await startReviewProxy({
    upstream: difit.url,
    palette: illuminate,
    send: async (t) => {
      given = t;
      return { ok: true, detail: 'sent to main: agent' };
    },
  });
  try {
    const outcome = await (await fetch(`${proxy.url}${SKIN_PREFIX}/send`, { method: 'POST' })).json();
    assert.deepEqual(outcome, { ok: true, detail: 'sent to main: agent' });
    assert.deepEqual(given.map((t) => t.id), ['a', 'b']);
    assert.deepEqual(difit.deleted, ['a', 'b']);
  } finally {
    proxy.close();
    difit.close();
  }

  const kept = await fakeDifit(threads);
  const clipboardOnly = await startReviewProxy({
    upstream: kept.url,
    palette: illuminate,
    send: async () => ({ ok: true, detail: 'copied', clipboard: 'prompt' }),
  });
  try {
    const outcome = (await (await fetch(`${clipboardOnly.url}${SKIN_PREFIX}/send`, { method: 'POST' })).json()) as { clipboard?: string };
    assert.equal(outcome.clipboard, 'prompt');
    assert.deepEqual(kept.deleted, []);
  } finally {
    clipboardOnly.close();
    kept.close();
  }
});
