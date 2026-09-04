import { appendFile, readFile } from 'node:fs/promises';
import { HISTORY_LOG, ensureDirs } from './paths.ts';
import type { Task, TaskRepo } from './task.ts';
import type { TaskPr } from './taskPrs.ts';

/**
 * What a task leaves behind.
 *
 * Archiving deletes the folder, which is the only record a task has: `task.json`,
 * `TASK.md`, and every worktree go at once. That is the right thing to do with
 * the disk and the wrong thing to do with the memory of it — "what was I working
 * on in March, and where did it land" had no answer at all.
 *
 * So the description is copied out before the folder goes, along with the two
 * things that cannot be recovered afterwards:
 *
 * - **repos and their branches**, read from the worktrees while they still exist.
 *   The slug alone does not say where the work went, and a pruned branch is not
 *   in any repo to be found later.
 * - **pull requests**, which `taskPrs` rebuilds from a worktree's reflog and
 *   `branch --contains`. Both die with the worktree, so a PR not captured here
 *   is not discoverable from the archived record by any route.
 *
 * Deliberately a snapshot and not a live view: the entries are frozen at the
 * moment of archiving and never re-fetched. A PR that was open then and is merged
 * now still reads "open" — the record says what was true when the task ended,
 * which is the question history is asked.
 */
export interface ArchivedTask {
  version: 1;
  slug: string;
  branch: string;
  type: string;
  microservice: string;
  summary: string;
  goal?: string;
  createdAt: number;
  /** Epoch seconds, and what the list is ordered by. */
  archivedAt: number;
  repos: ArchivedRepo[];
  /**
   * The pull requests the task had, as they read at the time.
   *
   * Empty when the archive ran without them — `fw task archive` has no fetched
   * snapshot to hand over and will not make a network call on a teardown path.
   * The branches in `repos` are the fallback for finding them by hand.
   */
  prs: ArchivedPr[];
}

/** One worktree the task held, reduced to the parts still meaningful once it's gone. */
export interface ArchivedRepo {
  /** `owner/name` when git would say; the directory name otherwise. */
  repo: string;
  branch?: string;
}

/** A pull request as it read when the task was archived. */
export interface ArchivedPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  /** GitHub's own last-updated stamp, so the row can say how stale the snapshot is. */
  updatedAt: string;
  reviewDecision?: string;
}

/** Copy out only the fields that still mean something without the worktree. */
function toArchivedRepo(repo: TaskRepo): ArchivedRepo {
  return { repo: repo.repo ?? repo.name, ...(repo.branch ? { branch: repo.branch } : {}) };
}

function toArchivedPr(pr: TaskPr): ArchivedPr {
  return {
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    isDraft: pr.isDraft,
    updatedAt: pr.updatedAt,
    ...(pr.reviewDecision ? { reviewDecision: pr.reviewDecision } : {}),
  };
}

export interface RecordArchiveInput {
  task: Pick<Task, 'slug' | 'branch' | 'type' | 'microservice' | 'summary' | 'goal' | 'createdAt'>;
  repos: TaskRepo[];
  prs?: TaskPr[];
  now?: number;
}

/** Build the record without writing it. Separated so it can be tested as a pure function. */
export function buildArchivedTask(input: RecordArchiveInput): ArchivedTask {
  const { task } = input;
  return {
    version: 1,
    slug: task.slug,
    branch: task.branch,
    type: task.type,
    microservice: task.microservice,
    summary: task.summary,
    ...(task.goal ? { goal: task.goal } : {}),
    createdAt: task.createdAt,
    archivedAt: Math.floor((input.now ?? Date.now()) / 1000),
    repos: input.repos.map(toArchivedRepo),
    prs: (input.prs ?? []).map(toArchivedPr),
  };
}

/**
 * Append one archived task to the log.
 *
 * JSON Lines, and appended rather than rewritten, for the same reason as
 * `events.jsonl`: the file only grows at the back, so a write cannot corrupt what
 * is already in it — unlike `merged.json`, which is one object rewritten whole
 * and is the right shape for a fixed set of marks rather than a list.
 *
 * Never throws. This runs inside `archiveTask` immediately before the folder is
 * removed, and a task that will not archive because its history could not be
 * written would be a worse failure than a missing row.
 */
export async function recordArchive(input: RecordArchiveInput): Promise<void> {
  try {
    await ensureDirs();
    await appendFile(HISTORY_LOG, `${JSON.stringify(buildArchivedTask(input))}\n`, 'utf8');
  } catch {
    // Losing a row is not worth failing the archive over.
  }
}

/** Parse the log, skipping anything unreadable. Exported for its tests. */
export function parseHistory(raw: string): ArchivedTask[] {
  const out: ArchivedTask[] = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (text.length === 0) continue;
    try {
      const parsed = JSON.parse(text) as ArchivedTask;
      // A row from a future version could be missing fields the UI reads; skipping
      // it keeps one bad line from taking the tab down with it.
      if (parsed.version !== 1 || typeof parsed.slug !== 'string') continue;
      out.push({ ...parsed, repos: parsed.repos ?? [], prs: parsed.prs ?? [] });
    } catch {
      // A half-written final line is the expected case; drop it silently.
    }
  }
  return out;
}

/** Every archived task, most recently archived first. Empty when nothing has been. */
export async function loadHistory(): Promise<ArchivedTask[]> {
  let raw: string;
  try {
    raw = await readFile(HISTORY_LOG, 'utf8');
  } catch {
    return [];
  }
  return parseHistory(raw).sort((a, b) => b.archivedAt - a.archivedAt);
}
