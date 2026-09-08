import { useState } from 'react';
import type { FleetSession } from '@fleetwood/core';
import { isPinned, sessionLabel } from '@fleetwood/core/sessionOrder';
import { AgentRow } from './AgentRow.tsx';
import { Icon } from './Icon.tsx';
import { dotNote } from './TaskCard.tsx';
import { Reorder } from './Reorder.tsx';
import { Slug } from './Slug.tsx';
import { send, shortenPath, tildify } from './api.ts';

interface Props {
  session: FleetSession;
  /** Session names in fleet order, for the reorder arrows. */
  order: string[];
  onResult: (message: string, ok: boolean) => void;
}

/** Whoever needs the human is listed first. */
const RANK: Record<string, number> = {
  blocked_permission: 0,
  blocked_input: 1,
  error: 2,
  working: 3,
  compacting: 4,
  starting: 5,
  idle: 6,
  gone: 7,
};

export function SessionCard({ session, order, onResult }: Props): React.JSX.Element {
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  const act = async (request: Parameters<typeof send>[0]): Promise<void> => {
    const result = await send(request);
    onResult(result.detail, result.ok);
  };

  const agents = [...session.agents].sort(
    (a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9),
  );
  const paneCount = session.windows.reduce((n, w) => n + w.panes.length, 0);
  const cwd = session.windows[0]?.panes[0]?.cwd ?? session.path;
  const isPr = session.meta.kind === 'pr';

  return (
    <div className={`card${session.needsAttention ? ' attention' : ''}`}>
      {/* The whole header focuses the session — a separate "focus" button next to a
          clickable title was two controls for one action. */}
      <div
        className="card-head"
        onClick={() => void act({ kind: 'focusSession', session: session.name })}
        title={`focus ${session.name} · ${tildify(session.path)}`}
      >
        {/* Colour is the state, shape is attachment — as on a task group. The
            state is spelled out rather than asked of `worstState`: a session has
            no worktrees and no pull requests, and passing it two empty arrays
            would read as having checked them. */}
        <span
          className={`attached-dot sev-${session.needsAttention ? 'danger' : 'quiet'}${
            session.attached > 0 ? '' : ' detached'
          }`}
          title={dotNote(session.needsAttention ? 'danger' : 'quiet', session.attached > 0, true)}
        />
        {/* The label, not the name: an order prefix is fleetwood's own bookkeeping
            and reading `20-atlas` on the card would be noise. The tooltip above
            carries the real name, which is what tmux answers to. */}
        <span className="session-name">
          <Slug text={sessionLabel(session.name)} />
        </span>
        {/* The one part of the prefix that is worth showing: a pinned card is at
            the top because someone put it there, and without a mark that reads
            as fleetwood having reordered the fleet on its own. */}
        {isPinned(session.name) && (
          <span className="pin-mark" title="pinned above the unpinned sessions">
            <Icon name="pin" />
          </span>
        )}
        {/*
         * The marker marks the exception, which is this card.
         *
         * `task` used to be worn by every card in the fleet — the rule, labelled.
         * The departure from it is a session fleetwood did not make: no task, no
         * worktree, nothing to archive, and only `@fw_kind` missing to say so,
         * since fleetwood is the only thing that ever writes that option. So the
         * word goes on the cards that had none.
         */}
        {session.meta.pr ? (
          <span className="badge pr">#{session.meta.pr.split('#')[1]}</span>
        ) : session.meta.kind ? (
          <span className="badge kind">{session.meta.kind}</span>
        ) : (
          <span className="badge kind" title="a tmux session fleetwood did not create — no task, no worktree">
            tmux
          </span>
        )}
        {!session.meta.branch && (
          <span className="head-path">{shortenPath(session.path, 22)}</span>
        )}
        {/* Last, on the trailing edge: it is this card's menu, and a menu lives at
            the end of the row it belongs to rather than beside the title. */}
        {/* Over the head's metadata, as on a task group — see the note there. */}
        <div
            className="card-actions"
            /* The head focuses the session; a chip in it must not also do that. */
            onClick={(event) => event.stopPropagation()}
          >
          <button
            className="chip"
            onClick={() => void act({ kind: 'spawnAgent', session: session.name, cwd, tool: 'claude' })}
            title="new window running claude"
          >
            + claude
          </button>
          <button
            className="chip"
            onClick={() => void act({ kind: 'spawnAgent', session: session.name, cwd, tool: 'cursor' })}
            title="new window running cursor-agent"
          >
            + cursor
          </button>
          <span style={{ marginLeft: 'auto' }} />
          {isPr ? (
            <button
              className="chip danger"
              onClick={() => {
                if (!confirmingArchive) {
                  setConfirmingArchive(true);
                  // Two-step because this also deletes a worktree.
                  setTimeout(() => setConfirmingArchive(false), 4_000);
                  return;
                }
                setConfirmingArchive(false);
                void act({ kind: 'archiveSession', session: session.name });
              }}
              title="kill the session and remove its worktree"
            >
              {confirmingArchive ? 'archive — sure?' : 'archive'}
            </button>
          ) : (
            <button
              className="chip danger"
              onClick={() => void act({ kind: 'killSession', session: session.name })}
              title="kill this tmux session"
            >
              kill
            </button>
          )}
        </div>
        <span className="row-act">
          <Reorder session={session.name} order={order} onResult={onResult} />
        </span>
      </div>

      {/* Branch gets its own line: it is the longest string on the card and was
          squeezing everything else at panel width. */}
      {session.meta.branch && (
        <div className="branch-line" title={`${session.meta.branch} · ${tildify(session.path)}`}>
          {session.meta.branch}
        </div>
      )}

      {agents.length > 0 ? (
        <div className="agents">
          {agents.map((agent) => (
            <AgentRow key={agent.key} agent={agent} onResult={onResult} />
          ))}
        </div>
      ) : (
        /* Wrapped like a group of one, so the space under it is the space under
           every other group of rows rather than 8px less. */
        <div className="agents">
          <div className="agent">
            <span className="activity" style={{ color: 'var(--dim)' }}>
              no agents · {paneCount} pane{paneCount === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      )}

    </div>
  );
}
