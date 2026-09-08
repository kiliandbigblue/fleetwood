import { useMemo, useState } from 'react';
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
 * act on. The buttons that would be actions elsewhere are links to GitHub.
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
      <div className="section-title section-title-row">
        <span>
          archived ({shown.length}
          {shown.length !== history.length ? ` of ${history.length}` : ''})
        </span>
      </div>
      <input
        className="field"
        placeholder="filter by slug, summary, repo…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {shown.length === 0 ? (
        <div className="empty" style={{ padding: '12px' }}>
          nothing matches “{query.trim()}”
        </div>
      ) : (
        shown.map((entry) => (
          <ArchivedRow key={`${entry.slug}@${entry.archivedAt}`} entry={entry} onResult={onResult} />
        ))
      )}
    </>
  );
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
  const lived = duration(Math.max(0, entry.archivedAt - entry.createdAt));

  return (
    <div className="pr quiet">
      <div className="pr-top">
        <div className="pr-title" title={entry.goal ?? entry.summary}>
          {entry.summary || entry.slug}
        </div>
        {entry.prs.length > 0 && (
          <span className="row-act">
          <button
            className="chip"
            onClick={() => open(entry.prs[0]?.url as string)}
            title={
              entry.prs.length === 1
                ? `open ${entry.prs[0]?.repo}#${entry.prs[0]?.number} on GitHub`
                : `open the first of ${entry.prs.length} pull requests on GitHub`
            }
          >
            ↗ pr
          </button>
          </span>
        )}
      </div>

      <div className="pr-meta">
        {/* The slug is the name you'd search for, so it leads the meta line. */}
        <span title={`task slug — its folder was named this`}>{entry.slug}</span>
        <span>
          {entry.type} · {entry.microservice}
        </span>
        <span title={`archived ${new Date(entry.archivedAt * 1_000).toLocaleString()}`}>
          archived {relativeEpoch(entry.archivedAt)}
        </span>
        <span title={`created ${new Date(entry.createdAt * 1_000).toLocaleString()}`}>
          lived {lived}
        </span>
      </div>

      {/*
        Where the work went. The branch matters more than the repo name here: the
        worktree is gone, so this string is the only pointer left to the commits —
        and `pruneEmptyBranch` only ever deleted branches that held nothing.
      */}
      {entry.repos.length > 0 && (
        <div className="pr-meta">
          {entry.repos.map((repo) => (
            <span key={`${repo.repo}/${repo.branch ?? ''}`} title={repo.branch ?? repo.repo}>
              {repo.repo}
              {repo.branch && repo.branch !== entry.branch ? ` · ${repo.branch}` : ''}
            </span>
          ))}
          {/* Shown once, not per repo: the convention reuses one branch across them. */}
          <span className="badge branch" title="the task's own branch">
            {entry.branch}
          </span>
        </div>
      )}

      {entry.prs.map((pr) => (
        <ArchivedPrLine key={`${pr.repo}#${pr.number}`} pr={pr} onOpen={open} />
      ))}
    </div>
  );
}

function ArchivedPrLine({
  pr,
  onOpen,
}: {
  pr: ArchivedPr;
  onOpen: (url: string) => void;
}): React.JSX.Element {
  return (
    <div className="pr-meta">
      <span className="linked">⇄</span>
      <span
        style={{ cursor: 'pointer' }}
        title={`${pr.title} — open ${pr.repo}#${pr.number} on GitHub`}
        onClick={() => onOpen(pr.url)}
      >
        {pr.repo}#{pr.number} {pr.title}
      </span>
      {pr.isDraft && <span>draft</span>}
      {/* Frozen at archive time, and labelled as such — it may well have moved since. */}
      {pr.reviewDecision && (
        <span
          className={`review-${pr.reviewDecision}`}
          title="review state when the task was archived — not re-checked since"
        >
          {REVIEW_LABEL[pr.reviewDecision] ?? pr.reviewDecision} when archived
        </span>
      )}
    </div>
  );
}
