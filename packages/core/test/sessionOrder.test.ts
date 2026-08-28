import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nameWithOrder,
  parseSessionName,
  planReorder,
  sameSession,
  sessionLabel,
  sortSessions,
} from '../src/sessionOrder.ts';

test('a slot prefix is read off the name and hidden', () => {
  assert.deepEqual(parseSessionName('20-atlas'), { order: 20, label: 'atlas' });
  assert.equal(sessionLabel('20-atlas'), 'atlas');
  // Zero-padded, so the fleet sorts as text in tmux's own listings too.
  assert.deepEqual(parseSessionName('05-fleetwood'), { order: 5, label: 'fleetwood' });
});

test('a name that merely begins with digits keeps every word of itself', () => {
  // The reason a slot is two digits: one would eat this name's first word.
  assert.deepEqual(parseSessionName('2-factor-auth'), { label: '2-factor-auth' });
  assert.equal(sessionLabel('2fa-login'), '2fa-login');
  // A session literally called `20-` has no label to show, so it is not a slot.
  assert.equal(sessionLabel('20-'), '20-');
});

test('putting a session in a slot replaces the slot it had', () => {
  assert.equal(nameWithOrder('atlas', 20), '20-atlas');
  assert.equal(nameWithOrder('20-atlas', 30), '30-atlas');
  assert.equal(nameWithOrder('20-atlas', undefined), 'atlas');
  assert.equal(nameWithOrder('atlas', 5), '05-atlas');
});

test('a session is the same session whatever slot it is in', () => {
  // Every find-or-create path depends on this: without it, opening a project
  // whose session has been ordered creates a second session for it.
  assert.equal(sameSession('20-fleetwood', 'fleetwood'), true);
  assert.equal(sameSession('20-fleetwood', '30-fleetwood'), true);
  assert.equal(sameSession('20-fleetwood', 'atlas'), false);
});

interface Fake {
  name: string;
  needsAttention: boolean;
  agents: unknown[];
}

function session(name: string, over: Partial<Fake> = {}): Fake {
  return { name, needsAttention: false, agents: [], ...over };
}

const names = (list: Fake[]): string[] => list.map((s) => s.name);

test('a numbered session stays in its slot, blocked agent or not', () => {
  const fleet = [
    session('20-atlas'),
    session('30-blocked', { needsAttention: true, agents: [{}] }),
    session('10-fleetwood'),
  ];
  // The whole point of ordering by hand: the list does not rearrange itself.
  assert.deepEqual(names(sortSessions(fleet)), ['10-fleetwood', '20-atlas', '30-blocked']);
});

test('unnumbered sessions follow, still ranked by what they are doing', () => {
  const fleet = [
    session('HOME'),
    session('20-atlas'),
    session('graphy', { agents: [{}] }),
    session('proto', { needsAttention: true }),
  ];
  assert.deepEqual(names(sortSessions(fleet)), ['20-atlas', 'proto', 'graphy', 'HOME']);
});

test('an unnumbered fleet is the list fleetwood always drew', () => {
  const fleet = [
    session('HOME'),
    session('graphy', { agents: [{}] }),
    session('proto', { needsAttention: true, agents: [{}] }),
    session('dotfiles'),
  ];
  // Attention, then agents, then tmux's own order — and HOME stays ahead of
  // dotfiles because that is the order tmux listed them in.
  assert.deepEqual(names(sortSessions(fleet)), ['proto', 'graphy', 'HOME', 'dotfiles']);
});

test('the first move numbers the whole fleet and swaps two neighbours', () => {
  const order = ['fleetwood', 'atlas', 'HOME'];
  assert.deepEqual(planReorder(order, 'HOME', 'up'), [
    { from: 'fleetwood', to: '10-fleetwood' },
    { from: 'HOME', to: '20-HOME' },
    { from: 'atlas', to: '30-atlas' },
  ]);
});

test('once numbered, a move renames only the two that swapped', () => {
  const order = ['10-fleetwood', '20-HOME', '30-atlas'];
  // The real name, prefix and all: the panel moves the session tmux knows about.
  assert.deepEqual(planReorder(order, '20-HOME', 'up'), [
    // The label is what carries over; the number is the slot it lands in.
    { from: '20-HOME', to: '10-HOME' },
    { from: '10-fleetwood', to: '20-fleetwood' },
  ]);
});

test('a session promoted out of the unnumbered tail gets a slot of its own', () => {
  // Numbering only the pair would not do: a slot outranks everything, so a
  // number given to HOME alone would send it past atlas as well.
  assert.deepEqual(planReorder(['10-atlas', 'graphy', 'HOME'], 'HOME', 'up'), [
    { from: 'HOME', to: '20-HOME' },
    { from: 'graphy', to: '30-graphy' },
  ]);
});

test('to the top and to the bottom move a session past everything at once', () => {
  const order = ['10-fleetwood', '20-atlas', '30-graphy', '40-proto'];
  assert.deepEqual(planReorder(order, '40-proto', 'top'), [
    { from: '40-proto', to: '10-proto' },
    { from: '10-fleetwood', to: '20-fleetwood' },
    { from: '20-atlas', to: '30-atlas' },
    { from: '30-graphy', to: '40-graphy' },
  ]);
  assert.deepEqual(planReorder(order, '10-fleetwood', 'bottom'), [
    { from: '20-atlas', to: '10-atlas' },
    { from: '30-graphy', to: '20-graphy' },
    { from: '40-proto', to: '30-proto' },
    { from: '10-fleetwood', to: '40-fleetwood' },
  ]);
});

test('nothing to do at either end of the list, or for a session that has gone', () => {
  const order = ['10-fleetwood', '20-atlas'];
  assert.deepEqual(planReorder(order, '10-fleetwood', 'up'), []);
  assert.deepEqual(planReorder(order, '20-atlas', 'down'), []);
  // Already there: "to the top" of a list it is already heading renames nothing,
  // rather than renumbering the fleet to say the same thing it already said.
  assert.deepEqual(planReorder(order, '10-fleetwood', 'top'), []);
  assert.deepEqual(planReorder(order, '20-atlas', 'bottom'), []);
  // The panel's list can be a second stale; a move against a dead session is a
  // no-op rather than a rename of whatever now sits in that position.
  assert.deepEqual(planReorder(order, 'graphy', 'up'), []);
});
