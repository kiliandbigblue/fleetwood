import { useState } from 'react';
import type { FleetAgent } from '@fleetwood/core';
import { duration, send } from './api.ts';

interface Props {
  agent: FleetAgent;
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

export function AgentRow({ agent, onResult }: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false);

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
        {agent.nested && (
          <span className="nested" title="a background or spawned agent, not the one at the terminal">
            ⤶
          </span>
        )}
        {agent.subagents > 0 && (
          <span className="subagents" title={`${agent.subagents} subagents running`}>
            +{agent.subagents}
          </span>
        )}
        <span className="activity">{label}</span>
        <span className="since">{duration(agent.forSeconds)}</span>
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
