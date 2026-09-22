import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offsetOfLine, parseInline, parseNotes, toggleCheckbox } from '../src/notesMarkdown.ts';
import { describeNotes } from '../src/notesFormat.ts';

/*
 * The note as it is actually typed at the end of a day — four-space indents,
 * boxes under boxes, a bare line under a bullet — read back as the shape it was
 * written in. Every line keeps its index, because a click on the drawn line
 * has to find the typed one.
 */

const shape = (text: string): string[] =>
  parseNotes(text).map((line) => {
    const box = line.check === 'open' ? '[ ]' : line.check === 'done' ? '[x]' : '';
    const words = line.spans.map((span) => span.text).join('');
    return `${line.index}:${line.kind}${line.kind === 'blank' ? '' : `@${line.level}`}${line.marker ?? ''}${box} ${words}`.trimEnd();
  });

test('four-space nesting reads as levels, with the box off the front of each line', () => {
  const note = [
    '- Cross dock:',
    '    - [ ] Finish the UI tests and put in review',
    '      - [ ] use a receipt that does not receive expired product',
    '- Stock transfer',
    '    - [x] Migration',
    '    - Inbound shipment creation',
  ].join('\n');
  assert.deepEqual(shape(note), [
    '0:item@0 Cross dock:',
    '1:item@1[ ] Finish the UI tests and put in review',
    '2:item@2[ ] use a receipt that does not receive expired product',
    '3:item@0 Stock transfer',
    '4:item@1[x] Migration',
    '5:item@1 Inbound shipment creation',
  ]);
});

test('two-space and tabbed notes come out with the same shape', () => {
  assert.deepEqual(shape('- a\n  - b\n    - c\n- d'), ['0:item@0 a', '1:item@1 b', '2:item@2 c', '3:item@0 d']);
  assert.deepEqual(shape('- a\n\t- b\n- c'), ['0:item@0 a', '1:item@1 b', '2:item@0 c']);
});

test('a line indented between two levels lands on the nearer one rather than making a third', () => {
  // Typed with the wrong shiftwidth: still one level under `a`, not a level of its own.
  assert.deepEqual(shape('- a\n    - b\n  - c'), ['0:item@0 a', '1:item@1 b', '2:item@1 c']);
});

test('headings, ordered items, blanks and prose', () => {
  const note = ['# power off 22/09', '', '1. first', '2) second', '   said more about it', 'and back on the margin'].join(
    '\n',
  );
  assert.deepEqual(shape(note), [
    '0:heading@1 power off 22/09',
    '1:blank',
    '2:item@01. first',
    '3:item@02) second',
    '4:text@1 said more about it',
    '5:text@0 and back on the margin',
  ]);
});

test('a heading closes whatever list was open above it', () => {
  assert.deepEqual(shape('- a\n    - b\n## next\n- c'), ['0:item@0 a', '1:item@1 b', '2:heading@2 next', '3:item@0 c']);
});

test('an asterisk that opens nothing is text', () => {
  assert.deepEqual(shape('**not a bullet**\n* but this is'), ['0:text@0 not a bullet', '1:item@0 but this is']);
});

test('inline: code, strong, em, links and bare urls, and nothing that is not paired', () => {
  assert.deepEqual(parseInline('ship `order_type` to **graphy** _tomorrow_'), [
    { kind: 'text', text: 'ship ' },
    { kind: 'code', text: 'order_type' },
    { kind: 'text', text: ' to ' },
    { kind: 'strong', text: 'graphy' },
    { kind: 'text', text: ' ' },
    { kind: 'em', text: 'tomorrow' },
  ]);
  assert.deepEqual(parseInline('see [the PR](https://github.com/x/y/pull/1) or https://loom.com/a/b.'), [
    { kind: 'text', text: 'see ' },
    { kind: 'link', text: 'the PR', href: 'https://github.com/x/y/pull/1' },
    { kind: 'text', text: ' or ' },
    { kind: 'link', text: 'https://loom.com/a/b', href: 'https://loom.com/a/b' },
    { kind: 'text', text: '.' },
  ]);
  // snake_case is a name, not emphasis; a lone star is a star.
  assert.deepEqual(parseInline('ORDER_TYPE_B2B == order_type * 2'), [
    { kind: 'text', text: 'ORDER_TYPE_B2B == order_type * 2' },
  ]);
  assert.deepEqual(parseInline(''), []);
});

test('ticking a box edits that one line and nothing else', () => {
  const note = '- a\n    - [ ] b\n    - [x] c\n- d';
  assert.equal(toggleCheckbox(note, 1), '- a\n    - [x] b\n    - [x] c\n- d');
  assert.equal(toggleCheckbox(note, 2), '- a\n    - [ ] b\n    - [ ] c\n- d');
  // A line without a box, or past the end, is left as it was.
  assert.equal(toggleCheckbox(note, 0), note);
  assert.equal(toggleCheckbox(note, 3), note);
  assert.equal(toggleCheckbox(note, 9), note);
  // Ticked back and forth is the note you started with — an upper-case X too.
  assert.equal(toggleCheckbox(toggleCheckbox(note, 1), 1), note);
  assert.equal(toggleCheckbox('- [X] shouted', 0), '- [ ] shouted');
});

test('the start of a line, as a cursor offset', () => {
  const note = 'ab\ncde\n\nf';
  assert.equal(offsetOfLine(note, 0), 0);
  assert.equal(offsetOfLine(note, 1), 3);
  assert.equal(offsetOfLine(note, 2), 7);
  assert.equal(offsetOfLine(note, 3), 8);
  // Past the end is the end.
  assert.equal(offsetOfLine(note, 12), note.length);
});

test('the folded first line drops a box the way it drops a bullet', () => {
  assert.deepEqual(describeNotes('- [ ] call about the loom\n- [x] done'), { head: 'call about the loom', lines: 2 });
});
