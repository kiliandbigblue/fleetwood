import { useState } from 'react';
import type {
  DeployState,
  MergedPr,
  MergedPrs,
  PrLists,
  PullRequest,
  StackRow,
  Task,
} from '@fleetwood/core';
// The leaf module, not the barrel or `github.ts`: both reach
// `node:child_process` and would fail the bundle.
import { doneBefore, needsDeploy, startOfDay } from '@fleetwood/core/deployState';
import { sessionLabel } from '@fleetwood/core/sessionOrder';
import { groupPrStacks } from '@fleetwood/core/taskView';
import { relativeIso, send } from './api.ts';

interface Props {
  prs: PrLists | undefined;
  merged: MergedPrs | undefined;
  /** Used to recognise a PR as part of a task, by its head branch. */
  tasks: Task[];
  /** PR key → session name, for PRs already being worked on. */
  prSessions: Record<string, string>;
  onResult: (message: string, ok: boolean) => void;
}

/** Shared with the task cards, so a pull request reads the same in both places. */
export const CHECK_GLYPH: Record<string, string> = {
  passing: '✓',
  failing: '✗',
  pending: '◍',
  none: '·',
};

/**
 * What each state looks like, and what it asks of you.
 *
 * `built` is the only one that means work, so it is the only one that gets a
 * directional glyph and the accent colour — everything else is either in flight
 * or already answered.
 */
const DEPLOY_BADGE: Record<DeployState, { glyph: string; label: string; hint: string }> = {
  built: {
    glyph: '\u2191',
    label: 'image built \u00b7 deploy it',
    hint: 'the image is pushed and nothing deployed it \u2014 this one is on you',
  },
  building: { glyph: '\u25cd', label: 'building\u2026', hint: 'the image is still being built' },
  deploying: { glyph: '\u25cd', label: 'deploying\u2026', hint: 'a deploy is running' },
  deployed: { glyph: '\u2713', label: 'deployed', hint: 'a deploy run succeeded \u2014 it is live' },
  checking: { glyph: '\u25cd', label: 'checks running', hint: 'tests and lint on the base branch' },
  waiting: {
    glyph: '\u25cc',
    label: 'waiting for build',
    hint: 'checks are green and a tag was cut; the build has not started yet',
  },
  failed: { glyph: '\u2717', label: 'CI failed', hint: 'no tag, no image, or a broken deploy' },
  none: {
    glyph: '\u00b7',
    label: 'no CI trail',
    hint: 'nothing ran on the merge commit \u2014 CI lives elsewhere, or there is none',
  },
};

export const REVIEW_LABEL: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  REVIEW_REQUIRED: 'needs review',
};

function PrRow({
  pr,
  session,
  task,
  stack,
  railed,
  onResult,
}: {
  pr: PullRequest;
  session: string | undefined;
  task: Task | undefined;
  /** Where this pull request sits in its stack, when it is in one. */
  stack?: StackRow<PullRequest>;
  /** Whether this section holds a stack at all, so the rail column is held open. */
  railed?: boolean;
  onResult: Props['onResult'];
}): React.JSX.Element {
  const inStack = stack !== undefined && stack.of > 1;
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
        {/* One column, held open across the whole section — see `.task-pr-rung`. */}
        {railed && (
          <span
            className={`task-pr-rung${
              stack !== undefined && stack.depth > 0 ? ' rung-nested' : ''
            }`}
            title={inStack ? `rung ${stack.rung} of ${stack.of}` : undefined}
          />
        )}
        {/* `ident`: under this repo's convention a pull request's title *is* its
            branch, so it is set as the identifier it is. */}
        <div className="pr-title ident" title={pr.branch ? `${pr.title} · ${pr.branch}` : pr.title}>
          {pr.title}
        </div>
        <span className="row-act">
          <button className="chip" onClick={open} title={session ? 'focus its session' : 'create a worktree and session'}>
            {session ? 'focus' : 'open'}
          </button>
          <button className="chip" onClick={() => void act({ kind: 'openExternal', url: pr.url })} title="open on GitHub">
            ↗
          </button>
        </span>
      </div>
      <div className="pr-meta">
        <span>{pr.repo}</span>
        {/* One state, not two — a draft has nobody asked yet, so GitHub's review
            decision on one is an artifact. Same rule as `PrRow`. */}
        {pr.isDraft ? (
          <span>draft</span>
        ) : (
          pr.reviewDecision && (
            <span className={`review-${pr.reviewDecision}`}>
              {REVIEW_LABEL[pr.reviewDecision] ?? pr.reviewDecision}
            </span>
          )
        )}
        {/* Counted against both sections, so a stack split between "mine" and
            "needs my review" still names the layer this one is waiting on. */}
        {stack?.waitingOn !== undefined && (
          <span
            title={`its base #${stack.waitingOn} is still open — this merges into that branch, not the trunk`}
          >
            waiting on #{stack.waitingOn}
          </span>
        )}
        <span>{relativeIso(pr.updatedAt)}</span>
        {/* A task's PRs share one head branch, so this recognises the whole set. */}
        {task && (
          <span className="linked" title={`part of task ${task.slug} (${task.repos.length} repos)`}>
            ⇄ {task.slug}
          </span>
        )}
        {session && !task && (
          <span className="linked" title={`session ${session}`}>
            ⇄ {sessionLabel(session)}
          </span>
        )}
      </div>
    </div>
  );
}

function MergedRow({
  pr,
  task,
  onResult,
  onMarked,
}: {
  pr: MergedPr;
  task: Task | undefined;
  onResult: Props['onResult'];
  onMarked: (key: string, title: string) => void;
}): React.JSX.Element {
  const key = `${pr.repo}#${pr.number}`;
  const byHand = pr.deployedByHand !== undefined;
  const done = byHand || pr.deploy.state === 'deployed';
  /**
   * A hand-mark overrides the badge but not the record.
   *
   * The CI state stays in the tooltip: "you said you shipped it, and CI only ever
   * got as far as an image" is the honest reading, and it is what you'd want if
   * the mark turns out to be wrong.
   */
  const badge = byHand
    ? {
        glyph: '\u2713',
        label: 'deployed by hand',
        hint: `you marked this deployed \u2014 CI reported: ${DEPLOY_BADGE[pr.deploy.state].label}`,
      }
    : DEPLOY_BADGE[pr.deploy.state];
  const act = async (request: Parameters<typeof send>[0]): Promise<void> => {
    const result = await send(request);
    onResult(result.detail, result.ok);
  };

  // The deciding run is the useful destination: for a built image that is the
  // build log with the tag in it, which is what you check before deploying.
  const target = pr.deploy.decidedBy?.url ?? pr.url;

  return (
    <div className={`pr${done ? ' quiet' : ''}`}>
      <div className="pr-top">
        <span className={byHand ? 'deploy-deployed' : `deploy-${pr.deploy.state}`} title={badge.hint}>
          {badge.glyph}
        </span>
        <span className="pr-number">#{pr.number}</span>
        <div className="pr-title ident" title={pr.branch ? `${pr.title} · ${pr.branch}` : pr.title}>
          {pr.title}
        </div>
        <span className="row-act">
        <button
          className="chip"
          onClick={() => void act({ kind: 'openExternal', url: target })}
          title={pr.deploy.decidedBy ? `open ${pr.deploy.decidedBy.name} on GitHub` : 'open on GitHub'}
        >
          ↗
        </button>
        <button
          className="chip"
          onClick={() => {
            if (done) {
              void act({ kind: 'unmarkPrDeployed', key });
              return;
            }
            onMarked(key, `#${pr.number}`);
            void act({ kind: 'markPrDeployed', key });
          }}
          title={
            done
              ? 'not actually deployed — put it back'
              : 'I have deployed this — record it and let it sink'
          }
        >
          {done ? '↺' : 'mark deployed'}
        </button>
        </span>
      </div>
      <div className="pr-meta">
        <span>{pr.repo}</span>
        {/* The version you would name in the Slack message. */}
        {pr.deploy.tag && <span className="deploy-tag">{pr.deploy.tag}</span>}
        <span className={byHand ? 'deploy-deployed' : `deploy-${pr.deploy.state}`} title={badge.hint}>
          {badge.label}
        </span>
        <span title={`merged ${pr.mergedAt}`}>{relativeIso(pr.mergedAt)}</span>
        {/* Someone else opened it, so you merged or reviewed it — still yours to ship. */}
        {!pr.mine && pr.author && <span title={`opened by ${pr.author}`}>by {pr.author}</span>}
        {task && (
          <span className="linked" title={`part of task ${task.slug} (${task.repos.length} repos)`}>
            ⇄ {task.slug}
          </span>
        )}
      </div>
    </div>
  );
}

export function PrList({ prs, merged, tasks, prSessions, onResult }: Props): React.JSX.Element {
  const taskByBranch = new Map(tasks.map((t) => [t.branch, t]));
  /**
   * The last row marked deployed, so a misclick is one click to undo.
   *
   * The row itself also carries a `↺`, so this is a convenience rather than the
   * only way back — but a mark is persisted, and the row moves the moment it is
   * made, so having the undo stay put helps.
   */
  const [undo, setUndo] = useState<{ key: string; label: string } | undefined>();
  const mergedSection = (): React.JSX.Element => {
    /*
     * Anything deployed on a day that is already over is dropped outright.
     *
     * The list answers two questions — what do I still owe, and what did I ship
     * today — and a fortnight of finished rows underneath them answers neither.
     * Nothing still owed is ever dropped, however old it is, so the work cannot
     * go missing this way; and a mark made in error is still one `↺` away for as
     * long as the day it was made in lasts.
     *
     * Read on every render rather than held in state, so a panel left open
     * overnight drops yesterday's rows the moment the day turns.
     */
    const since = startOfDay(Date.now());
    const list = (merged?.prs ?? []).filter((pr) => !doneBefore(pr, since));
    // Same predicate the header pill uses, so the two numbers always agree.
    const owed = list.filter((pr) => needsDeploy(pr)).length;
    return (
      <>
        <div className="section-title section-title-row">
          <span>
            recently merged ({list.length}){owed > 0 && <strong className="owed"> · {owed} to deploy</strong>}
          </span>
          <span className="section-actions">
            {undo && (
              <button
                className="chip"
                title={`${undo.label} was not deployed after all`}
                onClick={() => {
                  const key = undo.key;
                  setUndo(undefined);
                  void send({ kind: 'unmarkPrDeployed', key }).then((r) => onResult(r.detail, r.ok));
                }}
              >
                undo {undo.label}
              </button>
            )}
          </span>
        </div>
        {!merged ? (
          <div className="empty" style={{ padding: '12px' }}>
            reading merge history…
          </div>
        ) : merged.degraded ? (
          <div className="empty" style={{ padding: '12px' }}>
            couldn't read merged pull requests
          </div>
        ) : list.length === 0 ? (
          <div className="empty" style={{ padding: '12px' }}>
            nothing merged recently
          </div>
        ) : (
          list.map((pr) => (
            <MergedRow
              key={`${pr.repo}#${pr.number}`}
              pr={pr}
              task={pr.branch ? taskByBranch.get(pr.branch) : undefined}
              onResult={onResult}
              onMarked={(key, label) => setUndo({ key, label })}
            />
          ))
        )}
      </>
    );
  };


  // The merged section keeps rendering through both: the open-PR search failing
  // says nothing about the merge history, and this is the section that holds
  // work you might otherwise forget.
  if (!prs) {
    return (
      <>
        {mergedSection()}
        <div className="empty">loading pull requests…</div>
      </>
    );
  }
  if (prs.degraded) {
    return (
      <>
        {mergedSection()}
        <div className="empty">
          <code>gh</code> returned nothing.
          <br />
          Check <code>gh auth status</code>.
        </div>
      </>
    );
  }

  const everyPr = [...prs.reviewRequested, ...prs.mine];
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
        // Both sections are handed as `known`, so a stack spanning the two is
        // still counted whole — a layer in `mine` says `2 of 3`, not `1 of 1`.
        (() => {
          const rows = groupPrStacks(list, everyPr);
          const railed = rows.some((row) => row.of > 1);
          return rows.map((row) => (
            <PrRow
              key={`${row.pr.repo}#${row.pr.number}`}
              pr={row.pr}
              session={prSessions[`${row.pr.repo}#${row.pr.number}`]}
              task={row.pr.branch ? taskByBranch.get(row.pr.branch) : undefined}
              stack={row}
              railed={railed}
              onResult={onResult}
            />
          ));
        })()
      )}
    </>
  );

  return (
    <>
      {/* First, because it is the only one of the three holding work you owe
          rather than work you could pick up. */}
      {mergedSection()}
      {section('needs my review', prs.reviewRequested)}
      {section('mine', prs.mine)}
    </>
  );
}
