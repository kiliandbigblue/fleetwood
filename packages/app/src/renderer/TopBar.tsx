import type { FleetState } from '@fleetwood/core';
import { Icon } from './Icon.tsx';

/**
 * The two lists, and the tab that is not one.
 *
 * Tasks used to be a third list: a task with a session was rendered twice — once in the
 * fleet as a bare session card with half its controls missing, once under its own
 * tab as a task card that knew nothing about the agents running in it. They are the
 * same object, so they are now one card in one list, and `TaskCard` is what a
 * session card becomes when we know it is working a task.
 *
 * The type lives here because this is what a tab *is* — a label, a value, and the
 * one number that would make you come over. `App` only needs the name of the one
 * that is showing.
 *
 * `power` is the odd one and is last for it: the other three are lists of work,
 * and that one is a setting about the machine the work happens on. It is a tab
 * rather than a corner of the theme popover because it is the only thing here
 * that acts on the machine, and a control that turns your computer off should be
 * somewhere you can see it from across the room.
 */
export type Tab = 'fleet' | 'prs' | 'history' | 'power';

interface Props {
  tab: Tab;
  onTab: (tab: Tab) => void;
  /** Undefined until the first snapshot: the rail draws its labels either way. */
  counts?: FleetState['counts'];
  /**
   * The sessions running in the list.
   *
   * Running ones only. It was sessions plus workspaces plus parked tasks — the
   * length of the list — which made it the one number in the rail that was
   * neither agents nor anything waiting: `5` on a morning with two sessions
   * live and three folders asleep. The parked count is in the tooltip.
   */
  fleetCount: number;
  /** Tasks and workspaces with no session, for the tab's tooltip. */
  parkedCount: number;
  /** Undefined while GitHub is still answering, which the count shows as `…`. */
  prCount?: number;
  /** Archived tasks. Read from a file, so it is never pending. */
  historyCount: number;
  /** The end-of-day shutdown, as the rail says it: a time, or `off`. */
  shutdownLabel: string;
  /**
   * Minutes until the machine goes down, once the warning is up.
   *
   * The rail's alert is a count everywhere else, and here it is a countdown — the
   * same shape for the same reason: it is the number that would make you come
   * over, and on this tab it is the only one that ever could.
   */
  shutdownAlert: number;
  toDeploy: number;
  pinned: boolean;
  onPin: () => void;
  onRefresh: () => void;
  /** Its three requests are still out — the button spins rather than looking idle. */
  refreshing: boolean;
  /** The theme picker, passed in because it owns its own popover state. */
  themePicker?: React.ReactNode;
  /**
   * The task the panel is focused on, when it is on one.
   *
   * The tabs step aside for it rather than sitting beside it: the pane is not a
   * third list, it is one of the two you are already in, opened. Leaving the tabs
   * up with neither of them marked would say the opposite.
   */
  focusedTask?: string;
  onBack: () => void;
  /** Start a task. Lives in the rail because it belongs to no row in the list. */
  onNewTask: () => void;
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
  /**
   * How much is over there — a count on the lists, a time on `power`.
   *
   * A string is allowed because `power` holds one thing and counting it would say
   * `1`, which is true and useless. `19:00` in the rail is the setting itself.
   */
  total: number | string | undefined;
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
  parkedCount,
  prCount,
  historyCount,
  shutdownLabel,
  shutdownAlert,
  toDeploy,
  pinned,
  onPin,
  onRefresh,
  refreshing,
  themePicker,
  focusedTask,
  onBack,
  onNewTask,
}: Props): React.JSX.Element {
  /*
   * Beside the tabs, not beside the window controls.
   *
   * The rail's hairline splits what acts on the fleet from what acts on the
   * window, and against that divider a `+` reads as the first of four icons on
   * the wrong side of it. Next to `history` it reads as what it is.
   */
  const newTask = (
    <button className="rail-new" onClick={onNewTask} title="new task (⌘T)">
      <Icon name="plus" />
    </button>
  );

  const blocked = counts?.blocked_permission ?? 0;

  const entries: Entry[] = [
    {
      id: 'fleet',
      label: 'fleet',
      total: fleetCount,
      alert: blocked,
      // `danger`, like the band on the card it counts: an agent that has
      // stopped until you answer a permission prompt.
      tone: 'danger',
      title:
        blocked === 0
          ? `${fleetCount} running${parkedCount > 0 ? `, ${parkedCount} with nothing running them` : ''} · ? for keys`
          : `${blocked} waiting on a permission prompt — press n to go to the next one`,
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
    {
      id: 'history',
      label: 'history',
      total: historyCount,
      // A record never needs you. Nothing in here is actionable by design, so it
      // is the one tab that has no reason to ever grow a dot.
      alert: 0,
      tone: 'accent',
      title: 'tasks you archived — what they were, and where the work landed',
    },
    {
      id: 'power',
      label: 'power',
      total: shutdownLabel,
      alert: shutdownAlert,
      // `danger`, like a permission prompt: both are a thing about to stop, and
      // this is the only one that takes the machine with it.
      tone: 'danger',
      title:
        shutdownAlert > 0
          ? `this machine shuts down in ${shutdownAlert} minute${shutdownAlert === 1 ? '' : 's'}`
          : 'when this machine shuts down at the end of the day',
    },
  ];

  if (focusedTask) {
    return (
      <header className="rail rail-top">
        {/* The fleet's side of the rail, as on the lists: the way back, where
            you are, and the one control that adds to the list you came from. */}
        <div className="nav nav-focused">
          {/* One way back, in the place the tabs were, so the eye does not have to
              go looking for it. Escape does the same thing. */}
          <button className="nav-back" onClick={onBack} title="back to the fleet (esc)">
            <svg
              className="icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.9}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M20 12H5" />
              <path d="m11.5 5.5-6.5 6.5 6.5 6.5" />
            </svg>
            <span>fleet</span>
          </button>
          {/* Not a control: it says which task you are in, and the pane below is
              already all about it. */}
          <span className="nav-here">{focusedTask}</span>
          {newTask}
        </div>

        <div className="rail-controls">
          {themePicker}
          <button
            className={`icon-button rail-above${pinned ? ' on' : ''}`}
            title="keep on top of other windows"
            aria-pressed={pinned}
            onClick={onPin}
          >
            <Icon name="above" />
          </button>
          <button
            className={`icon-button${refreshing ? ' spinning' : ''}`}
            title={refreshing ? 're-reading…' : 'refresh the fleet and every pull request list (⌘R)'}
            aria-busy={refreshing}
            onClick={onRefresh}
          >
            <Icon name="refresh" />
          </button>
        </div>
      </header>
    );
  }

  return (
    <header className="rail rail-top">
      <nav
        className="nav"
        role="tablist"
        aria-label="lists"
        /* A tablist's own keys: the arrows move between tabs and open the one
           they land on, so the four are one stop in the tab order, not four. */
        onKeyDown={(event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
          const at = entries.findIndex((entry) => entry.id === tab);
          const next = entries[(at + (event.key === 'ArrowRight' ? 1 : -1) + entries.length) % entries.length];
          if (!next) return;
          event.preventDefault();
          event.stopPropagation();
          onTab(next.id);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus();
        }}
      >
        {entries.map((entry) => (
          <button
            key={entry.id}
            className={`nav-tab${tab === entry.id ? ' active' : ''}`}
            title={entry.title}
            role="tab"
            data-tab={entry.id}
            aria-selected={tab === entry.id}
            tabIndex={tab === entry.id ? 0 : -1}
            onClick={() => onTab(entry.id)}
          >
            <span className="nav-label">{entry.label}</span>
            {/* `zero` so a narrow window can drop it — see `.nav-total.zero`. */}
            <span className={`nav-total${entry.total === 0 ? ' zero' : ''}`}>{entry.total ?? '…'}</span>
            {entry.alert > 0 && (
              <span className={`nav-alert ${entry.tone}`}>
                <span className="dot" />
                {entry.alert}
                {/* The dot is the word here; a screen reader gets the word. */}
                <span className="sr-only">, {entry.title}</span>
              </span>
            )}
          </button>
        ))}
        {newTask}
      </nav>

      <div className="rail-controls">
        {themePicker}
        <button
          className={`icon-button rail-above${pinned ? ' on' : ''}`}
          title="keep on top of other windows"
          aria-pressed={pinned}
          onClick={onPin}
        >
          <Icon name="above" />
        </button>
        <button
          className={`icon-button${refreshing ? ' spinning' : ''}`}
          title={refreshing ? 're-reading…' : 'refresh the fleet and every pull request list (⌘R)'}
          aria-busy={refreshing}
          onClick={onRefresh}
        >
          <Icon name="refresh" />
        </button>
      </div>
    </header>
  );
}
