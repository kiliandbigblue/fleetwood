import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCursorChatId, findTrackedSessionId, resumeArgsFor } from '../src/resume.ts';
import type { AgentState } from '../src/events.ts';

function state(over: Partial<AgentState> & { key: string }): AgentState {
  return {
    tool: 'claude',
    status: 'idle',
    provenance: 'hook',
    since: 0,
    lastEventAt: 0,
    lastEvent: 'Stop',
    turns: 1,
    toolCalls: 0,
    errorCount: 0,
    subagents: 0,
    cwd: '/Users/k/tasks/flow',
    sessionId: 'abc',
    ...over,
  };
}

const CWD = '/Users/k/tasks/flow';

test('finds the sessionId last seen running this tool in this exact directory', () => {
  const id = findTrackedSessionId([state({ key: 'a', sessionId: 'sess-1' })], 'claude', CWD);
  assert.equal(id, 'sess-1');
});

test('picks the most recently active candidate when several match', () => {
  const states = [
    state({ key: 'a', sessionId: 'old', lastEventAt: 100 }),
    state({ key: 'b', sessionId: 'new', lastEventAt: 200 }),
  ];
  assert.equal(findTrackedSessionId(states, 'claude', CWD), 'new');
});

test('a different directory is not a match', () => {
  const states = [state({ key: 'a', cwd: '/Users/k/tasks/other' })];
  assert.equal(findTrackedSessionId(states, 'claude', CWD), undefined);
});

test('a gone agent is not resumed', () => {
  const states = [state({ key: 'a', status: 'gone' })];
  assert.equal(findTrackedSessionId(states, 'claude', CWD), undefined);
});

test('no sessionId means nothing to resume', () => {
  const states = [state({ key: 'a', sessionId: undefined })];
  assert.equal(findTrackedSessionId(states, 'claude', CWD), undefined);
});

test('now tool-agnostic: cursor states are found too, unlike the old claude-only gate', () => {
  const states = [state({ key: 'a', tool: 'cursor', sessionId: 'conv-1' })];
  assert.equal(findTrackedSessionId(states, 'cursor', CWD), 'conv-1');
});

// findCursorChatId: cursor-agent stores each conversation one level *inside*
// its chat (~/.cursor/chats/<chatId>/<conversationId>/meta.json) — the id
// hooks report names the inner directory, not the resumable one.
async function fixtureChatsDir(
  layout: Record<string, Record<string, { cwd: string } | 'unreadable'>>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fw-cursor-chats-'));
  for (const [chatId, conversations] of Object.entries(layout)) {
    for (const [conversationId, meta] of Object.entries(conversations)) {
      const dir = join(root, chatId, conversationId);
      await mkdir(dir, { recursive: true });
      if (meta === 'unreadable') continue; // no meta.json at all
      await writeFile(join(dir, 'meta.json'), JSON.stringify(meta), 'utf8');
    }
  }
  return root;
}

test('resolves a conversation id to the chat directory that contains it', async () => {
  const chatsDir = await fixtureChatsDir({
    'chat-a': { 'conv-1': { cwd: CWD } },
    'chat-b': { 'conv-2': { cwd: '/Users/k/tasks/other' } },
  });
  assert.equal(await findCursorChatId('conv-1', CWD, chatsDir), 'chat-a');
});

test('a conversation id that exists but ran somewhere else is not trusted', () => {
  return fixtureChatsDir({ 'chat-a': { 'conv-1': { cwd: '/Users/k/tasks/other' } } }).then(async (chatsDir) => {
    assert.equal(await findCursorChatId('conv-1', CWD, chatsDir), undefined);
  });
});

test('an unknown conversation id matches nothing', async () => {
  const chatsDir = await fixtureChatsDir({ 'chat-a': { 'conv-1': { cwd: CWD } } });
  assert.equal(await findCursorChatId('conv-missing', CWD, chatsDir), undefined);
});

test('a conversation directory with no readable meta.json is skipped, not crashed on', async () => {
  const chatsDir = await fixtureChatsDir({ 'chat-a': { 'conv-1': 'unreadable' } });
  assert.equal(await findCursorChatId('conv-1', CWD, chatsDir), undefined);
});

test('no chats directory at all is treated as no match', async () => {
  assert.equal(await findCursorChatId('conv-1', CWD, join(tmpdir(), 'fw-cursor-chats-missing')), undefined);
});

test('resumeArgsFor resumes claude directly by its tracked session id', async () => {
  const states = [state({ key: 'a', tool: 'claude', sessionId: 'sess-1' })];
  assert.deepEqual(await resumeArgsFor(states, 'claude', CWD), ['--resume', 'sess-1']);
});

test('resumeArgsFor translates cursor through its chat directory', async () => {
  const chatsDir = await fixtureChatsDir({ 'chat-a': { 'conv-1': { cwd: CWD } } });
  const states = [state({ key: 'a', tool: 'cursor', sessionId: 'conv-1' })];
  assert.deepEqual(await resumeArgsFor(states, 'cursor', CWD, chatsDir), ['--resume', 'chat-a']);
});

test('resumeArgsFor gives cursor nothing when the conversation cannot be translated', async () => {
  const chatsDir = await fixtureChatsDir({});
  const states = [state({ key: 'a', tool: 'cursor', sessionId: 'conv-1' })];
  assert.deepEqual(await resumeArgsFor(states, 'cursor', CWD, chatsDir), []);
});

test('resumeArgsFor has nothing for codex — unverified, so it is not guessed at', async () => {
  const states = [state({ key: 'a', tool: 'codex', sessionId: 'sess-1' })];
  assert.deepEqual(await resumeArgsFor(states, 'codex', CWD), []);
});

test('resumeArgsFor is empty with no tracked state at all', async () => {
  assert.deepEqual(await resumeArgsFor([], 'claude', CWD), []);
});
