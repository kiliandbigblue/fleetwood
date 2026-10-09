import type { FileDiff } from './tourDiff.ts';

/** Lines of one side of a file, inclusive. `old` numbers only matter for removed lines. */
export interface Span {
  path: string;
  side: 'new' | 'old';
  start: number;
  end: number;
}

export interface RecapChange extends Span {
  /** The lines to show around it, on the same side: usually the enclosing function. */
  show?: { start: number; end: number };
  /** Mechanical changes only: why the file changed, in a line. */
  note?: string;
}

export interface RecapRef {
  path: string;
  start: number;
  end: number;
  /** What it is, never what is wrong with it: "called from here", "defines Order". */
  note: string;
}

export interface RecapSection {
  title: string;
  summary: string;
  mechanical?: boolean;
  changes: RecapChange[];
  refs?: RecapRef[];
}

/** What the agent returns. */
export interface Recap {
  sections: RecapSection[];
}

export const RECAP_SCHEMA = {
  type: 'object',
  required: ['sections'],
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'summary', 'changes'],
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          mechanical: { type: 'boolean' },
          changes: {
            type: 'array',
            items: {
              type: 'object',
              required: ['path', 'side', 'start', 'end'],
              properties: {
                path: { type: 'string' },
                side: { enum: ['new', 'old'] },
                start: { type: 'integer' },
                end: { type: 'integer' },
                show: {
                  type: 'object',
                  required: ['start', 'end'],
                  properties: { start: { type: 'integer' }, end: { type: 'integer' } },
                },
                note: { type: 'string' },
              },
            },
          },
          refs: {
            type: 'array',
            items: {
              type: 'object',
              required: ['path', 'start', 'end', 'note'],
              properties: {
                path: { type: 'string' },
                start: { type: 'integer' },
                end: { type: 'integer' },
                note: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
} as const;

export function recapPrompt(diff: string, base: string): string {
  return `You are preparing a code change for a human reviewer. You do not review it.
Your job is to cut the change into sections that follow its logic, so the reviewer
can read it top to bottom without jumping between files.

Rules:
- Neutral. Say what the code does and how the parts connect. Never judge it, never
  guess why it was written, never point at risks or things to check.
- Order the sections outside-in: contracts first (protos, schemas, migrations,
  types), then wiring (cmd/, registration, config, routes), then the core logic,
  so the reader meets a thing before it is used.
- Put tests in the section of the code they test, not in their own section.
- Put generated or mechanical changes (generated code, mocks, lockfiles,
  renames, formatting-only edits) in one last section with "mechanical": true,
  one change per file with a one-line "note" saying what it is
  ("regenerated from order.proto").
- Every changed line belongs to exactly one section. A change is a line range on
  one side: "new" for added lines, numbered as in the new file, "old" for removed
  lines, numbered as in the old file. A replaced block is usually two changes,
  one per side. Ranges may span unchanged lines. You may split a hunk across
  sections when it mixes two concerns.
- Give each change a "show" range on the same side: the enclosing function, type
  or block, so the change reads in its context.
- When following a section needs unchanged code elsewhere (the caller of the new
  function, the type it takes), add it as a "ref": path, line range in the
  current file, and a neutral note ("calls Register", "defines Order"). A ref
  holds no changed line; one that does is dropped.
- Title: what the section does, in a few words ("Register the order consumer in
  cmd/worker"). Summary: two to four sentences, plain text.

You can read the repository to understand the change; it is your working
directory. The change is against ${base}. Lines are numbered: "+ 12" is line 12
of the new file, "- 8" line 8 of the old one, a kept line carries its new number.

${diff}`;
}

/** A section ready for the page: rows of each file it shows, and which are its own. */
export interface TourSection {
  title: string;
  summary: string;
  mechanical: boolean;
  /** Set on the section that collects what the agent left out. */
  uncovered?: boolean;
  files: TourSectionFile[];
  refs: RecapRef[];
}

export interface TourSectionFile {
  path: string;
  /** Row windows to show, as inclusive [first, last] row indexes, sorted and merged. */
  windows: [number, number][];
  note?: string;
}

export interface CheckedRecap {
  sections: TourSection[];
  /** For each file, the section each row belongs to; -1 for an unchanged row. */
  owners: Record<string, number[]>;
}

const CONTEXT = 5;

/**
 * A ref is unchanged code. One over an added line would show that line a second
 * time, unmarked, beside the section that owns it: it is dropped, not shown.
 */
function touchesChange(file: FileDiff | undefined, ref: RecapRef): boolean {
  return !!file?.rows.some((row) => row.kind === '+' && row.new !== undefined && row.new >= ref.start && row.new <= ref.end);
}

/**
 * Turn the agent's line ranges into row windows, and prove the cut is whole.
 *
 * Every changed row ends up owned by exactly one section: the first that claims
 * it wins, and whatever no section claims goes to a last "Not covered" section,
 * so nothing reaches the reviewer unseen. Files with no rows at all (binary, a
 * pure rename, an empty new file) can't be claimed by line and go to the
 * mechanical section. Only a range that names nothing real is an error.
 */
export function checkRecap(recap: Recap, files: FileDiff[]): CheckedRecap {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const owners: Record<string, number[]> = {};
  for (const f of files) owners[f.path] = f.rows.map(() => -1);

  const errors: string[] = [];
  const indexOf = (file: FileDiff, side: 'new' | 'old', line: number): number =>
    file.rows.findIndex((row) => row[side] === line);

  const sections: TourSection[] = recap.sections.map((section, s) => {
    const windows = new Map<string, [number, number][]>();
    const notes = new Map<string, string>();
    for (const change of section.changes) {
      const file = byPath.get(change.path) ?? files.find((f) => f.oldPath === change.path);
      if (!file) {
        errors.push(`§${s + 1}: ${change.path} is not in the diff`);
        continue;
      }
      if (change.start > change.end) {
        errors.push(`§${s + 1}: ${change.path} ${change.start}-${change.end} is backwards`);
        continue;
      }
      if (change.note) notes.set(file.path, change.note);
      const own = owners[file.path] as number[];
      let first = -1;
      let last = -1;
      file.rows.forEach((row, i) => {
        const no = row[change.side];
        if (no === undefined || no < change.start || no > change.end) return;
        if (first < 0) first = i;
        last = i;
        if (row.kind !== ' ' && own[i] === -1) own[i] = s;
      });
      if (first < 0) {
        if (file.rows.length > 0) errors.push(`§${s + 1}: ${change.path} has no ${change.side} lines ${change.start}-${change.end}`);
        windows.set(file.path, windows.get(file.path) ?? []);
        continue;
      }
      const show = change.show ?? { start: change.start - CONTEXT, end: change.end + CONTEXT };
      const from = nearestRow(file, change.side, show.start, 1);
      const to = nearestRow(file, change.side, show.end, -1);
      const list = windows.get(file.path) ?? [];
      // Clamped so the window always holds the change itself.
      list.push([Math.max(0, Math.min(first, from)), Math.max(last, to)]);
      windows.set(file.path, list);
    }
    return {
      title: section.title,
      summary: section.summary,
      mechanical: section.mechanical === true,
      files: [...windows].map(([path, list]) => ({
        path,
        windows: merge(list),
        ...(notes.has(path) ? { note: notes.get(path) } : {}),
      })),
      refs: (section.refs ?? []).filter((ref) => ref.start <= ref.end && !touchesChange(byPath.get(ref.path), ref)),
    };
  });
  if (errors.length) throw new Error(`the recap does not match the diff:\n${errors.join('\n')}`);

  // Rowless files can't be claimed by line; they are mechanical by nature.
  const rowless = files.filter((f) => f.rows.length === 0);
  if (rowless.length) {
    let mech = sections.findIndex((s) => s.mechanical);
    if (mech < 0) {
      sections.push({ title: 'Mechanical changes', summary: '', mechanical: true, files: [], refs: [] });
      mech = sections.length - 1;
    }
    const target = sections[mech] as TourSection;
    for (const f of rowless) {
      if (target.files.some((x) => x.path === f.path)) continue;
      target.files.push({ path: f.path, windows: [], note: rowlessNote(f) });
    }
  }

  // A blank line between two claimed ranges is noise, not unseen code: it joins
  // the section of the nearest claimed change above it, or below it.
  for (const f of files) {
    const own = owners[f.path] as number[];
    f.rows.forEach((row, i) => {
      if (row.kind === ' ' || own[i] !== -1 || row.text.trim() !== '') return;
      let s = -1;
      for (let j = i - 1; j >= 0 && s < 0; j--) if (f.rows[j]?.kind !== ' ' && (own[j] ?? -1) >= 0) s = own[j] as number;
      for (let j = i + 1; j < f.rows.length && s < 0; j++) if (f.rows[j]?.kind !== ' ' && (own[j] ?? -1) >= 0) s = own[j] as number;
      if (s < 0) return;
      own[i] = s;
      const entry = sections[s]?.files.find((x) => x.path === f.path);
      if (entry) entry.windows = merge([...entry.windows, [i, i]]);
    });
  }

  const uncovered: TourSectionFile[] = [];
  for (const f of files) {
    const own = owners[f.path] as number[];
    const left = changedRows(f).filter((i) => own[i] === -1);
    for (const i of left) own[i] = sections.length;
    if (left.length) uncovered.push({ path: f.path, windows: around(left, f.rows.length) });
  }
  if (uncovered.length) {
    sections.push({
      title: 'Not covered',
      summary: 'Changed lines the recap did not place in any section.',
      mechanical: false,
      uncovered: true,
      files: uncovered,
      refs: [],
    });
  }
  return { sections, owners };
}

/**
 * The whole change as a plain diff, before or instead of the recap: every
 * changed line with the same context the "Not covered" section gives it.
 */
export function plainDiff(files: FileDiff[]): TourSectionFile[] {
  return files.map((f) => ({
    path: f.path,
    windows: around(changedRows(f), f.rows.length),
    ...(f.rows.length ? {} : { note: rowlessNote(f) }),
  }));
}

/** What a file with no rows to show is: binary, a pure rename, or empty. */
function rowlessNote(f: FileDiff): string {
  return f.binary ? 'binary file' : f.status === 'renamed' ? `renamed from ${f.oldPath}` : `${f.status}, empty`;
}

function changedRows(f: FileDiff): number[] {
  return f.rows.flatMap((row, i) => (row.kind === ' ' ? [] : [i]));
}

/** Windows holding each of `rows` with CONTEXT lines around it, merged. */
function around(rows: number[], length: number): [number, number][] {
  return merge(rows.map((i): [number, number] => [Math.max(0, i - CONTEXT), Math.min(length - 1, i + CONTEXT)]));
}

/** The first row at or past `line` going `dir`, on that side; the file's edge when there is none. */
function nearestRow(file: FileDiff, side: 'new' | 'old', line: number, dir: 1 | -1): number {
  if (dir === 1) {
    const i = file.rows.findIndex((row) => (row[side] ?? -Infinity) >= line);
    return i < 0 ? file.rows.length - 1 : i;
  }
  for (let i = file.rows.length - 1; i >= 0; i--) if ((file.rows[i]?.[side] ?? Infinity) <= line) return i;
  return 0;
}

function merge(list: [number, number][]): [number, number][] {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const prev = out.at(-1);
    if (prev && a <= prev[1] + 1) prev[1] = Math.max(prev[1], b);
    else out.push([a, b]);
  }
  return out;
}
