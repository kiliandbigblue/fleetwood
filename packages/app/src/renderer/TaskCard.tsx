import { useState } from 'react';
import type { FleetAgent, FleetSession, Task, TaskPr, TaskRepo } from '@fleetwood/core';
// The leaf module: the barrel re-exports tmux and process scanning, which fail the
// renderer bundle on `node:child_process`.
import {
  baseFor,
  partitionAgents,
  prRepoTags,
  prSummary,
  repoSummary,
  VIA_LABEL,
} from '@fleetwood/core/taskView';
import { hasDriftedOffBranch } from '@fleetwood/core/naming';
import { isPinned } from '@fleetwood/core/sessionOrder';
import { AgentRow } from './AgentRow.tsx';
import { CHECK_GLYPH, REVIEW_LABEL } from './PrList.tsx';
import { Reorder } from './Reorder.tsx';
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
  taskBranch,
  session,
  editor,
  base,
  agents,
  onResult,
}: {
  repo: TaskRepo;
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
  agents: FleetAgent[];
  onResult: Props['onResult'];
}): React.JSX.Element {
  const act = async (request: Parameters<typeof send>[0]): Promise<void> => {
    const result = await send(request);
    onResult(result.detail, result.ok);
  };

  return (
    <>
      <div className="task-repo">
        <span className="task-repo-name">{repo.name}</span>
        {repo.dirty > 0 ? (
          <span className="dirty" title={`${repo.dirty} uncommitted change(s)`}>
            {repo.dirty} dirty
          </span>
        ) : (
          <span className="clean">clean</span>
        )}
        {/* Only worth saying when nothing accounts for the branch it is on. A
            stack layer's directory is named for its branch, so it is where it
            says it is; drift is a branch the directory does not claim. */}
        {hasDriftedOffBranch(repo.name, repo.branch, taskBranch) && (
          <span className="off-branch" title="not the branch this worktree was made for">
            {repo.branch}
          </span>
        )}
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
      </div>
      {agents.map((agent) => (
        <AgentRow key={agent.key} agent={agent} onResult={onResult} />
      ))}
    </>
  );
}

/**
 * `reflow` — or `reflow feature/orders-dual-write-order-type`.
 *
 * The second word is what lets a task hold a second branch of a repo it already
 * has, which is the shape stacked work takes. Left off, the task's own branch is
 * used, exactly as before.
 */
export function parseRepoInput(text: string): [repo: string | undefined, branch: string | undefined] {
  const [repo, branch] = text.trim().split(/\s+/);
  return [repo && repo.length > 0 ? repo : undefined, branch];
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
  onResult,
}: {
  pr: TaskPr;
  /**
   * The repo this pull request is on, when the list it sits in needs telling apart.
   *
   * Absent for a task whose pull requests all sit in one repo — see `prRepoTags`.
   */
  repoTag?: string;
  onResult: Props['onResult'];
}): React.JSX.Element {
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
      {/* Beside the number rather than out among the flags: it says which thing
          this row is, so it belongs with the identifier and not with the states
          the row reports about it. */}
      {repoTag && (
        <span className="task-pr-repo" title={pr.repo}>
          {repoTag}
        </span>
      )}
      {/* The title, which under this repo's convention *is* the branch name — so
          the branch is not repeated beside it, only in the tooltip. */}
      <span className="task-pr-title">{pr.title}</span>
      {pr.isDraft && <span className="task-pr-flag">draft</span>}
      {pr.reviewDecision && (
        <span className={`review-${pr.reviewDecision}`}>
          {REVIEW_LABEL[pr.reviewDecision] ?? pr.reviewDecision}
        </span>
      )}
      {VIA_MARK[pr.via] && (
        <span className="task-pr-via" title={VIA_LABEL[pr.via]}>
          {VIA_MARK[pr.via]}
        </span>
      )}
      {/* Not a button: the whole row is the target, and this only says so. */}
      <span className="task-pr-open">↗</span>
    </div>
  );
}

/**
 * One task, as a card in the fleet list.
 *
 * This is a session card that knows what its session *is* — same shape, same
 * header, plus the things only a task has: the worktrees under it, agents filed
 * under the repo they are actually in, and the notes. It replaces the pair of
 * cards a live task used to get, one per tab, each missing half the controls.
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
  const [repoName, setRepoName] = useState('');
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
  // Empty unless the pull requests actually span repos, which is the only case
  // where the tag tells you anything — see `prRepoTags`.
  const repoTags = prRepoTags(prs ?? []);
  const needsAttention = session?.needsAttention ?? false;
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
        title={
          task.session
            ? `focus ${task.session} · ${task.dir}`
            : `no session yet — open one on ${task.dir}`
        }
      >
        <span className={`attached-dot${session && session.attached > 0 ? '' : ' detached'}`}>●</span>
        <span className="session-name">{task.slug}</span>
        {/* As on a session card: the pin is the reason this one is up here. */}
        {task.session && isPinned(task.session) && (
          <span className="pin-mark" title="pinned above the unpinned sessions">
            📌
          </span>
        )}
        <span className="badge kind">task</span>
        <span className="repo-summary">{repoSummary(task.repos, task.branch)}</span>
        {/* Two arrows out of a box: the same mark a window uses for "make this
            the whole of the view", which is exactly what it does. Drawn rather
            than typed, like the rail's controls and for the same reason — no
            codepoint means this and `⤢` renders as a different weight in every
            face. */}
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
      </div>

      <div className="branch-line" title={task.branch}>
        {task.branch}
      </div>

      {taskLevel.map((agent) => (
        <AgentRow key={agent.key} agent={agent} onResult={onResult} />
      ))}

      <div className="task-repos">
        {task.repos.map((repo) => (
          <RepoRow
            key={repo.name}
            repo={repo}
            taskBranch={task.branch}
            session={task.session}
            editor={editor}
            base={baseFor(prs, repo)}
            agents={byRepo.get(repo.name) ?? []}
            onResult={onResult}
          />
        ))}
      </div>

      {/* Above the notes, which is where these links were being kept by hand. */}
      {prs && prs.length > 0 && (
        <div className="task-prs">
          <div
            className="task-prs-head"
            title={prsStale ? 'gh returned nothing on the last search — this is the previous answer' : undefined}
          >
            {prSummary(prs)}
            {prsStale && <span className="task-pr-via"> · stale</span>}
          </div>
          {prs.map((pr) => (
            <PrRow
              key={`${pr.repo}#${pr.number}`}
              pr={pr}
              repoTag={repoTags[`${pr.repo}#${pr.number}`]}
              onResult={onResult}
            />
          ))}
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

      {addingRepo ? (
        <form
          className="add-repo"
          onSubmit={(event) => {
            event.preventDefault();
            const [name, branch] = parseRepoInput(repoName);
            if (name === undefined) return;
            setAddingRepo(false);
            setRepoName('');
            void act({ kind: 'addRepoToTask', slug: task.slug, repo: name, branch });
          }}
        >
          <input
            autoFocus
            value={repoName}
            placeholder="proto — or `reflow feature/orders-dual-write` for another branch"
            onChange={(event) => setRepoName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setAddingRepo(false);
                setRepoName('');
              }
            }}
          />
          <button className="chip" type="submit">
            add
          </button>
        </form>
      ) : (
        <div className="card-actions">
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
    </div>
  );
}
