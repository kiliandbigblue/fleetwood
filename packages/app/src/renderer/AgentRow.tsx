import { useState } from 'react';
import type { FleetAgent } from '@fleetwood/core';
// The leaf module, not the barrel: importing a value from `@fleetwood/core`
// pulls tmux, `fs` and `child_process` into the renderer bundle — which is the
// reason the formatter lives apart from the reader in the first place.
import { describeContext, formatContextTokens } from '@fleetwood/core/contextFormat';
import { duration, send } from './api.ts';

interface Props {
  agent: FleetAgent;
  /**
   * The worktree this agent is working in, when the list it is in mixes them.
   *
   * Both the card and the pane list every agent of a task in one block, so the
   * worktree has to ride on the row rather than being implied by nesting. An
   * agent at the task root has nothing to say here.
   */
  where?: string;
  onResult: (message: string, ok: boolean) => void;
}

const STATUS_LABEL: Record<string, string> = {
  working: 'working',
  blocked_permission: 'needs permission',
  blocked_input: 'waiting on you',
  compacting: 'compacting',
  idle: 'idle',
  starting: 'starting',
  error: 'error',
  gone: 'gone',
};

/**
 * How the status was learned, as tooltip prose rather than a glyph.
 *
 * It used to render as its own `~` / `?` / `…` column, which at panel width cost
 * more space than the nuance was worth. The dot still carries it on hover.
 */
const PROVENANCE_NOTE: Record<string, string> = {
  hook: 'reported by the agent',
  screen: 'read off the pane, not reported',
  process: 'a process is running but sent no hooks',
  stale: 'last reported a while ago, unconfirmed',
};

/**
 * What closing this agent will actually do, since it isn't the same act in every
 * case — and on a session running several agents the difference is the whole
 * point of the button.
 */
function killNote(agent: FleetAgent): string {
  if (agent.hosted === 'daemon') {
    return 'close this agent — kills the worker it runs in, not the pane showing it';
  }
  if (agent.nested) return 'close this agent — the one that spawned it keeps running';
  return 'close this agent — its pane, scrollback and session stay';
}

export function AgentRow({ agent, where, onResult }: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [confirmingKill, setConfirmingKill] = useState(false);

  const act = async (request: Parameters<typeof send>[0]): Promise<void> => {
    setBusy(true);
    const result = await send(request);
    setBusy(false);
    onResult(result.detail, result.ok);
  };

  const prompt = agent.prompt;
  const label = agent.activity ?? STATUS_LABEL[agent.status] ?? agent.status;

  return (
    <>
      {/* Clicking the row goes to the pane. An inline scrollback dump was the
          earlier idea and it read as noise — if you want the history, you want the
          real terminal, with its colours and its scroll. */}
      <div
        className={`agent${agent.pane ? ' clickable' : ''}`}
        onClick={agent.pane ? () => void act({ kind: 'focusPane', pane: agent.pane as string }) : undefined}
        title={agent.pane ? `go to ${agent.pane} — ${label}` : label}
      >
        <span
          className={`status-dot status-${agent.status}`}
          title={`${STATUS_LABEL[agent.status] ?? agent.status} — ${PROVENANCE_NOTE[agent.provenance] ?? agent.provenance}`}
        />
        <span className={`tool tool-${agent.tool}`}>{agent.tool}</span>
        {where && (
          <span className="agent-where" title={`working in ${where}`}>
            {where}
          </span>
        )}
        {agent.nested && (
          <span className="nested" title="a background or spawned agent, not the one at the terminal">
            ⤶
          </span>
        )}
        {agent.hosted === 'daemon' && (
          <span
            className="nested"
            title="runs in the claude daemon, not in this pane — matched to it by working directory and version"
          >
            ⇢
          </span>
        )}
        {agent.subagents > 0 && (
          <span className="subagents" title={`${agent.subagents} subagents running`}>
            +{agent.subagents}
          </span>
        )}
        <span className="activity">{label}</span>
        {/* What the next turn in this pane will re-read, and so what it will
            cost relative to a fresh one. The only number on this row you can
            act on without leaving the panel: `/clear` empties it. A column of
            its own, held open across the list, because an agent whose
            transcript we cannot read leaves it blank and the rows either side
            still have to line up. */}
        <span className="agent-context">
          {agent.contextTokens !== undefined && (
            <span
              className={`context-fig ${agent.contextBand ?? ''}`}
              title={describeContext(agent.contextTokens)}
            >
              {formatContextTokens(agent.contextTokens)}
            </span>
          )}
        </span>
        {/* "up 6h" reads as uptime. A bare "6h" against a status nothing timed —
            a process we only found in `ps` — claims it has been working that long. */}
        <span
          className="since"
          title={agent.ageIsUptime ? 'how long the process has been up' : 'how long in this status'}
        >
          {agent.ageIsUptime ? `up ${duration(agent.forSeconds)}` : duration(agent.forSeconds)}
        </span>
        {/* Per-agent, because killing the session is the wrong instrument once more
            than one agent is in it. Two-step for the same reason `archive` is: an
            agent's context dies with it and there is no undo. Nothing to close on
            an agent that is already gone, so the control isn't there. */}
        <span className="row-act">
        {agent.status !== 'gone' && (
          <button
            className={`agent-kill${confirmingKill ? ' confirming' : ''}`}
            disabled={busy}
            title={confirmingKill ? `${killNote(agent)} — click again to confirm` : killNote(agent)}
            onClick={(event) => {
              // The row itself focuses the pane; this button must not do both.
              event.stopPropagation();
              if (!confirmingKill) {
                setConfirmingKill(true);
                setTimeout(() => setConfirmingKill(false), 4_000);
                return;
              }
              setConfirmingKill(false);
              void act({ kind: 'killAgent', key: agent.key });
            }}
          >
            {confirmingKill ? 'close — sure?' : '×'}
          </button>
        )}
        </span>
      </div>

      {prompt && agent.pane && (
        <div className="prompt">
          {prompt.question && <div className="prompt-question">{prompt.question}</div>}
          <div className="prompt-options">
            {prompt.options.map((option) => (
              <span key={option.key} className={`prompt-option${option.selected ? ' selected' : ''}`}>
                {option.selected ? '❯' : ' '} {option.key}. {option.label}
              </span>
            ))}
          </div>
          <div className="prompt-buttons">
            {prompt.approve && (
              <button
                className="button approve"
                disabled={busy}
                onClick={() =>
                  void act({ kind: 'answerPrompt', pane: agent.pane as string, key: prompt.approve as string })
                }
              >
                Approve
              </button>
            )}
            {prompt.deny && (
              <button
                className="button deny"
                disabled={busy}
                onClick={() =>
                  void act({ kind: 'answerPrompt', pane: agent.pane as string, key: prompt.deny as string })
                }
              >
                Deny
              </button>
            )}
            <button
              className="button"
              onClick={() => void act({ kind: 'focusPane', pane: agent.pane as string })}
              title="open the pane and answer it yourself"
            >
              Open
            </button>
          </div>
        </div>
      )}
    </>
  );
}
