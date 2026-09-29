import { useEffect, useMemo, useRef, useState } from 'react';
import type { ArchivedPr, ArchivedTask } from '@fleetwood/core';
import { REVIEW_LABEL } from './PrList.tsx';
import { duration, send } from './api.ts';

interface Props {
  /** Archived tasks, already newest-first from the main process. */
  history: ArchivedTask[];
  onResult: (message: string, ok: boolean) => void;
}

/**
 * What archiving used to throw away.
 *
 * Read-only on purpose, and the only tab that is: every row here describes
 * something that no longer exists on disk, so there is nothing to focus, open or
 * act on. What you can reach is each pull request, on GitHub — every one of
 * them, as a row of its own, rather than one chip that opened the first.
 *
 * The rows are snapshots taken at archive time and never re-fetched — see
 * `taskHistory.ts`. So a pull request reads as it did the day the task ended,
 * which is why the PR line says "when archived" rather than showing a live state
 * it cannot vouch for.
 */
export function HistoryList({ history, onResult }: Props): React.JSX.Element {
  /**
   * A filter rather than pagination.
   *
   * The log is append-only and never pruned, so it only grows — and what you come
   * here for is one remembered task, not a page of them. Matching the slug,
   * summary, goal, microservice and repos covers every way you'd half-remember it.
   */
  const [query, setQuery] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  /*
   * `/` to filter, as a search field is reached in most keyboard-driven tools.
   * Only when nothing else is being typed into, and not with a modifier.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const typing = event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(event.target.tagName);
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        filterRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return history;
    return history.filter((entry) =>
      [
        entry.slug,
        entry.summary,
        entry.goal ?? '',
        entry.microservice,
        entry.type,
        entry.branch,
        ...entry.repos.map((repo) => `${repo.repo} ${repo.branch ?? ''}`),
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [history, query]);

  if (history.length === 0) {
    return (
      <div className="empty">
        nothing archived yet.
        <br />
        Archiving a task will leave its description and pull requests here.
      </div>
    );
  }

  return (
    <>
      <div className="section-title section-title-row" role="heading" aria-level={2}>
        <span>
          archived ({shown.length}
          {shown.length !== history.length ? ` of ${history.length}` : ''})
        </span>
      </div>
      <input
        ref={filterRef}
        className="field history-filter"
        aria-label="filter the archived tasks"
        placeholder="filter by slug, summary, repo…   /"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // Esc clears first, then lets go of the field — and must not reach
          // the panel's own Escape while there is still something to clear.
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (query) setQuery('');
            else event.currentTarget.blur();
          }
        }}
      />
      {shown.length === 0 ? (
        <div className="empty inline">nothing matches “{query.trim()}”</div>
      ) : (
        byMonth(shown).map(({ month, entries }) => (
          <div key={month} className="history-month">
            {/* A heading per month: a log that only grows is read by when, and
                a hundred rows in one run gave the eye nowhere to land. */}
            <div className="history-month-title" role="heading" aria-level={3}>
              {month}
            </div>
            {entries.map((entry) => (
              <ArchivedRow key={`${entry.slug}@${entry.archivedAt}`} entry={entry} onResult={onResult} />
            ))}
          </div>
        ))
      )}
    </>
  );
}

/** Archived entries grouped by the month they were archived in, newest first. */
function byMonth(entries: ArchivedTask[]): Array<{ month: string; entries: ArchivedTask[] }> {
  const groups: Array<{ month: string; entries: ArchivedTask[] }> = [];
  for (const entry of entries) {
    const month = new Date(entry.archivedAt * 1_000).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const last = groups[groups.length - 1];
    if (last?.month === month) last.entries.push(entry);
    else groups.push({ month, entries: [entry] });
  }
  return groups;
}

/** Epoch seconds to "3d ago", matching how the PR rows read. */
function relativeEpoch(seconds: number): string {
  return `${duration(Math.floor(Date.now() / 1000) - seconds)} ago`;
}

function ArchivedRow({
  entry,
  onResult,
}: {
  entry: ArchivedTask;
  onResult: Props['onResult'];
}): React.JSX.Element {
  const open = (url: string): void => {
    void send({ kind: 'openExternal', url }).then((r) => {
      // Only worth a toast when it failed; a browser opening is its own feedback.
      if (!r.ok) onResult(r.detail, false);
    });
  };

  /*
   * How long the task was alive.
   *
   * The pair of stamps is more use than either alone — "archived 3d ago" says
   * when you stopped, and the span says whether it was an afternoon or a month.
   */
  const ran = duration(Math.max(0, entry.archivedAt - entry.createdAt));
  const merged = entry.prs.filter((pr) => pr.state === 'MERGED').length;
  const known = entry.prs.some((pr) => pr.state !== undefined);

  /*
   * Read, not faded. Every row here used to sit at 0.55 opacity — 2.3:1 — to say
   * nothing needs you; the absence of colour already says that, and a record
   * you come to look something up in has to be legible.
   */
  return (
    <div className="pr history-entry">
      <div className="pr-top">
        <div className="pr-title" title={entry.goal ?? entry.summary}>
          {entry.summary || entry.slug}
        </div>
      </div>

      <div className="pr-meta">
        {/* The slug is the name you'd search for, so it leads the meta line —
            in mono, as every identifier in the panel is. */}
        <span className="mono" title="task slug — its folder was named this">
          {entry.slug}
        </span>
        <span>
          {entry.type} · {entry.microservice}
        </span>
        <span title={`archived ${new Date(entry.archivedAt * 1_000).toLocaleString()}`}>
          archived {relativeEpoch(entry.archivedAt)}
        </span>
        <span title={`created ${new Date(entry.createdAt * 1_000).toLocaleString()}`}>ran {ran}</span>
        {/* Did it land — the question this tab is opened for, in one phrase. */}
        {entry.prs.length > 0 && known && (
          <span className={merged === entry.prs.length ? 'history-landed' : undefined}>
            {merged === entry.prs.length
              ? entry.prs.length === 1
                ? 'merged'
                : `all ${entry.prs.length} merged`
              : `${merged} of ${entry.prs.length} merged`}
          </span>
        )}
      </div>

      {/*
        Where the work went. The branch matters more than the repo name here: the
        worktree is gone, so this string is the only pointer left to the commits —
        and `pruneEmptyBranch` only ever deleted branches that held nothing.
        Shown once, in mono; the pull request lines below no longer repeat it.
      */}
      {entry.repos.length > 0 && (
        <div className="pr-meta">
          <span className="mono" title="the task's own branch">
            {entry.branch}
          </span>
          {entry.repos.map((repo) => (
            <span className="mono" key={`${repo.repo}/${repo.branch ?? ''}`} title={repo.branch ?? repo.repo}>
              {repo.repo.split('/').pop()}
              {repo.branch && repo.branch !== entry.branch ? ` · ${repo.branch}` : ''}
            </span>
          ))}
        </div>
      )}

      {entry.prs.map((pr) => (
        <ArchivedPrLine key={`${pr.repo}#${pr.number}`} pr={pr} branch={entry.branch} onOpen={open} />
      ))}
    </div>
  );
}

/** How a pull request stood at archive time, in words. */
const PR_STATE_LABEL: Record<NonNullable<ArchivedPr['state']>, string> = {
  MERGED: 'merged',
  CLOSED: 'closed unmerged',
  OPEN: 'still open',
};

function ArchivedPrLine({
  pr,
  branch,
  onOpen,
}: {
  pr: ArchivedPr;
  /** The task's branch — a PR titled the same says nothing new by repeating it. */
  branch: string;
  onOpen: (url: string) => void;
}): React.JSX.Element {
  const id = `${pr.repo.split('/').pop()}#${pr.number}`;
  const snapshot = [
    pr.state ? PR_STATE_LABEL[pr.state] : undefined,
    pr.isDraft && pr.state !== 'MERGED' ? 'draft' : undefined,
    pr.reviewDecision && pr.state !== 'MERGED' ? REVIEW_LABEL[pr.reviewDecision] ?? pr.reviewDecision : undefined,
  ].filter(Boolean);
  return (
    /* A row of its own, reachable and opened by keyboard like every other row. */
    <div
      className="pr-meta history-pr list-stop"
      role="link"
      tabIndex={0}
      aria-label={`${id}${pr.title !== branch ? ` ${pr.title}` : ''}${
        snapshot.length ? `, ${snapshot.join(', ')} when archived` : ''
      } — open on GitHub`}
      title={`${pr.title} — open ${pr.repo}#${pr.number} on GitHub`}
      onClick={() => onOpen(pr.url)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen(pr.url);
      }}
    >
      <span className="mono">{id}</span>
      {pr.title !== branch && <span className="history-pr-title">{pr.title}</span>}
      {/* Frozen at archive time, and labelled as such — it may well have moved since. */}
      {snapshot.length > 0 && (
        <span
          className={pr.state === 'MERGED' ? 'history-landed' : pr.reviewDecision ? `review-${pr.reviewDecision}` : undefined}
          title="as it stood when the task was archived — not re-checked since"
        >
          {snapshot.join(' · ')} when archived
        </span>
      )}
      <span className="task-pr-open" aria-hidden="true">
        ↗
      </span>
    </div>
  );
}
