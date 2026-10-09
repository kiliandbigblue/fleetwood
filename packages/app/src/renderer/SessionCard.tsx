import type { FleetSession } from '@fleetwood/core';
import { sessionLabel } from '@fleetwood/core/sessionOrder';
import { AgentRow } from './AgentRow.tsx';
import { CardMenu } from './CardMenu.tsx';
import type { MenuItem } from './CardMenu.tsx';
import { Slug } from './Slug.tsx';
import { send, shortenPath, tildify } from './api.ts';
import { blockedPane, byUrgency, leadNote, liveSeverity, needsYouLabel, workingIsGuessed } from './fleetSignals.ts';
import type { Severity } from './fleetSignals.ts';

/**
 * The dot, in words — a bare session's version.
 *
 * A session is not a task and has no progress to report: nothing here has a
 * branch, a pull request or a trunk to have landed on. What it has is agents,
 * so the mark is what they are doing — see `liveSeverity`, which a live task
 * card now leads with too — and the sentence says it, and whether you are
 * attached.
 */
export function sevNote(state: Severity, attached: boolean, guessed = false): string {
  return `${leadNote(state, guessed)} · ${attached ? 'attached' : 'running, not attached'}`;
}

interface Props {
  session: FleetSession;
  /** Session names in fleet order, for the reorder arrows. */
  order: string[];
  onResult: (message: string, ok: boolean) => void;
  /**
   * The terminal you are at is showing this session — see `.card.here`.
   */
  here?: boolean;
}

export function SessionCard({ session, order, onResult, here }: Props): React.JSX.Element {
  const act = async (request: Parameters<typeof send>[0]): Promise<void> => {
    const result = await send(request);
    onResult(result.detail, result.ok);
  };

  const agents = byUrgency(session.agents);
  const paneCount = session.windows.reduce((n, w) => n + w.panes.length, 0);
  const cwd = session.windows[0]?.panes[0]?.cwd ?? session.path;
  // No repos or pull requests to weigh — a bare session's mark is agents only,
  // by the same rule a live task card's is, so the two marks mean one thing.
  const state = liveSeverity(session.agents);
  const needsYou = needsYouLabel(session.agents);
  const guessed = state === 'ok' && workingIsGuessed(session.agents);
  const askingPane = blockedPane(session.agents);

  /*
   * What this card can do, behind the header's dot column — as on a task group.
   *
   * A bare session has less to offer than a task does: two agents and the one
   * way to end it.
   */
  const actions: MenuItem[] = [
    {
      label: 'start claude',
      title: 'new window running claude',
      onClick: () => void act({ kind: 'spawnAgent', session: session.name, cwd, tool: 'claude' }),
    },
    {
      label: 'start cursor',
      title: 'new window running cursor-agent',
      onClick: () => void act({ kind: 'spawnAgent', session: session.name, cwd, tool: 'cursor' }),
    },
    {
      label: 'kill session',
      title: 'kill this tmux session and every pane in it',
      danger: true,
      confirm: true,
      onClick: () => void act({ kind: 'killSession', session: session.name }),
    },
  ];

  return (
    // The name and the id are for the arranging keys: the name is what a move is
    // asked about, the id is what finds the card again once the name has changed.
    <div
      className={`card${needsYou ? ' attention' : ''}${here ? ' here' : ''}`}
      data-session={session.name}
      data-session-id={session.sessionId}
    >
      {/* The whole header focuses the session — a separate "focus" button next to a
          clickable title was two controls for one action. */}
      <div
        className="card-head"
        onClick={() =>
          void act(askingPane ? { kind: 'focusPane', pane: askingPane } : { kind: 'focusSession', session: session.name })
        }
        title={
          askingPane
            ? `go to the pane asking for permission (${askingPane})`
            : `focus ${session.name} · ${tildify(session.path)}`
        }
      >
        {/* Colour is the state, shape is attachment — as on a task group. */}
        <span
          className={`attached-dot sev-${state}${guessed ? ' guessed' : ''}`}
          title={sevNote(state, session.attached > 0, guessed)}
        />
        {/* The label, not the name: an order prefix is fleetwood's own bookkeeping
            and reading `20-atlas` on the card would be noise. The tooltip above
            carries the real name, which is what tmux answers to. */}
        {/* The keyboard's way in — see the same button on `TaskCard`. */}
        <button type="button" className="session-name card-title">
          <Slug text={sessionLabel(session.name)} />
          <span className="sr-only">
            , {sevNote(state, session.attached > 0, guessed)}
            {here && ", you're here"}
          </span>
        </button>
        {/* Where a narrow card's head breaks onto a second line — see `.head-break`. */}
        {needsYou && <span className="head-break" aria-hidden="true" />}
        {needsYou && <span className="needs-you">{needsYou}</span>}
        {/*
         * The marker marks the exception, which is this card.
         *
         * `task` used to be worn by every card in the fleet — the rule, labelled.
         * The departure from it is a session fleetwood did not make: no task, no
         * worktree, nothing to archive, and only `@fw_kind` missing to say so,
         * since fleetwood is the only thing that ever writes that option. So the
         * word goes on the cards that had none.
         */}
        {session.meta.kind ? (
          <span className="badge kind">{session.meta.kind}</span>
        ) : (
          <span className="badge kind" title="a tmux session fleetwood did not create — no task, no worktree">
            tmux
          </span>
        )}
        {!session.meta.branch && (
          <span className="head-path">{shortenPath(session.path, 22)}</span>
        )}
        <span className="row-act">
          <CardMenu session={session.name} order={order} actions={actions} onResult={onResult} />
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
            <span className="activity agent-none">
              no agents · {paneCount} pane{paneCount === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
