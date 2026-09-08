import { useState } from 'react';
import type { FleetSession, Severity, StackRow, Task, TaskPr, TaskRepo } from '@fleetwood/core';
// The leaf module: the barrel re-exports tmux and process scanning, which fail the
// renderer bundle on `node:child_process`.
import {
  baseFor,
  groupPrStacks,
  partitionAgents,
  prRepoTags,
  prSummary,
  repoSummary,
  VIA_LABEL,
  worstState,
} from '@fleetwood/core/taskView';
import { hasDriftedOffBranch, worktreeShortName } from '@fleetwood/core/naming';
import { isPinned } from '@fleetwood/core/sessionOrder';
import { AddRepo } from './AddRepo.tsx';
import { AgentRow } from './AgentRow.tsx';
import { Icon } from './Icon.tsx';
import { CHECK_GLYPH, REVIEW_LABEL } from './PrList.tsx';
import { Reorder } from './Reorder.tsx';
import { Slug } from './Slug.tsx';
import { TaskNotes } from './TaskNotes.tsx';
import { send } from './api.ts';

interface Props {
  task: Task;
  /**
   * What this task has open on GitHub. Absent while the first search is out —
   * which is a different thing from an empty list, and reads differently.
   */
  prs?: TaskPr[];
  /**
   * The last search failed, so this list is the previous one.
   *
   * Kept and marked rather than blanked, for the reason the quota gauge keeps its
   * bars: a pull request list that empties on one flaky `gh` call reads as "you
   * closed them", which is the one thing it must never say.
   */
  prsStale?: boolean;
  /**
   * The task's live tmux session, when it has one.
   *
   * Absent is a real state, not a loading one: creating a task starts nothing, so
   * a task sits on disk with no session until someone works it. The card renders
   * dormant in that case — every button that needs a session name asks for one
   * first.
   */
  session?: FleetSession;
  /**
   * Session names in fleet order, for the reorder arrows.
   *
   * Absent on a dormant task: the slot is kept on the tmux session name, so a
   * task with no session has nowhere to hold one and shows no arrows.
   */
  order?: string[];
  /** The configured editor command, so the per-repo button says what it runs. */
  editor: string;
  onResult: (message: string, ok: boolean) => void;
  /**
   * Open this task on its own, with the fleet put away.
   *
   * A control rather than the header click, which stays what it has always been:
   * the way to the tmux session. Focusing the pane and focusing the terminal are
   * the two things you do with a task all day, and quietly swapping which one the
   * card head means would retrain a habit to buy nothing.
   */
  onFocus: () => void;
}

/** `nvim -u NONE` is a legal editor setting; only the command itself names the button. */
export function editorLabel(editor: string): string {
  // `||`, not `??`: an empty setting splits to `['']`, which is not nullish but is
  // also not a label — the button would read as a bare `+`.
  return editor.trim().split(/\s+/)[0] || 'editor';
}

function RepoRow({
  repo,
  slug,
  taskBranch,
  session,
  editor,
  base,
  onResult,
}: {
  repo: TaskRepo;
  /** The task this worktree belongs to — `removeRepoFromTask` is keyed by slug. */
  slug: string;
  taskBranch: string;
  /** The task's tmux session, when it has one — the editor needs somewhere to land. */
  session?: string;
  editor: string;
  /**
   * What this worktree's own pull request merges into, when it has one.
   *
   * Only stacked work needs it — there the base is the layer below, and reviewing
   * against the trunk instead credits this branch with everything underneath it.
   * Absent (no pull request yet, or the search hasn't landed) main uses the trunk.
   */
  base?: string;
  onResult: Props['onResult'];
}): React.JSX.Element {
  const [confirmRemove, setConfirmRemove] = useState(false);

  const act = async (request: Parameters<typeof send>[0]): Promise<void> => {
    const result = await send(request);
    onResult(result.detail, result.ok);
  };

  return (
    <div className="task-repo">
      {/* Shortened for display only, and inline for a reason: the raw name is
          what `hasDriftedOffBranch` below reasons about, what `repoSummary`
          counts, and the key `removeRepoFromTask` and `partitionAgents` are
          held by — a local holding the short form would eventually reach one
          of them, and the drift check would then never match anything. */}
      <span className="task-repo-name" title={repo.name}>
        {worktreeShortName(repo.name, slug)}
      </span>
      {/* Before the state token, not after it: the token is what has to land
          on the row gutter, and these are what used to push it off. */}
      {/* On the repo row rather than in the card's actions, because they act on
          this worktree and not on the task root — which is the distinction the
          row exists to make. */}
      {session && (
        <button
          className="chip repo-open"
          onClick={() =>
            void act({
              kind: 'openEditor',
              session,
              cwd: repo.path,
              // Named apart from the repo's own shell window, so the tmux status
              // line doesn't carry the same name twice.
              name: `${repo.name}-${editorLabel(editor)}`,
            })
          }
          title={`${editor} in a new pane on ${repo.path}`}
        >
          +{editorLabel(editor)}
        </button>
      )}
      {/* Not gated on a session, unlike the editor: difit is spawned from main
          and read in a browser, so there is nothing a tmux session would be for.
          Reviewing a worktree without first starting an agent on it is a real
          thing to want — it is how you read what the last one did. */}
      <button
        className="chip repo-review"
        onClick={() => void act({ kind: 'openDifit', cwd: repo.path, base })}
        title={`difit on ${repo.path} vs ${base ?? 'its trunk'} — committed and uncommitted work together, from where the branch left it. New files are marked intent-to-add.`}
      >
        review
      </button>
      {/* The landed-PR case: this branch is merged, the checkout is dead weight,
          and the task is still going. Two steps, like archive — and never
          forced from here: uncommitted work refuses, and clearing it is a
          deliberate `fw task rm --force`. */}
      <button
        /* `confirming` pins the row's revealed actions open: the chips fade
           out when the pointer leaves the row, and an armed four-second
           confirm must not be one of the things that goes with them. */
        className={`chip repo-remove danger${confirmRemove ? ' confirming' : ''}`}
        onClick={() => {
          if (!confirmRemove) {
            setConfirmRemove(true);
            setTimeout(() => setConfirmRemove(false), 4_000);
            return;
          }
          setConfirmRemove(false);
          void act({ kind: 'removeRepoFromTask', slug, repo: repo.name });
        }}
        title={`remove this worktree from the task — the task and its other repos stay. Refuses while ${repo.name} has uncommitted work.`}
      >
        {confirmRemove ? 'remove — sure?' : 'remove'}
      </button>
      {/* Only worth saying when nothing accounts for the branch it is on. A
          stack layer's directory is named for its branch, so it is where it
          says it is; drift is a branch the directory does not claim. */}
      {hasDriftedOffBranch(repo.name, repo.branch, taskBranch) && (
        <span className="off-branch" title="not the branch this worktree was made for">
          {repo.branch}
        </span>
      )}
      {/*
       * Nothing is said about a clean worktree.
       *
       * `clean` was on nearly every row in the fleet, in the gutter the eye
       * goes to for what needs doing, to report that nothing does. Silence is
       * the honest rendering of that: a worktree with an empty right edge is
       * clean, and the only rows that speak are the ones with something to
       * say. The count is never unknown — an unreadable repo would say so.
       */}
      {repo.dirty > 0 && (
        <span className="dirty" title={`${repo.dirty} uncommitted change(s)`}>
          {repo.dirty} dirty
        </span>
      )}
    </div>
  );
}

/**
 * How a branch that isn't simply the one a worktree is on got here.
 *
 * Marked rather than explained, the way an inferred agent status is: the label
 * is in the tooltip, and the absence of a mark is the ordinary case. `head` has
 * none because "the branch this worktree is on" is what a reader assumes.
 */
const VIA_MARK: Record<TaskPr['via'], string> = { head: '', stack: '⇡', history: '~', task: '⇄' };

/**
 * The dot, in words.
 *
 * Two channels on one glyph is only worth it if you can find out what they are,
 * and a panel this quiet has nowhere to put a legend. So the mark carries its
 * own: what the colour means, then what the shape means.
 */
export function dotNote(state: Severity, attached: boolean, hasSession: boolean): string {
  const colour = {
    danger: 'something here needs you',
    warn: 'uncommitted work',
    ok: 'live, or approved and waiting',
    quiet: 'nothing waiting',
  }[state];
  const shape = hasSession ? (attached ? 'attached' : 'running, not attached') : 'no session yet';
  return `${colour} · ${shape}`;
}

/**
 * One pull request a task has open.
 *
 * Flatter than the PR tab's row on purpose — it sits inside a card, and a second
 * bordered surface nested in the first reads as a different kind of object. The
 * facts are the same ones, in the same colours.
 *
 * Exported for `TaskPane`, which draws the same rows with more room around them:
 * a pull request has to read identically in both, down to the marks.
 */
export function PrRow({
  pr,
  repoTag,
  stack,
  railed,
  onResult,
}: {
  pr: TaskPr;
  /**
   * The repo this pull request is on, when the list it sits in needs telling apart.
   *
   * Absent for a task whose pull requests all sit in one repo — see `prRepoTags`.
   */
  repoTag?: string;
  /** Where this pull request sits in its stack, when it is in one. */
  stack?: StackRow<TaskPr>;
  /**
   * Whether the list this row is in holds a stack at all.
   *
   * Held open on every row of such a list, layer or not, so one column of branch
   * names runs down the card instead of two ragged ones.
   */
  railed?: boolean;
  onResult: Props['onResult'];
}): React.JSX.Element {
  // A layer above the bottom is explained by its rung, so the `via` mark would be
  // saying the same thing twice. It stays for a `stack` row the grouper could not
  // place — a base that has already merged — where it is the only thing here that
  // says why the row belongs to this task at all.
  const inStack = stack !== undefined && stack.of > 1;
  const viaMark = inStack && stack.rung > 1 ? '' : VIA_MARK[pr.via];
  const where = pr.repoName ?? pr.repo;
  const open = (): void => {
    void send({ kind: 'openExternal', url: pr.url }).then((r) => onResult(r.detail, r.ok));
  };

  return (
    <div
      className="task-pr"
      onClick={open}
      title={`${pr.repo}#${pr.number} · ${pr.branch}\n${VIA_LABEL[pr.via]}${where ? ` · ${where}` : ''}`}
    >
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
      {/* One column, held open even for a row that is in no stack — see
          `.task-pr-rung`. The glyph marks a layer sitting on the one above it;
          which layer exactly is in the tooltip, where it does not cost a column. */}
      {railed && (
        <span
          className="task-pr-rung"
          title={inStack ? `rung ${stack.rung} of ${stack.of}` : undefined}
        >
          {stack !== undefined && stack.depth > 0 ? '└' : ''}
        </span>
      )}
      {/* Beside the number rather than out among the flags: it says which thing
          this row is, so it belongs with the identifier and not with the states
          the row reports about it. */}
      {repoTag && (
        <span className="task-pr-repo" title={pr.repo}>
          {repoTag}
        </span>
      )}
      {/*
       * The title, which under this repo's convention *is* the branch name — so
       * the branch is not repeated beside it, only in the tooltip. Shown in full
       * even when it restates the heading: shortening to `feature/` or to nothing
       * both looked broken next to the number.
       */}
      <span className="task-pr-title" title={pr.title}>
        {pr.title}
      </span>
      {/*
       * One state, not two. `draft needs review` was rendering as a single
       * broken string at the row's right edge, and it was never two facts: a
       * draft has nobody asked yet, so GitHub's review decision on one is an
       * artifact rather than something waiting on you. Draft wins for that
       * reason, and nothing actionable is lost — `prSummary` above still counts
       * the states that ask something.
       */}
      {pr.isDraft ? (
        <span className="task-pr-flag">draft</span>
      ) : (
        pr.reviewDecision && (
          <span className={`review-${pr.reviewDecision}`}>
            {REVIEW_LABEL[pr.reviewDecision] ?? pr.reviewDecision}
          </span>
        )
      )}
      {/* The one thing a stack view says that the rows alone do not: this cannot be
          merged yet, whatever its own checks and reviews look like. */}
      {stack?.waitingOn !== undefined && (
        <span
          className="task-pr-flag"
          title={`its base #${stack.waitingOn} is still open — this merges into that branch, not the trunk`}
        >
          waiting on #{stack.waitingOn}
        </span>
      )}
      <span className="row-act">
        {viaMark && (
          <span className="task-pr-via" title={VIA_LABEL[pr.via]}>
            {viaMark}
          </span>
        )}
        {/* Not a button: the whole row is the target, and this only says so. */}
        <span className="task-pr-open">↗</span>
      </span>
    </div>
  );
}

/**
 * The number column's width, as a style for the block the rows sit in.
 *
 * Measured over the whole list rather than per row — padding is only padding if
 * every row agrees on it. `ch` is one digit on the tabular figures `.pr-number`
 * already asks for.
 */
export function numColStyle(prs: TaskPr[]): React.CSSProperties {
  const widest = Math.max(0, ...prs.map((pr) => `#${pr.number}`.length));
  return { '--num-col': `${widest}ch` } as React.CSSProperties;
}

/**
 * One task, as a card in the fleet list.
 *
 * This is a session card that knows what its session *is* — same shape, same
 * header, plus the things only a task has: the agents running in it, the
 * worktrees under it, and the notes. It replaces the pair of cards a live task
 * used to get, one per tab, each missing half the controls.
 */
export function TaskCard({
  task,
  prs,
  prsStale,
  session,
  order,
  editor,
  onResult,
  onFocus,
}: Props): React.JSX.Element {
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [addingRepo, setAddingRepo] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);
  /**
   * What is being typed, held locally on purpose.
   *
   * A snapshot lands every second, so a textarea bound straight to `task.notes`
   * would have its value replaced under the cursor mid-sentence.
   */
  const [draft, setDraft] = useState('');

  const act = async (request: Parameters<typeof send>[0]): Promise<void> => {
    const result = await send(request);
    onResult(result.detail, result.ok);
  };

  const { taskLevel, byRepo } = partitionAgents(task, session?.agents ?? []);
  /*
   * Every agent in the task, in one block above the worktrees.
   *
   * They used to sit under the repo row they belong to, which grouped them
   * correctly and read as anything but. An agent row starts on the same rail as
   * a worktree name by design, so a repo-scoped one came out as a sibling of the
   * row above rather than as something under it, and repo / agent / repo left no
   * mark saying where one worktree's block ended — a list you reconstruct rather
   * than read.
   *
   * So the same shape the task pane already uses: what is running first, because
   * it is the half that changes minute to minute, then the worktrees as one
   * uninterrupted list. The worktree rides on the row instead — `agent-where`
   * says which one, and an agent at the task root has nothing to say there.
   */
  const agents = [
    // At the task root first — they are the ones acting on the whole of it.
    ...taskLevel.map((agent) => ({ agent, where: undefined as string | undefined })),
    ...[...byRepo.entries()].flatMap(([repo, inRepo]) =>
      inRepo.map((agent) => ({ agent, where: repo })),
    ),
  ];
  // Empty unless the pull requests actually span repos, which is the only case
  // where the tag tells you anything — see `prRepoTags`.
  const repoTags = prRepoTags(prs ?? []);
  const needsAttention = session?.needsAttention ?? false;
  const state = worstState(task.repos, prs, needsAttention, session?.agents);
  const dormant = !task.session;

  const openNotes = (): void => {
    setDraft(task.notes ?? '');
    setEditingNotes(true);
  };
  const saveNotes = (): void => {
    setEditingNotes(false);
    void act({ kind: 'setTaskNotes', slug: task.slug, notes: draft });
  };

  /** Agent buttons work on a dormant task too — they make the session first. */
  const startAgent = (tool: 'claude' | 'cursor'): void => {
    if (task.session) {
      void act({ kind: 'spawnAgent', session: task.session, cwd: task.dir, tool });
    } else {
      void act({ kind: 'startTaskSession', slug: task.slug, agent: tool });
    }
  };

  return (
    <div className={`card${needsAttention ? ' attention' : ''}${dormant ? ' dormant' : ''}`}>
      <div
        className="card-head"
        onClick={
          task.session
            ? () => void act({ kind: 'focusSession', session: task.session as string })
            : () => void act({ kind: 'startTaskSession', slug: task.slug })
        }
        /* The branch rides along here now that it has no line of its own: the
           slug beside it is that branch minus its type prefix, so `feature/` is
           the only part a second row was spelling out. */
        title={
          task.session
            ? `${task.branch} · focus ${task.session} · ${task.dir}`
            : `${task.branch} · no session yet — open one on ${task.dir}`
        }
      >
        {/* Colour is the state, shape is whether you are attached. */}
        <span
          className={`attached-dot sev-${state}${
            session && session.attached > 0 ? '' : ' detached'
          }`}
          title={dotNote(state, (session?.attached ?? 0) > 0, task.session !== undefined)}
        />
        <span className="session-name">
          <Slug text={task.slug} />
        </span>
        {/* As on a session card: the pin is the reason this one is up here. */}
        {task.session && isPinned(task.session) && (
          <span className="pin-mark" title="pinned above the unpinned sessions">
            <Icon name="pin" />
          </span>
        )}
        <span className="repo-summary">{repoSummary(task.repos, task.branch)}</span>
        {/* Two arrows out of a box: the same mark a window uses for "make this
            the whole of the view", which is exactly what it does. Drawn rather
            than typed, like the rail's controls and for the same reason — no
            codepoint means this and `⤢` renders as a different weight in every
            face. */}
        {/* The group's own actions, over the metadata rather than under the rows.
            A reserved footer row that was empty until you pointed at it cost a
            row of height on every group in the fleet to show nothing; here they
            sit in space the head already had, and the summary they cover is the
            one thing you do not need while you are acting on the group. */}
        {!addingRepo && (
          <div
            className="card-actions"
            /* The head focuses the session; a chip in it must not also do that. */
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="chip"
              onClick={() => setAddingRepo(true)}
              title="add a repo — or another branch of one already here, for stacked work"
            >
              + repo
            </button>
            <button className="chip" onClick={() => startAgent('claude')} title="claude at the task root">
              + claude
            </button>
            <button className="chip" onClick={() => startAgent('cursor')} title="cursor-agent at the task root">
              + cursor
            </button>
            {/* Only offered while there is no session: it is the way to get a shell in
                the task folder without starting an agent you didn't ask for. */}
            {dormant && (
              <button
                className="chip"
                onClick={() => void act({ kind: 'startTaskSession', slug: task.slug })}
                title="tmux session at the task root, left at a shell"
              >
                + shell
              </button>
            )}
            <button className="chip" onClick={openNotes} title="your own notes on this task, kept in NOTES.md">
              {task.notes ? 'notes' : '+ note'}
            </button>
            <span style={{ marginLeft: 'auto' }} />
            <button
              className="chip danger"
              onClick={() => {
                if (!confirmArchive) {
                  setConfirmArchive(true);
                  // Two steps: this deletes every worktree in the task.
                  setTimeout(() => setConfirmArchive(false), 4_000);
                  return;
                }
                setConfirmArchive(false);
                void act({ kind: 'archiveTask', slug: task.slug });
              }}
              title="remove every worktree in this task and kill its session"
            >
              {confirmArchive ? 'archive — sure?' : 'archive'}
            </button>
          </div>
        )}
        <span className="row-act">
        <button
          className="pane-open"
          title={`open ${task.slug} on its own`}
          onClick={(event) => {
            event.stopPropagation();
            onFocus();
          }}
        >
          <svg
            className="icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.9}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M14 4.5h5.5V10" />
            <path d="M10 19.5H4.5V14" />
            <path d="M19.5 4.5 13 11" />
            <path d="M4.5 19.5 11 13" />
          </svg>
        </button>
        {/* Last, on the trailing edge, as on a session card. The slug is already
            the session's name minus its slot, so nothing here needs relabelling —
            only moving. */}
        {task.session && order && (
          <Reorder session={task.session} order={order} onResult={onResult} />
        )}
        </span>
      </div>

      {agents.length > 0 && (
        <div className="agents">
          {agents.map(({ agent, where }) => (
            <AgentRow key={agent.key} agent={agent} where={where} onResult={onResult} />
          ))}
        </div>
      )}

      <div className="task-repos">
        {task.repos.map((repo) => (
          <RepoRow
            key={repo.name}
            repo={repo}
            slug={task.slug}
            taskBranch={task.branch}
            session={task.session}
            editor={editor}
            base={baseFor(prs, repo)}
            onResult={onResult}
          />
        ))}
      </div>

      {/* Above the notes, which is where these links were being kept by hand. */}
      {prs && prs.length > 0 && (
        <div className="task-prs" style={numColStyle(prs)}>
          <div
            className="task-prs-head"
            title={prsStale ? 'gh returned nothing on the last search — this is the previous answer' : undefined}
          >
            {prSummary(prs)}
            {prsStale && <span className="task-pr-via"> · stale</span>}
          </div>
          {(() => {
            const rows = groupPrStacks(prs);
            const railed = rows.some((row) => row.of > 1);
            return rows.map((row) => (
              <PrRow
                key={`${row.pr.repo}#${row.pr.number}`}
                pr={row.pr}
                repoTag={repoTags[`${row.pr.repo}#${row.pr.number}`]}
                stack={row}
                railed={railed}
                onResult={onResult}
              />
            ));
          })()}
        </div>
      )}

      {/* No placeholder: a card with no note shows nothing at all, because twelve
          empty boxes down a list is what the pane exists to get away from. */}
      <TaskNotes
        notes={task.notes}
        editing={editingNotes}
        draft={draft}
        onDraft={setDraft}
        onOpen={openNotes}
        onCancel={() => setEditingNotes(false)}
        onSave={saveNotes}
      />

      {addingRepo && (
        <AddRepo task={task} onClose={() => setAddingRepo(false)} onResult={onResult} />
      )}
    </div>
  );
}
