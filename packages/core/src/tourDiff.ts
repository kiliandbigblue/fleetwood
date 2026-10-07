import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from './exec.ts';

/**
 * One line of a file as the review shows it: kept, added or removed.
 *
 * A kept line has both numbers, an added one only `new`, a removed one only
 * `old`. Every line of the file is here, not only the changed ones: a section
 * shows the function around its change, and that is unchanged code.
 */
export interface Row {
  kind: ' ' | '+' | '-';
  old?: number;
  new?: number;
  text: string;
}

export interface FileDiff {
  /** The path on the new side; the old one for a deleted file. */
  path: string;
  /** Set when the file was renamed or deleted. */
  oldPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  binary: boolean;
  rows: Row[];
}

/**
 * The worktree as it stands, as an immutable tree.
 *
 * Written through a throwaway copy of the index, so the real one is untouched:
 * new files are included without being marked intent-to-add.
 * `add -A` still honours `.gitignore`.
 */
export async function snapshotTree(cwd: string): Promise<string> {
  const index = (await run('git', ['rev-parse', '--git-path', 'index'], { cwd })).stdout.trim();
  const dir = await mkdtemp(join(tmpdir(), 'fw-tour-'));
  const tmpIndex = join(dir, 'index');
  try {
    await copyFile(resolve(cwd, index), tmpIndex).catch(() => undefined);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const add = await run('git', ['add', '-A'], { cwd, env, timeoutMs: 60_000 });
    if (add.code !== 0) throw new Error(`git add: ${add.stderr.trim()}`);
    const tree = await run('git', ['write-tree'], { cwd, env });
    if (tree.code !== 0) throw new Error(`git write-tree: ${tree.stderr.trim()}`);
    return tree.stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function mergeBase(cwd: string, base: string): Promise<string> {
  const out = await run('git', ['merge-base', base, 'HEAD'], { cwd });
  if (out.code !== 0) throw new Error(`no merge base between ${base} and HEAD`);
  return out.stdout.trim();
}

/**
 * Every changed file between two trees, whole.
 *
 * A context as large as any file turns each file's diff into one hunk holding
 * the entire file, so the page can show any window of it without going back to
 * git.
 */
export async function wholeDiff(cwd: string, from: string, to: string): Promise<FileDiff[]> {
  const out = await run('git', ['diff', '-M', '--no-color', '--no-ext-diff', '--unified=100000000', from, to], {
    cwd,
    timeoutMs: 60_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (out.code !== 0) throw new Error(`git diff: ${out.stderr.trim()}`);
  return parseDiff(out.stdout);
}

const unquote = (path: string): string =>
  path.startsWith('"') ? (JSON.parse(path) as string) : path;

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { path: '', status: 'modified', binary: false, rows: [] };
      files.push(file);
      inHunk = false;
      // Overwritten by the ---/+++ or rename lines below when there are any.
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (m) file.path = m[2] as string;
      continue;
    }
    if (!file) continue;
    if (!inHunk) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) {
        file.status = 'renamed';
        file.oldPath = unquote(line.slice('rename from '.length));
      } else if (line.startsWith('rename to ')) file.path = unquote(line.slice('rename to '.length));
      else if (line.startsWith('Binary files ')) file.binary = true;
      else if (line.startsWith('--- ') && line !== '--- /dev/null') {
        if (file.status === 'deleted') file.path = unquote(line.slice(4)).replace(/^a\//, '');
      } else if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
        file.path = unquote(line.slice(4)).replace(/^b\//, '');
      } else if (line.startsWith('@@')) {
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        oldNo = Number(m?.[1] ?? 1);
        newNo = Number(m?.[2] ?? 1);
        inHunk = true;
      }
      if (file.status === 'deleted' && !file.oldPath) file.oldPath = file.path;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = Number(m?.[1] ?? 1);
      newNo = Number(m?.[2] ?? 1);
    } else if (line.startsWith('+')) file.rows.push({ kind: '+', new: newNo++, text: line.slice(1) });
    else if (line.startsWith('-')) file.rows.push({ kind: '-', old: oldNo++, text: line.slice(1) });
    else if (line.startsWith(' ')) file.rows.push({ kind: ' ', old: oldNo++, new: newNo++, text: line.slice(1) });
    // `\ No newline at end of file` and the trailing empty line carry nothing.
  }
  return files;
}

/**
 * The diff the recap agent reads: changed lines and three around them, each
 * numbered, so it can name exact ranges back.
 *
 * `+ 12` is line 12 of the new file, `- 8` line 8 of the old one, and a kept
 * line carries its new number.
 */
export function agentDiff(files: FileDiff[]): string {
  const out: string[] = [];
  for (const file of files) {
    const head = file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;
    out.push(`=== ${head} (${file.status}${file.binary ? ', binary' : ''})`);
    const changed = file.rows.map((row) => row.kind !== ' ');
    const near = (i: number): boolean => {
      for (let j = Math.max(0, i - 3); j <= Math.min(file.rows.length - 1, i + 3); j++) if (changed[j]) return true;
      return false;
    };
    let gap = false;
    file.rows.forEach((row, i) => {
      if (!near(i)) {
        gap = true;
        return;
      }
      if (gap) out.push('  ...');
      gap = false;
      const no = row.kind === '-' ? row.old : row.new;
      out.push(`${row.kind} ${String(no).padStart(5)} | ${row.text}`);
    });
    out.push('');
  }
  return out.join('\n');
}
