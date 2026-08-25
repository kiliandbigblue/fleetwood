import type { FleetState } from '@fleetwood/core';
import { Icon } from './Icon.tsx';

/**
 * The two lists.
 *
 * Tasks used to be a third: a task with a session was rendered twice — once in the
 * fleet as a bare session card with half its controls missing, once under its own
 * tab as a task card that knew nothing about the agents running in it. They are the
 * same object, so they are now one card in one list, and `TaskCard` is what a
 * session card becomes when we know it is working a task.
 *
 * The type lives here because this is what a tab *is* — a label, a count, and the
 * one number that would make you come over. `App` only needs the name of the one
 * that is showing.
 */
export type Tab = 'fleet' | 'prs';

interface Props {
  tab: Tab;
  onTab: (tab: Tab) => void;
  /** Undefined until the first snapshot: the rail draws its labels either way. */
  counts?: FleetState['counts'];
  /** Sessions plus the tasks with no session — the whole of the one list. */
  fleetCount: number;
  /** Undefined while GitHub is still answering, which the count shows as `…`. */
  prCount?: number;
  toDeploy: number;
  pinned: boolean;
  onPin: () => void;
  onRefresh: () => void;
  /** The theme picker, passed in because it owns its own popover state. */
  themePicker?: React.ReactNode;
}

/**
 * A tab, and the one number that would make you switch to it.
 *
 * `total` is inventory — how much is over there. `alert` is the thing you would
 * cross the panel for, and it is drawn as a status dot rather than as a pill
 * because a dot is already what the agent rows use for exactly this. Before, both
 * lived in a separate row of pills, which meant the number that mattered and the
 * control that acted on it were in different places and different shapes.
 */
interface Entry {
  id: Tab;
  label: string;
  total: number | undefined;
  alert: number;
  /** The status role the dot paints in — `danger`, `warn`, or `accent`. */
  tone: string;
  title: string;
}

export function TopBar({
  tab,
  onTab,
  counts,
  fleetCount,
  prCount,
  toDeploy,
  pinned,
  onPin,
  onRefresh,
  themePicker,
}: Props): React.JSX.Element {
  const permission = counts?.blocked_permission ?? 0;
  const input = counts?.blocked_input ?? 0;
  const blocked = permission + input;

  const entries: Entry[] = [
    {
      id: 'fleet',
      label: 'fleet',
      total: fleetCount,
      alert: blocked,
      /*
       * The two blocked states are different colours on the rows below — a
       * permission prompt is `danger`, a question is `warn` — and summing them
       * into one dot has to pick one. It picks the louder of the two whenever a
       * permission prompt is among them, because that is the one holding an agent
       * completely still. The exact split is in the tooltip.
       */
      tone: permission > 0 ? 'danger' : 'warn',
      title:
        blocked === 0
          ? 'tmux sessions, and the tasks with nothing running them'
          : [
              permission > 0 ? `${permission} waiting on a permission prompt` : '',
              input > 0 ? `${input} waiting on an answer` : '',
            ]
              .filter(Boolean)
              .join(', '),
    },
    {
      id: 'prs',
      label: 'prs',
      total: prCount,
      // Merged, image built, and nothing deployed it: the one PR state that is
      // waiting on you rather than on CI.
      alert: toDeploy,
      tone: 'accent',
      title:
        toDeploy === 0
          ? 'pull requests — yours, waiting on your review, and recently merged'
          : `${toDeploy} merged and built, nothing deployed it`,
    },
  ];

  return (
    <header className="rail rail-top">
      <nav className="nav">
        {entries.map((entry) => (
          <button
            key={entry.id}
            className={`nav-tab${tab === entry.id ? ' active' : ''}`}
            title={entry.title}
            aria-current={tab === entry.id}
            onClick={() => onTab(entry.id)}
          >
            <span className="nav-label">{entry.label}</span>
            <span className="nav-total">{entry.total ?? '…'}</span>
            {entry.alert > 0 && (
              <span className={`nav-alert ${entry.tone}`}>
                <span className="dot" />
                {entry.alert}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="rail-controls">
        {themePicker}
        <button
          className={`icon-button${pinned ? ' on' : ''}`}
          title="keep on top of other windows"
          aria-pressed={pinned}
          onClick={onPin}
        >
          <Icon name="above" />
        </button>
        <button className="icon-button" title="refresh (⌘R)" onClick={onRefresh}>
          <Icon name="refresh" />
        </button>
      </div>
    </header>
  );
}
