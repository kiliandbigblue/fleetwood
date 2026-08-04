import { useState } from 'react';
import type { FleetSession } from '@fleetwood/core';
import { AgentRow } from './AgentRow.tsx';
import { cost, send, shortenPath, tildify, usageTitle } from './api.ts';

interface Props {
  session: FleetSession;
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

export function SessionCard({ session, onResult }: Props): React.JSX.Element {
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
        <span className={`attached-dot${session.attached > 0 ? '' : ' detached'}`}>●</span>
        <span className="session-name">{session.name}</span>
        {session.meta.pr ? (
          <span className="badge pr">#{session.meta.pr.split('#')[1]}</span>
        ) : (
          session.meta.kind && <span className="badge kind">{session.meta.kind}</span>
        )}
        {!session.meta.branch && (
          <span className="head-path">{shortenPath(session.path, 22)}</span>
        )}
        {/* What this session has cost across its agents — the number you want
            when the question is "is this branch worth what it's burning". */}
        {session.usage && (
          <span className="cost session-cost" title={usageTitle(session.usage)}>
            {cost(session.usage)}
          </span>
        )}
      </div>

      {/* Branch gets its own line: it is the longest string on the card and was
          squeezing everything else at panel width. */}
      {session.meta.branch && (
        <div className="branch-line" title={`${session.meta.branch} · ${tildify(session.path)}`}>
          {session.meta.branch}
        </div>
      )}

      <div className="card-actions">
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

      {agents.length > 0 ? (
        <div className="agents">
          {agents.map((agent) => (
            <AgentRow key={agent.key} agent={agent} onResult={onResult} />
          ))}
        </div>
      ) : (
        <div className="agent">
          <span className="activity" style={{ color: 'var(--muted)' }}>
            no agents · {paneCount} pane{paneCount === 1 ? '' : 's'}
          </span>
        </div>
      )}
    </div>
  );
}
