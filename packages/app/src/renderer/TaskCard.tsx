import { useState } from 'react';
import type { FleetAgent, FleetSession, Task, TaskPr, TaskRepo } from '@fleetwood/core';
// The leaf module: the barrel re-exports tmux and process scanning, which fail the
// renderer bundle on `node:child_process`.
import { baseFor, partitionAgents, prSummary, repoSummary, VIA_LABEL } from '@fleetwood/core/taskView';
import { hasDriftedOffBranch } from '@fleetwood/core/naming';
import { AgentRow } from './AgentRow.tsx';
import { CHECK_GLYPH, REVIEW_LABEL } from './PrList.tsx';
import { Reorder } from './Reorder.tsx';
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
}

/** `nvim -u NONE` is a legal editor setting; only the command itself names the button. */
function editorLabel(editor: string): string {
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
        {/* On the repo row rather than in the card's actions, because they open on
            this worktree and not on the task root — which is the distinction the
            row exists to make. */}
        {session && (
          <>
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
            {/* Beside the editor because it is the same move on the same worktree —
                read this repo's work — and usually the one wanted first. Which
                trunk it compares against is resolved in main, not carried in the
                snapshot, so the chip stays a verb and the tooltip stays general
                rather than naming a branch the row cannot actually check. */}
            <button
              className="chip repo-review"
              onClick={() =>
                void act({
                  kind: 'openDifit',
                  session,
                  cwd: repo.path,
                  base,
                  name: `${repo.name}-difit`,
                })
              }
              title={`difit on ${repo.path} vs ${base ?? 'its trunk'} — committed and uncommitted work together, from where the branch left it. New files are marked intent-to-add.`}
            >
              review
            </button>
          </>
        )}
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
 */
function PrRow({ pr, onResult }: { pr: TaskPr; onResult: Props['onResult'] }): React.JSX.Element {
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
}: Props): React.JSX.Element {
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [addingRepo, setAddingRepo] = useState(false);
  const [repoName, setRepoName] = useState('');
  const [editingNotes, setEditingNotes] = useState(false);
  /**
   * Whether the repo rows are showing, once you have said so.
   *
   * `undefined` means you haven't — the card then follows the fleet (see `expanded`
   * below), which is what makes a task that starts needing attention open itself.
   * A click pins it either way, because a card you deliberately opened must not
   * close under you on the next snapshot.
   */
  const [showRepos, setShowRepos] = useState<boolean | undefined>();
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
  const needsAttention = session?.needsAttention ?? false;
  const dormant = !task.session;
  // Open when there is something in there to see: an agent working inside a repo,
  // or anything waiting on you. Otherwise the summary line is the whole story.
  const expanded = showRepos ?? (needsAttention || byRepo.size > 0);

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
        <span className="badge kind">task</span>
        {/* Doubles as the repo-rows toggle: it is already the count they summarise. */}
        <button
          className="repo-toggle"
          title={expanded ? 'hide the repos' : 'show the repos'}
          onClick={(event) => {
            event.stopPropagation();
            setShowRepos(!expanded);
          }}
        >
          {expanded ? '▾ ' : '▸ '}
          {repoSummary(task.repos, task.branch)}
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

      {expanded && (
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
      )}

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
            <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} onResult={onResult} />
          ))}
        </div>
      )}

      {editingNotes ? (
        <div className="task-notes-edit">
          <textarea
            autoFocus
            rows={5}
            value={draft}
            placeholder="notes on this task — saved to NOTES.md beside the worktrees"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setEditingNotes(false);
                return;
              }
              // ⌘↵ saves. A bare Enter has to stay a newline — it is a notes box.
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                saveNotes();
              }
            }}
          />
          <div className="task-notes-actions">
            <span className="task-notes-hint">⌘↵ save · esc cancel</span>
            <button className="chip" onClick={() => setEditingNotes(false)}>
              cancel
            </button>
            <button className="chip" onClick={saveNotes}>
              save
            </button>
          </div>
        </div>
      ) : (
        task.notes && (
          <div className="task-notes" onClick={openNotes} title="click to edit · kept in NOTES.md">
            {task.notes.trim()}
          </div>
        )
      )}

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
