import { useState } from 'react';
import type { FleetSession, Task, TaskPr, TaskRepo } from '@fleetwood/core';
// The leaf module: the barrel re-exports tmux and process scanning, which fail the
// renderer bundle on `node:child_process`.
import { baseFor, partitionAgents, prSummary, repoSummary } from '@fleetwood/core/taskView';
import { hasDriftedOffBranch } from '@fleetwood/core/naming';
import { AgentRow } from './AgentRow.tsx';
import { editorLabel, parseRepoInput, PrRow } from './TaskCard.tsx';
import { TaskNotes } from './TaskNotes.tsx';
import { send, tildify } from './api.ts';

interface Props {
  task: Task;
  /** Absent while the first search is out, which reads differently from none. */
  prs?: TaskPr[];
  /** The last search failed, so this is the previous list — kept and marked. */
  prsStale?: boolean;
  /** The task's live tmux session, when it has one. */
  session?: FleetSession;
  editor: string;
  onResult: (message: string, ok: boolean) => void;
  onBack: () => void;
}

/**
 * A labelled block of the pane.
 *
 * Every section says what it is and, beside that, the one line summarising what
 * is in it — the same sentences the card shows, which is deliberate:
 * the pane must not be a place where the fleet's numbers are recomputed
 * differently. The label borrows `.section-title`'s tracked uppercase, this
 * panel's existing mark for "a label, not content".
 */
function Section({
  title,
  summary,
  children,
}: {
  title: string;
  summary?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="pane-section">
      <div className="pane-section-head">
        <span className="pane-section-title">{title}</span>
        {summary && (
          <>
            <span className="pane-section-dot">·</span>
            <span className="pane-section-summary">{summary}</span>
          </>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * What a section has instead of rows.
 *
 * Dashed, like every other "real but not running yet" surface in the panel — the
 * dormant card, the new-task strip. A section that disappeared when it was empty
 * would make a pane about one task keep changing shape as the task progressed,
 * and the empty state is usually the one carrying the next thing to do.
 */
function Nothing({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="pane-empty">{children}</div>;
}

/**
 * One worktree, given two lines.
 *
 * The card's row is one line and elides the path to fit beside the dirty count;
 * here the path is the second line in full, because "which of the four checkouts
 * of this repo am I looking at" is the question the pane exists to answer without
 * a tooltip.
 *
 * No agents nested under it, unlike the card's row: they are all in `agents`, and
 * a worktree is a place on disk rather than a second list of what is running.
 */
function PaneRepo({
  repo,
  taskBranch,
  session,
  editor,
  base,
  onResult,
}: {
  repo: TaskRepo;
  taskBranch: string;
  session?: string;
  editor: string;
  base?: string;
  onResult: Props['onResult'];
}): React.JSX.Element {
  const act = async (request: Parameters<typeof send>[0]): Promise<void> => {
    const result = await send(request);
    onResult(result.detail, result.ok);
  };

  return (
    <div className="pane-repo">
      <div className="pane-repo-line">
        <span className="pane-repo-name">{repo.name}</span>
        {repo.dirty > 0 ? (
          <span className="dirty" title={`${repo.dirty} uncommitted change(s)`}>
            {repo.dirty} dirty
          </span>
        ) : (
          <span className="clean">clean</span>
        )}
        {hasDriftedOffBranch(repo.name, repo.branch, taskBranch) && (
          <span className="off-branch" title="not the branch this worktree was made for">
            {repo.branch}
          </span>
        )}
        <span className="pane-repo-gap" />
        {/* Gated on a session for the reason it is on the card: the editor needs a
            pane to land in, and a dormant task has none. */}
        {session && (
          <button
            className="chip"
            onClick={() =>
              void act({
                kind: 'openEditor',
                session,
                cwd: repo.path,
                name: `${repo.name}-${editorLabel(editor)}`,
              })
            }
            title={`${editor} in a new pane on ${repo.path}`}
          >
            +{editorLabel(editor)}
          </button>
        )}
        <button
          className="chip"
          onClick={() => void act({ kind: 'openDifit', cwd: repo.path, base })}
          title={`difit on ${repo.path} vs ${base ?? 'its trunk'} — committed and uncommitted work together, from where the branch left it. New files are marked intent-to-add.`}
        >
          review
        </button>
      </div>
      <div className="pane-repo-path" title={repo.path}>
        {tildify(repo.path)}
      </div>
    </div>
  );
}

/**
 * One task, alone in the panel.
 *
 * Not a bigger card: a card is a row in a list, sized so that twelve of them can
 * be scanned, and the thing being asked for here is the opposite of scanning. So
 * the chrome comes off — no border around the whole, because the window already
 * is the border — the facts are grouped under labels, everything is open, and the
 * blocks that the card can only hint at (a permission prompt, a worktree's real
 * path, notes you have not written yet) are given the room to be read.
 *
 * It shares every leaf with `TaskCard` — the agent rows, the pull request rows,
 * the notes editor — so the two views cannot come to disagree about what a task
 * is. What differs is only the arrangement, which is the whole difference between
 * a list and a page.
 */
export function TaskPane({
  task,
  prs,
  prsStale,
  session,
  editor,
  onResult,
  onBack,
}: Props): React.JSX.Element {
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [addingRepo, setAddingRepo] = useState(false);
  const [repoName, setRepoName] = useState('');
  const [editingNotes, setEditingNotes] = useState(false);
  /* Held apart from `task.notes`, which a snapshot replaces every second. */
  const [draft, setDraft] = useState('');

  const act = async (request: Parameters<typeof send>[0]): Promise<void> => {
    const result = await send(request);
    onResult(result.detail, result.ok);
  };

  const { taskLevel, byRepo } = partitionAgents(task, session?.agents ?? []);
  const dormant = !task.session;

  const openNotes = (): void => {
    setDraft(task.notes ?? '');
    setEditingNotes(true);
  };

  /** Agent buttons work on a dormant task too — they make the session first. */
  const startAgent = (tool: 'claude' | 'cursor'): void => {
    if (task.session) {
      void act({ kind: 'spawnAgent', session: task.session, cwd: task.dir, tool });
    } else {
      void act({ kind: 'startTaskSession', slug: task.slug, agent: tool });
    }
  };

  /*
   * Every agent in the task, in one list.
   *
   * The card files them under the worktree they are in, which is the right shape
   * for a row you are scanning — but on a page about one task, "what is running"
   * is a question with one answer, and splitting it across two sections meant the
   * agents section could read as empty while an agent was plainly working two
   * inches below it. The worktree rides on the row instead.
   *
   * How they are doing, in the words the fleet already uses.
   *
   * Counted here rather than taken from `fleet.counts`, which is the whole panel's
   * tally: this section is about the agents in *this* task, and a summary that
   * quietly counted the other eleven sessions would be the one number on the page
   * that is not about what the page is about.
   */
  const agents = [
    // At the task root first — they are the ones acting on the whole of it.
    ...taskLevel.map((agent) => ({ agent, where: undefined as string | undefined })),
    ...[...byRepo.entries()].flatMap(([repo, inRepo]) =>
      inRepo.map((agent) => ({ agent, where: repo })),
    ),
  ];
  const working = agents.filter(({ agent }) => agent.status === 'working').length;
  const waiting = agents.filter(
    ({ agent }) => agent.status === 'blocked_permission' || agent.status === 'blocked_input',
  ).length;
  const agentSummary = [
    working > 0 ? `${working} working` : '',
    waiting > 0 ? `${waiting} waiting on you` : '',
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div className="pane">
      <div className="pane-head">
        <div className="pane-title">
          <span className={`attached-dot${session && session.attached > 0 ? '' : ' detached'}`}>●</span>
          <span className={`pane-slug${dormant ? ' dormant' : ''}`}>{task.slug}</span>
          <span className="badge kind">task</span>
        </div>
        <div className="pane-branch" title={task.branch}>
          {task.branch}
        </div>
        {/* The one string the card has no room for at all, and the one you paste
            into a terminal. */}
        <div className="pane-dir" title={task.dir}>
          {tildify(task.dir)}
        </div>
      </div>

      {/* Under the title rather than at the foot of a card: on a page about one
          thing, what you do to it belongs beside its name. */}
      <div className="pane-actions">
        {/* What the card's header click used to be. It has to be a control of its
            own here — the header is no longer a row you can click. */}
        <button
          className="chip go"
          onClick={
            task.session
              ? () => void act({ kind: 'focusSession', session: task.session as string })
              : () => void act({ kind: 'startTaskSession', slug: task.slug })
          }
          title={task.session ? `focus ${task.session} · ${task.dir}` : `no session yet — open one on ${task.dir}`}
        >
          {task.session ? '→ tmux' : '+ session'}
        </button>
        <button className="chip" onClick={() => startAgent('claude')} title="claude at the task root">
          + claude
        </button>
        <button className="chip" onClick={() => startAgent('cursor')} title="cursor-agent at the task root">
          + cursor
        </button>
        <button
          className="chip"
          onClick={() => setAddingRepo(true)}
          title="add a repo — or another branch of one already here, for stacked work"
        >
          + repo
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
            // Nothing left to be focused on once the folder is gone.
            onBack();
            void act({ kind: 'archiveTask', slug: task.slug });
          }}
          title="remove every worktree in this task and kill its session"
        >
          {confirmArchive ? 'archive — sure?' : 'archive'}
        </button>
      </div>

      {addingRepo && (
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
                // Not the pane: escape closes whatever is innermost.
                event.stopPropagation();
                setAddingRepo(false);
                setRepoName('');
              }
            }}
          />
          <button className="chip" type="submit">
            add
          </button>
        </form>
      )}

      <Section title="agents" summary={agentSummary || undefined}>
        {agents.length > 0 ? (
          <div className="pane-block">
            {agents.map(({ agent, where }) => (
              <AgentRow key={agent.key} agent={agent} where={where} onResult={onResult} />
            ))}
          </div>
        ) : (
          <Nothing>
            {dormant
              ? 'No session yet — the worktrees are on disk and nothing is running them. + claude makes the session first.'
              : 'The session is up with no agent in it.'}
          </Nothing>
        )}
      </Section>

      <Section title="worktrees" summary={repoSummary(task.repos, task.branch)}>
        {task.repos.length > 0 ? (
          <div className="pane-block">
            {task.repos.map((repo) => (
              <PaneRepo
                key={repo.name}
                repo={repo}
                taskBranch={task.branch}
                session={task.session}
                editor={editor}
                base={baseFor(prs, repo)}
                onResult={onResult}
              />
            ))}
          </div>
        ) : (
          <Nothing>No repos in this task yet — + repo puts one here.</Nothing>
        )}
      </Section>

      <Section
        title="pull requests"
        summary={prs && prs.length > 0 ? `${prSummary(prs)}${prsStale ? ' · stale' : ''}` : undefined}
      >
        {prs === undefined ? (
          <Nothing>Asking GitHub…</Nothing>
        ) : prs.length > 0 ? (
          <div
            className="pane-block"
            title={prsStale ? 'gh returned nothing on the last search — this is the previous answer' : undefined}
          >
            {prs.map((pr) => (
              <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} onResult={onResult} />
            ))}
          </div>
        ) : (
          <Nothing>Nothing open on GitHub for these branches.</Nothing>
        )}
      </Section>

      <Section title="notes" summary="NOTES.md">
        <TaskNotes
          notes={task.notes}
          editing={editingNotes}
          draft={draft}
          onDraft={setDraft}
          onOpen={openNotes}
          onCancel={() => setEditingNotes(false)}
          onSave={() => {
            setEditingNotes(false);
            void act({ kind: 'setTaskNotes', slug: task.slug, notes: draft });
          }}
          placeholder="Write what this task is for — kept beside the worktrees."
        />
      </Section>
    </div>
  );
}
