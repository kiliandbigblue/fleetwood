import type { PrLists, PullRequest } from '@fleetwood/core';
import { relativeIso, send } from './api.ts';

interface Props {
  prs: PrLists | undefined;
  /** PR key → session name, for PRs already being worked on. */
  prSessions: Record<string, string>;
  onResult: (message: string, ok: boolean) => void;
}

const CHECK_GLYPH: Record<string, string> = {
  passing: '✓',
  failing: '✗',
  pending: '◍',
  none: '·',
};

const REVIEW_LABEL: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  REVIEW_REQUIRED: 'needs review',
};

function PrRow({
  pr,
  session,
  onResult,
}: {
  pr: PullRequest;
  session: string | undefined;
  onResult: Props['onResult'];
}): React.JSX.Element {
  const act = async (request: Parameters<typeof send>[0]): Promise<void> => {
    const result = await send(request);
    onResult(result.detail, result.ok);
  };

  const open = (): void => {
    if (session) {
      void act({ kind: 'focusSession', session });
      return;
    }
    void act({ kind: 'openPr', repo: pr.repo, number: pr.number, branch: pr.branch });
  };

  return (
    <div className="pr">
      <div className="pr-top">
        <span
          className={`checks-${pr.checks ?? 'none'}`}
          title={
            pr.checksDetail
              ? `${pr.checksDetail.passing} passing, ${pr.checksDetail.failing} failing, ${pr.checksDetail.pending} pending`
              : 'no checks'
          }
        >
          {CHECK_GLYPH[pr.checks ?? 'none']}
        </span>
        <span className="pr-number">#{pr.number}</span>
        <div className="pr-title" title={pr.branch ? `${pr.title} · ${pr.branch}` : pr.title}>
          {pr.title}
        </div>
        <button className="chip" onClick={open} title={session ? 'focus its session' : 'create a worktree and session'}>
          {session ? 'focus' : 'open'}
        </button>
        <button className="chip" onClick={() => void act({ kind: 'openExternal', url: pr.url })} title="open on GitHub">
          ↗
        </button>
      </div>
      <div className="pr-meta">
        <span>{pr.repo}</span>
        {pr.reviewDecision && (
          <span className={`review-${pr.reviewDecision}`}>
            {REVIEW_LABEL[pr.reviewDecision] ?? pr.reviewDecision}
          </span>
        )}
        {pr.isDraft && <span>draft</span>}
        <span>{relativeIso(pr.updatedAt)}</span>
        {session && (
          <span className="linked" title={`session ${session}`}>
            ⇄ {session}
          </span>
        )}
      </div>
    </div>
  );
}

export function PrList({ prs, prSessions, onResult }: Props): React.JSX.Element {
  if (!prs) {
    return <div className="empty">loading pull requests…</div>;
  }
  if (prs.degraded) {
    return (
      <div className="empty">
        <code>gh</code> returned nothing.
        <br />
        Check <code>gh auth status</code>.
      </div>
    );
  }

  const section = (title: string, list: PullRequest[]): React.JSX.Element => (
    <>
      <div className="section-title">
        {title} ({list.length})
      </div>
      {list.length === 0 ? (
        <div className="empty" style={{ padding: '12px' }}>
          nothing here
        </div>
      ) : (
        list.map((pr) => (
          <PrRow
            key={`${pr.repo}#${pr.number}`}
            pr={pr}
            session={prSessions[`${pr.repo}#${pr.number}`]}
            onResult={onResult}
          />
        ))
      )}
    </>
  );

  return (
    <>
      {section('needs my review', prs.reviewRequested)}
      {section('mine', prs.mine)}
    </>
  );
}
