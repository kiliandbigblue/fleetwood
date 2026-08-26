import { useState } from 'react';
import type { FleetAgent, FleetSession, Task, TaskRepo } from '@fleetwood/core';
// The leaf module: the barrel re-exports tmux and process scanning, which fail the
// renderer bundle on `node:child_process`.
import { partitionAgents, repoSummary } from '@fleetwood/core/taskView';
import { AgentRow } from './AgentRow.tsx';
import { send } from './api.ts';

interface Props {
  task: Task;
  /**
   * The task's live tmux session, when it has one.
   *
   * Absent is a real state, not a loading one: creating a task starts nothing, so
   * a task sits on disk with no session until someone works it. The card renders
   * dormant in that case — every button that needs a session name asks for one
   * first.
   */
  session?: FleetSession;
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
  agents,
  onResult,
}: {
  repo: TaskRepo;
  taskBranch: string;
  /** The task's tmux session, when it has one — the editor needs somewhere to land. */
  session?: string;
  editor: string;
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
        {/* Only worth saying when it diverges from the task's branch. */}
        {repo.branch && repo.branch !== taskBranch && (
          <span className="off-branch" title="not on the task's branch">
            {repo.branch}
          </span>
        )}
        {/* On the repo row rather than in the card's actions, because it opens on
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
      </div>
      {agents.map((agent) => (
        <AgentRow key={agent.key} agent={agent} onResult={onResult} />
      ))}
    </>
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
export function TaskCard({ task, session, editor, onResult }: Props): React.JSX.Element {
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
              agents={byRepo.get(repo.name) ?? []}
              onResult={onResult}
            />
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
            const name = repoName.trim();
            if (name.length === 0) return;
            setAddingRepo(false);
            setRepoName('');
            void act({ kind: 'addRepoToTask', slug: task.slug, repo: name });
          }}
        >
          <input
            autoFocus
            value={repoName}
            placeholder="repo name, e.g. proto"
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
          <button className="chip" onClick={() => setAddingRepo(true)} title="add another repo to this task">
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
