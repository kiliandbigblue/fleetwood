import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isHidden,
  isPinned,
  nameWithHidden,
  nameWithOrder,
  nameWithPin,
  parseSessionName,
  planReorder,
  sameSession,
  sessionLabel,
  sortSessions,
} from '../src/sessionOrder.ts';

test('a slot prefix is read off the name and hidden', () => {
  assert.deepEqual(parseSessionName('20-atlas'), { order: 20, pinned: false, hidden: false, label: 'atlas' });
  assert.equal(sessionLabel('20-atlas'), 'atlas');
  // Zero-padded, so the fleet sorts as text in tmux's own listings too.
  assert.deepEqual(parseSessionName('05-fleetwood'), {
    order: 5,
    pinned: false,
    hidden: false,
    label: 'fleetwood',
  });
});

test('a pin is a + in front of the slot, and is hidden with it', () => {
  assert.deepEqual(parseSessionName('+20-atlas'), { order: 20, pinned: true, hidden: false, label: 'atlas' });
  assert.equal(sessionLabel('+20-atlas'), 'atlas');
  assert.equal(isPinned('+20-atlas'), true);
  assert.equal(isPinned('20-atlas'), false);
  // A pin needs no slot: the tier is the opinion, the number is optional.
  assert.deepEqual(parseSessionName('+HOME'), { pinned: true, hidden: false, label: 'HOME' });
  // And a session literally called `+` is called `+`, not a nameless pin.
  assert.deepEqual(parseSessionName('+'), { pinned: false, hidden: false, label: '+' });
});

test('pinning keeps the slot, and renumbering keeps the pin', () => {
  assert.equal(nameWithPin('20-atlas', true), '+20-atlas');
  assert.equal(nameWithPin('+20-atlas', false), '20-atlas');
  assert.equal(nameWithPin('atlas', true), '+atlas');
  // Idempotent, so a toggle that raced with another one cannot write `++atlas`.
  assert.equal(nameWithPin('+atlas', true), '+atlas');
  // A reorder must not quietly unpin the sessions it renumbers.
  assert.equal(nameWithOrder('+20-atlas', 30), '+30-atlas');
  assert.equal(nameWithOrder('+20-atlas', undefined), '+atlas');
});

test('a pinned session is still the same session', () => {
  // Same stake as the slot: a find-or-create path that missed this would open a
  // second session for a project whose card someone had pinned.
  assert.equal(sameSession('+20-fleetwood', 'fleetwood'), true);
  assert.equal(sameSession('+fleetwood', '20-fleetwood'), true);
  assert.equal(sameSession('+fleetwood', 'atlas'), false);
});

test('a hidden session is a - in front of everything else', () => {
  assert.deepEqual(parseSessionName('-20-atlas'), {
    order: 20,
    pinned: false,
    hidden: true,
    label: 'atlas',
  });
  assert.equal(sessionLabel('-20-atlas'), 'atlas');
  assert.equal(isHidden('-20-atlas'), true);
  assert.equal(isHidden('20-atlas'), false);
  // Outside the pin, because it outranks it: a session that is not in the list
  // is not in a tier of it either.
  assert.deepEqual(parseSessionName('-+20-atlas'), {
    order: 20,
    pinned: true,
    hidden: true,
    label: 'atlas',
  });
  // A session literally called `-` is called `-`, like `+` and `20-` before it.
  assert.deepEqual(parseSessionName('-'), { pinned: false, hidden: false, label: '-' });
  // And a name that genuinely starts with a dash keeps the rest of itself.
  assert.deepEqual(parseSessionName('--wip'), { pinned: false, hidden: true, label: '-wip' });
});

test('hiding keeps the tier and the slot, and both survive the way back', () => {
  assert.equal(nameWithHidden('20-atlas', true), '-20-atlas');
  assert.equal(nameWithHidden('-20-atlas', false), '20-atlas');
  // The point of putting the marker outside the pin: hiding a pinned session
  // does not unpin it, so unhiding returns it to the tier it was in.
  assert.equal(nameWithHidden('+20-atlas', true), '-+20-atlas');
  assert.equal(nameWithHidden('-+20-atlas', false), '+20-atlas');
  // Idempotent, for the reason `nameWithPin` is: no `--atlas` from a race.
  assert.equal(nameWithHidden('-atlas', true), '-atlas');
  assert.equal(nameWithHidden('atlas', false), 'atlas');
  // And the other two markers must not quietly unhide what they renumber or
  // repin — a reorder inside the fold cannot put a card back on screen.
  assert.equal(nameWithOrder('-+20-atlas', 30), '-+30-atlas');
  assert.equal(nameWithOrder('-20-atlas', undefined), '-atlas');
  assert.equal(nameWithPin('-20-atlas', true), '-+20-atlas');
  assert.deepEqual(planReorder(['-10-atlas', '-20-HOME'], '-20-HOME', 'up'), [
    { from: '-20-HOME', to: '-10-HOME' },
    { from: '-10-atlas', to: '-20-atlas' },
  ]);
});

test('a hidden session is still the same session', () => {
  // The loudest version of the stake the slot and the pin share: without this,
  // `ensureTaskSession` would not find a hidden session and would build a second
  // one beside it, which nobody would see.
  assert.equal(sameSession('-fleetwood', 'fleetwood'), true);
  assert.equal(sameSession('-+20-fleetwood', '20-fleetwood'), true);
  assert.equal(sameSession('-fleetwood', 'atlas'), false);
});

test('a name that merely begins with digits keeps every word of itself', () => {
  // The reason a slot is two digits: one would eat this name's first word.
  assert.deepEqual(parseSessionName('2-factor-auth'), { pinned: false, hidden: false, label: '2-factor-auth' });
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

test('pinned sessions are held on top, whatever the rest are doing', () => {
  const fleet = [
    session('30-atlas', { needsAttention: true, agents: [{}] }),
    session('+HOME'),
    session('graphy', { agents: [{}] }),
    session('+20-fleetwood'),
  ];
  // The pins first and in their own order — an unnumbered pin after a numbered
  // one — then the unpinned tier, ranked as it always was.
  assert.deepEqual(names(sortSessions(fleet)), ['+20-fleetwood', '+HOME', '30-atlas', 'graphy']);
});

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

test('a move stays inside its own tier, so the pins are never jumped', () => {
  const order = ['+10-fleetwood', '+20-atlas', '30-graphy', '40-proto'];

  // "To the top" for an unpinned session means the top of the unpinned list —
  // the row under the pins. Aiming higher would renumber the fleet and change
  // nothing on screen, since the sort puts the pins back in front.
  assert.deepEqual(planReorder(order, '40-proto', 'top'), [
    { from: '40-proto', to: '30-proto' },
    { from: '30-graphy', to: '40-graphy' },
  ]);
  // Already at the top of its tier, and already at the bottom of the pins.
  assert.deepEqual(planReorder(order, '30-graphy', 'top'), []);
  assert.deepEqual(planReorder(order, '30-graphy', 'up'), []);
  assert.deepEqual(planReorder(order, '+20-atlas', 'bottom'), []);
  assert.deepEqual(planReorder(order, '+20-atlas', 'down'), []);

  // Inside the pinned tier the moves work exactly as they do anywhere else, and
  // the plan carries every pin across.
  assert.deepEqual(planReorder(order, '+20-atlas', 'top'), [
    { from: '+20-atlas', to: '+10-atlas' },
    { from: '+10-fleetwood', to: '+20-fleetwood' },
  ]);
});
