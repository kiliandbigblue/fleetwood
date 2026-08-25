import { useState } from 'react';
import type { FleetAgent, FleetState, Task, TaskRepo } from '@fleetwood/core';
import { AgentRow } from './AgentRow.tsx';
import { send } from './api.ts';

interface Props {
  tasks: Task[];
  fleet: FleetState;
  /** The configured editor command, so the per-repo button says what it runs. */
  editor: string;
  onResult: (message: string, ok: boolean) => void;
  onNewTask: () => void;
}

/**
 * Which repo an agent is working in, by its cwd.
 *
 * An agent at the task root belongs to the task as a whole; one inside a repo's
 * worktree belongs to that repo. That distinction is the whole point of the layout,
 * so the UI has to show it rather than lumping every agent together.
 */
function partitionAgents(
  task: Task,
  agents: FleetAgent[],
): { taskLevel: FleetAgent[]; byRepo: Map<string, FleetAgent[]> } {
  const byRepo = new Map<string, FleetAgent[]>();
  const taskLevel: FleetAgent[] = [];

  for (const agent of agents) {
    const repo = agent.cwd
      ? task.repos.find((r) => agent.cwd === r.path || agent.cwd?.startsWith(`${r.path}/`))
      : undefined;
    if (repo) {
      const list = byRepo.get(repo.name);
      if (list) list.push(agent);
      else byRepo.set(repo.name, [agent]);
    } else {
      taskLevel.push(agent);
    }
  }
  return { taskLevel, byRepo };
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

function TaskCard({
  task,
  fleet,
  editor,
  onResult,
}: {
  task: Task;
  fleet: FleetState;
  editor: string;
  onResult: Props['onResult'];
}): React.JSX.Element {
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

  const session = task.session ? fleet.sessions.find((s) => s.name === task.session) : undefined;
  const { taskLevel, byRepo } = partitionAgents(task, session?.agents ?? []);
  const needsAttention = session?.needsAttention ?? false;

  const openNotes = (): void => {
    setDraft(task.notes ?? '');
    setEditingNotes(true);
  };
  const saveNotes = (): void => {
    setEditingNotes(false);
    void act({ kind: 'setTaskNotes', slug: task.slug, notes: draft });
  };

  return (
    <div className={`card${needsAttention ? ' attention' : ''}`}>
      <div
        className="card-head"
        onClick={
          task.session ? () => void act({ kind: 'focusSession', session: task.session as string }) : undefined
        }
        title={task.session ? `focus ${task.session} · ${task.dir}` : task.dir}
      >
        <span className={`attached-dot${session && session.attached > 0 ? '' : ' detached'}`}>●</span>
        <span className="session-name">{task.slug}</span>
        <span className="badge kind">task</span>
        <span className="head-path">
          {task.repos.length} repo{task.repos.length === 1 ? '' : 's'}
        </span>
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
            agents={byRepo.get(repo.name) ?? []}
            onResult={onResult}
          />
        ))}
      </div>

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
          {task.session && (
            <>
              <button
                className="chip"
                onClick={() =>
                  void act({
                    kind: 'spawnAgent',
                    session: task.session as string,
                    cwd: task.dir,
                    tool: 'claude',
                  })
                }
                title="another agent at the task root"
              >
                + claude
              </button>
              <button
                className="chip"
                onClick={() =>
                  void act({
                    kind: 'spawnAgent',
                    session: task.session as string,
                    cwd: task.dir,
                    tool: 'cursor',
                  })
                }
                title="cursor-agent at the task root"
              >
                + cursor
              </button>
            </>
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

export function TaskList({ tasks, fleet, editor, onResult, onNewTask }: Props): React.JSX.Element {
  return (
    <>
      <button className="new-task" onClick={onNewTask}>
        + new task
      </button>
      {tasks.length === 0 && (
        <div className="empty">
          No tasks yet.
          <br />
          A task is one branch across several repos, with a worktree for each — so an
          agent can work across them without you deciding the repo list upfront.
        </div>
      )}
      {tasks.map((task) => (
        <TaskCard key={task.slug} task={task} fleet={fleet} editor={editor} onResult={onResult} />
      ))}
    </>
  );
}
