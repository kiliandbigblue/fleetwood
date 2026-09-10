import { useState } from 'react';
import type { FleetSession, Task, TaskPr } from '@fleetwood/core';
// The leaf module: the barrel re-exports tmux and process scanning, which fail the
// renderer bundle on `node:child_process`.
import {
  baseFor,
  groupPrStacks,
  partitionAgents,
  prRepoTags,
  prSummary,
  repoSummary,
  worstState,
} from '@fleetwood/core/taskView';
import { isPinned } from '@fleetwood/core/sessionOrder';
import { AddRepo } from './AddRepo.tsx';
import { AgentRow } from './AgentRow.tsx';
import { CardMenu } from './CardMenu.tsx';
import type { MenuItem } from './CardMenu.tsx';
import { Icon } from './Icon.tsx';
import { Slug } from './Slug.tsx';
import { TaskNotes } from './TaskNotes.tsx';
import { dotNote, numColStyle, PrRow, RepoRow } from './TaskCard.tsx';
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
 * What a section has instead of rows.
 *
 * Quiet, like a clean worktree: the page still says the section exists, so it
 * does not change shape as the task progresses, but it does not draw a dashed
 * box around the fact that nothing is in it yet.
 */
function Quiet({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="pane-quiet">{children}</div>;
}

/**
 * One task, alone in the panel.
 *
 * The same rows as `TaskCard`, in the same order, with the same menu — the list
 * was refactored to a flat sheet, and a page that still boxed every section
 * would be the one place in the panel that still looked like the old cards.
 * What the page adds is only the facts the list has nowhere to put: the folder
 * you paste into a terminal, each worktree's path in full, and a quiet line
 * where a section would otherwise vanish.
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
  const [addingRepo, setAddingRepo] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);
  /* Held apart from `task.notes`, which a snapshot replaces every second. */
  const [draft, setDraft] = useState('');

  const act = async (request: Parameters<typeof send>[0]): Promise<void> => {
    const result = await send(request);
    onResult(result.detail, result.ok);
  };

  const { taskLevel, byRepo } = partitionAgents(task, session?.agents ?? []);
  // Same rule as the card's: empty unless the pull requests span repos, so the
  // two views cannot come to disagree about when the tag is worth showing.
  const repoTags = prRepoTags(prs ?? []);
  const needsAttention = session?.needsAttention ?? false;
  const state = worstState(task.repos, prs, needsAttention, session?.agents);
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

  const agents = [
    // At the task root first — they are the ones acting on the whole of it.
    ...taskLevel.map((agent) => ({ agent, where: undefined as string | undefined })),
    ...[...byRepo.entries()].flatMap(([repo, inRepo]) =>
      inRepo.map((agent) => ({ agent, where: repo })),
    ),
  ];

  const actions: MenuItem[] = [
    {
      label: 'add repo',
      title: 'add a repo — or another branch of one already here, for stacked work',
      onClick: () => setAddingRepo(true),
    },
    { label: 'start claude', title: 'claude at the task root', onClick: () => startAgent('claude') },
    { label: 'start cursor', title: 'cursor-agent at the task root', onClick: () => startAgent('cursor') },
    ...(dormant
      ? [
          {
            label: 'start shell',
            title: 'tmux session at the task root, left at a shell',
            onClick: () => void act({ kind: 'startTaskSession', slug: task.slug }),
          },
        ]
      : []),
    {
      label: task.notes ? 'notes' : 'add a note',
      title: 'your own notes on this task, kept in NOTES.md',
      onClick: openNotes,
    },
    {
      label: 'archive',
      title: 'remove every worktree in this task and kill its session',
      danger: true,
      confirm: true,
      onClick: () => {
        // Nothing left to be focused on once the folder is gone.
        onBack();
        void act({ kind: 'archiveTask', slug: task.slug });
      },
    },
  ];

  return (
    <div className={`card pane${needsAttention ? ' attention' : ''}${dormant ? ' dormant' : ''}`}>
      <div
        className="card-head"
        onClick={
          task.session
            ? () => void act({ kind: 'focusSession', session: task.session as string })
            : () => void act({ kind: 'startTaskSession', slug: task.slug })
        }
        title={
          task.session
            ? `${task.branch} · focus ${task.session} · ${task.dir}`
            : `${task.branch} · no session yet — open one on ${task.dir}`
        }
      >
        <span
          className={`attached-dot sev-${state}${
            session && session.attached > 0 ? '' : ' detached'
          }`}
          title={dotNote(state, (session?.attached ?? 0) > 0, task.session !== undefined)}
        />
        <span className="session-name">
          <Slug text={task.slug} />
        </span>
        {task.session && isPinned(task.session) && (
          <span className="pin-mark" title="pinned above the unpinned sessions">
            <Icon name="pin" />
          </span>
        )}
        <span className="repo-summary">{repoSummary(task.repos, task.branch)}</span>
        <span className="row-act">
          <CardMenu session={task.session} actions={actions} onResult={onResult} />
        </span>
      </div>

      {/* The one string the card has no room for at all, and the one you paste
          into a terminal. */}
      <div className="pane-dir" title={task.dir}>
        {tildify(task.dir)}
      </div>

      {addingRepo && (
        <AddRepo task={task} onClose={() => setAddingRepo(false)} onResult={onResult} />
      )}

      {agents.length > 0 ? (
        <div className="agents">
          {agents.map(({ agent, where }) => (
            <AgentRow key={agent.key} agent={agent} where={where} onResult={onResult} />
          ))}
        </div>
      ) : (
        <Quiet>
          {dormant
            ? 'No session yet — the worktrees are on disk and nothing is running them.'
            : 'The session is up with no agent in it.'}
        </Quiet>
      )}

      {task.repos.length > 0 ? (
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
              path={repo.path}
              onResult={onResult}
            />
          ))}
        </div>
      ) : (
        <Quiet>No repos in this task yet — add one from the menu.</Quiet>
      )}

      {prs === undefined ? (
        <Quiet>Asking GitHub…</Quiet>
      ) : prs.length > 0 ? (
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
            const blocked = rows.some((row) => row.waitingOn !== undefined);
            return rows.map((row) => (
              <PrRow
                key={`${row.pr.repo}#${row.pr.number}`}
                pr={row.pr}
                repoTag={repoTags[`${row.pr.repo}#${row.pr.number}`]}
                stack={row}
                railed={railed}
                blocked={blocked}
                onResult={onResult}
              />
            ));
          })()}
        </div>
      ) : (
        <Quiet>Nothing open on GitHub for these branches.</Quiet>
      )}

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
    </div>
  );
}
