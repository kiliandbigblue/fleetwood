import { useState } from 'react';
import type { FleetAgent } from '@fleetwood/core';
// The leaf module, not the barrel: importing a value from `@fleetwood/core`
// pulls tmux, `fs` and `child_process` into the renderer bundle — which is the
// reason the formatter lives apart from the reader in the first place.
import { describeContext, formatContextTokens } from '@fleetwood/core/contextFormat';
import { duration, send } from './api.ts';
import { AGENT_STATUS_LABEL, agentLabel } from './fleetSignals.ts';

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
  const label = agentLabel(agent);
  const statusLabel = AGENT_STATUS_LABEL[agent.status];

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
          title={`${statusLabel} — ${PROVENANCE_NOTE[agent.provenance] ?? agent.provenance}`}
        />
        {/* The dot's meaning, for whoever cannot see its colour. Said once, here,
            rather than on the activity text, which can be anything. */}
        <span className="sr-only">{statusLabel},</span>
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
        {/*
         * The row's keyboard target, when the row has a pane to go to.
         *
         * The row itself stays the pointer's target — the whole 28px strip — but
         * a row is not something a keyboard can land on, and a `div` with a click
         * handler was the one way into a pane that Tab never reached. A button
         * here, with no handler of its own, is focusable and presses the same way
         * a click does: its click bubbles to the row.
         */}
        {agent.pane ? (
          <button type="button" className="activity">
            {label}
          </button>
        ) : (
          <span className="activity">{label}</span>
        )}
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
        <PromptBlock
          /* Keyed on the question, so a new prompt in the same pane starts with
             nothing marked as sent. */
          key={`${prompt.question ?? ''}|${prompt.options.map((option) => option.key).join(',')}`}
          tool={agent.tool}
          pane={agent.pane}
          prompt={prompt}
          fallback={statusLabel}
          onResult={onResult}
        />
      )}
    </>
  );
}

/**
 * A permission prompt, answered from the card.
 *
 * The terminal's own options are the buttons. It used to print them as a list
 * and then offer a separate Approve / Deny / Open under it — six things for
 * three choices, and the middle option, "yes, and don't ask again", was on
 * screen with no way to press it. Each option is now the one control for it,
 * numbered as the terminal numbers it, and the number is also its key on a
 * focused card, as it is in the pane.
 *
 * Once one is pressed the block says so and holds still until the next
 * snapshot takes the prompt away, so there is never a moment where the
 * answer appears to have gone nowhere.
 */
function PromptBlock({
  tool,
  pane,
  prompt,
  fallback,
  onResult,
}: {
  tool: FleetAgent['tool'];
  pane: string;
  prompt: NonNullable<FleetAgent['prompt']>;
  /** What to call the prompt when the screen gave no question. */
  fallback: string;
  onResult: Props['onResult'];
}): React.JSX.Element {
  const [sent, setSent] = useState<string>();

  const answer = async (key: string, label: string): Promise<void> => {
    setSent(`${key} · ${label}`);
    const result = await send({ kind: 'answerPrompt', pane, key });
    // Only a failure is worth a toast; success is the line on the card.
    if (!result.ok) {
      setSent(undefined);
      onResult(result.detail, false);
    }
  };

  return (
    <div className="prompt" role="group" aria-label={`${tool} asks: ${prompt.question ?? fallback}`}>
      {prompt.question && <div className="prompt-question">{prompt.question}</div>}
      <div className="prompt-buttons">
        {prompt.options.map((option) => (
          <button
            key={option.key}
            type="button"
            className={`button prompt-answer${
              option.key === prompt.approve ? ' approve' : option.key === prompt.deny ? ' deny' : ''
            }`}
            data-key={option.key}
            disabled={sent !== undefined}
            title={`answer ${option.key} — or press ${option.key} with this card focused${
              option.key === prompt.approve ? ' (a also works)' : option.key === prompt.deny ? ' (d also works)' : ''
            }`}
            onClick={() => void answer(option.key, option.label)}
          >
            <kbd className="key-cap">{option.key}</kbd>
            {option.label}
          </button>
        ))}
        <button
          type="button"
          className="button prompt-open"
          onClick={() =>
            void send({ kind: 'focusPane', pane }).then((result) => onResult(result.detail, result.ok))
          }
          title="open the pane and answer it yourself"
        >
          open ↗
        </button>
      </div>
      {sent && (
        <div className="prompt-sent" role="status">
          sent {sent} — waiting for the agent to move on
        </div>
      )}
    </div>
  );
}
