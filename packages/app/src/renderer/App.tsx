import { useCallback, useEffect, useRef, useState } from 'react';
import type { FleetSession, Task, Ticket } from '@fleetwood/core';
import type { Snapshot } from '../shared/ipc.ts';
import { SessionCard } from './SessionCard.tsx';
import { AgentRow } from './AgentRow.tsx';
import { PrList } from './PrList.tsx';
import { HistoryList } from './HistoryList.tsx';
import { TaskCard } from './TaskCard.tsx';
import { NewTask } from './NewTask.tsx';
import { EMPTY_DRAFT, draftFromTicket } from './newTaskFlow.ts';
import type { Draft } from './newTaskFlow.ts';
import { PlanRow, PlanView } from './Plan.tsx';
import { Power } from './Power.tsx';
import { Notes } from './Notes.tsx';
import { Drawer } from './Drawer.tsx';
import { Palette } from './Palette.tsx';
import { StatusBar } from './StatusBar.tsx';
import { TopBar } from './TopBar.tsx';
import type { Tab } from './TopBar.tsx';
import { ThemePicker } from './ThemePicker.tsx';
// The leaf module: the barrel re-exports tmux and process scanning, which fail
// the renderer bundle on `node:child_process`.
import { needsDeploy } from '@fleetwood/core/deployState';
import { isHidden, isPinned, sessionLabel, sortSessions } from '@fleetwood/core/sessionOrder';
import { isFleetSession } from '@fleetwood/core/fleetList';
import { dormantTasks } from '@fleetwood/core/taskView';
import { foldFleet, hasLiveAgent, linkTickets, readPlan, shownItems, ticketIdOf } from '@fleetwood/core/plan';
import { resolveFocus } from './focus.ts';
import {
  answerFocusedPrompt,
  focusNextAttention,
  enterFocusedCard,
  focusedSession,
  leaveFocusedRow,
  markArrived,
  refocusSession,
  isTyping,
  moveCardFocus,
  openFocusedMenu,
} from './listKeys.ts';
import { KeysSheet } from './KeysSheet.tsx';
import { arrangeIntent, inertMove } from './arrangeKeys.ts';
import { blockedAnnouncement } from './fleetSignals.ts';
import type { BlockedAgent } from './fleetSignals.ts';
import { applyTheme } from './theme.ts';
import { watchZoom } from './zoom.ts';
import { Slug } from './Slug.tsx';
import { send, shortenPath, tildify } from './api.ts';
import { api } from './api.ts';

interface Toast {
  message: string;
  ok: boolean;
}

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>();
  const [tab, setTab] = useState<Tab>('fleet');
  const [toast, setToast] = useState<Toast | undefined>();
  const [pinned, setPinned] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  // Carried from ⌘K, or from a plan ticket's `start`, into the form; empty otherwise.
  const [newTaskDraft, setNewTaskDraft] = useState<Draft>(EMPTY_DRAFT);
  const [themeOpen, setThemeOpen] = useState(false);
  /** The `?` sheet: every key and mark the fleet uses, in one place. */
  const [helpOpen, setHelpOpen] = useState(false);
  /*
   * Whether the hidden group is expanded. Window state on purpose, and the only
   * part of this feature that is: hiddenness itself is written on the tmux
   * session, so it outlives the window — but "I opened the drawer to look" is
   * not a decision to remember, and a drawer found open after a relaunch would
   * make the fleet look like hiding had come undone.
   */
  const [hiddenOpen, setHiddenOpen] = useState(false);
  /** `n` opened the hidden drawer to reach a blocked card inside it. */
  const pendingAttention = useRef(false);
  useEffect(() => {
    // After the drawer's cards exist, not before: they render with it.
    if (hiddenOpen && pendingAttention.current) {
      pendingAttention.current = false;
      focusNextAttention();
    }
  }, [hiddenOpen]);
  /**
   * The one task the panel is showing, if it is showing one.
   *
   * A slug, not a task: a snapshot lands every second and replaces every object
   * in it, so a held task would be the task as it was when you clicked. See
   * `focus.ts`, which turns it back into the pair the pane needs.
   */
  const [focusedSlug, setFocusedSlug] = useState<string | undefined>();
  /**
   * The plan whose drawer is open, by milestone id — held as an id for the
   * reason `focusedSlug` is: a snapshot replaces every object in it each second.
   */
  const [focusedPlan, setFocusedPlan] = useState<string | undefined>();
  /*
   * The plans whose tasks are unfolded in the list. Window state, like the
   * hidden drawer: a plan starts folded, and opening one to look is not a
   * decision to remember across a relaunch.
   */
  const [expandedPlans, setExpandedPlans] = useState<ReadonlySet<string>>(new Set());
  const [refreshingPlans, setRefreshingPlans] = useState(false);
  /*
   * Whether the notes drawer is up. Window state, like the hidden group: the
   * note itself is on disk and outlives the window; "I had it open" does not.
   */
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => api.onSnapshot(setSnapshot), []);
  // Before the first paint of anything in the rails: the top one's inset into the
  // traffic lights is computed from this.
  useEffect(() => watchZoom(), []);

  /*
   * The fleet polls itself every second; these three are the ones that do not.
   * `force` on the merged list drops the cache, so a manual refresh re-asks even
   * rows whose state we assumed nothing could change.
   */
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback((): void => {
    // Clicking again while the three are still out would resolve the spinner on
    // the second round trip and leave the first still running.
    if (refreshing) return;
    setRefreshing(true);
    void Promise.all([
      send({ kind: 'refresh' }),
      send({ kind: 'refreshPrs' }),
      send({ kind: 'refreshMerged', force: true }),
    ]).finally(() => setRefreshing(false));
  }, [refreshing]);

  /*
   * Repaint whenever the configured theme or its opacity changes — including the
   * very first snapshot, which is what actually applies the config on a cold
   * start. Keyed on the two values, so the 1s snapshot poll is not writing eleven
   * custom properties a second.
   */
  useEffect(() => {
    if (snapshot) applyTheme(snapshot.theme, snapshot.bgOpacity);
  }, [snapshot?.theme, snapshot?.bgOpacity]);

  /*
   * A failure stays up long enough to be read.
   *
   * Every result used to leave after 3.5s, the failures too — and a failure is
   * the one message you were not expecting, so it is the one most likely to be
   * gone before your eyes got to the bottom of the panel. It stays until the
   * next message or a click; a success still gets out of the way.
   */
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(undefined), toast.ok ? 3_500 : 10_000);
    return () => clearTimeout(timer);
  }, [toast]);

  /*
   * The two lists a card can be moved within, as they were last drawn.
   *
   * A ref because the key handler below is bound once per overlay change, and a
   * move has to be planned against the order on screen now, not the one from
   * when the handler was made. Written further down, where the lists are cut.
   */
  const arrangeLists = useRef<{ shown: string[]; hidden: string[] }>({ shown: [], hidden: [] });
  /** A move is out: the card's name is about to change, so the next key waits. */
  const arranging = useRef(false);
  /*
   * The card a key just moved, and until when to keep focus on it.
   *
   * Moving renames the session and reorders the list under it, and the first
   * redraw after is not always the one with the new order — so focus is put
   * back on it for the redraws that land in the next moment, not just once.
   * Any other key or a click lets go: after that, where focus is is yours.
   */
  const following = useRef<{ id: string; until: number } | undefined>(undefined);
  useEffect(() => {
    const pending = following.current;
    if (!pending) return;
    if (Date.now() > pending.until) following.current = undefined;
    else refocusSession(pending.id);
  }, [snapshot]);
  useEffect(() => {
    const letGo = (): void => {
      following.current = undefined;
    };
    window.addEventListener('pointerdown', letGo);
    return () => window.removeEventListener('pointerdown', letGo);
  }, []);

  useEffect(() => {
    /*
     * `J` `K` `t` `b` `p` on the focused card: move it, or pin it — see
     * `arrangeKeys.ts`. Always handled once it is one of those keys, so a key
     * that cannot act says why rather than falling through to nothing.
     */
    const arrange = (key: string): boolean => {
      const intent = arrangeIntent(key);
      if (!intent) return false;
      const target = focusedSession();
      if (!target) {
        // On a card with no session — a dormant task, a workspace — say so; off
        // the cards altogether the key is simply not for here.
        if (!document.activeElement?.closest('.card')) return false;
        setToast({ message: 'only a card with a session keeps a place — open it first', ok: true });
        return true;
      }
      // Planned against the name on screen, which a move in flight is changing.
      if (arranging.current) return true;
      const list = isHidden(target.name) ? arrangeLists.current.hidden : arrangeLists.current.shown;
      let request: Parameters<typeof send>[0];
      if (intent.kind === 'move') {
        const why = inertMove(list, target.name, intent.direction);
        if (why) {
          setToast({ message: why, ok: true });
          return true;
        }
        request = { kind: 'reorderSession', session: target.name, direction: intent.direction, order: list };
      } else {
        request = { kind: 'setSessionPinned', session: target.name, pinned: !isPinned(target.name) };
      }
      arranging.current = true;
      following.current = { id: target.id, until: Date.now() + 2_000 };
      void send(request)
        // A rejected call must not leave `arranging` set, or no key moves again.
        .catch(() => ({ ok: false, detail: 'the move never reached fleetwood — try again' }))
        .then((result) => {
        // The snapshot with the new names is sent before this reply and drawn
        // in the task after it, so the next key plans against the new list.
        setTimeout(() => {
          arranging.current = false;
          if (following.current?.id === target.id) refocusSession(target.id);
          if (result.ok) markArrived(target.id);
        }, 0);
        // A pin sends the card a long way, so it is worth a line; a move is
        // there to see. Both are said to a screen reader, which cannot see it.
        if (!result.ok || intent.kind === 'pin') setToast({ message: result.detail, ok: result.ok });
        setAnnouncement(result.detail);
      });
      return true;
    };

    /*
     * An answer key with no prompt under focus does nothing — say why, when a
     * prompt is waiting somewhere else. Otherwise stay quiet: a stray `a`
     * with nothing blocked is not worth a message.
     */
    const hintNoPrompt = (): boolean => {
      if (!document.querySelector('.prompt')) return false;
      setToast({ message: 'answer keys act on the focused card — press n to go to the one asking', ok: true });
      return true;
    };
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if ((event.metaKey || event.ctrlKey) && event.key === 't') {
        event.preventDefault();
        setTab('fleet');
        // The card it creates is in the list, so that is where you should be.
        setFocusedSlug(undefined);
        setFocusedPlan(undefined);
        setNewTaskDraft(EMPTY_DRAFT);
        setNewTaskOpen((open) => !open);
      } else if ((event.metaKey || event.ctrlKey) && event.key === 'r') {
        event.preventDefault();
        refresh();
      } else if ((event.metaKey || event.ctrlKey) && ['1', '2', '3', '4'].includes(event.key)) {
        // The tabs, in rail order — the one way between them that did not mean
        // tabbing up into the rail first.
        event.preventDefault();
        const tabs: Tab[] = ['fleet', 'prs', 'history', 'power'];
        setFocusedSlug(undefined);
        setFocusedPlan(undefined);
        setTab(tabs[Number(event.key) - 1] as Tab);
      } else if ((event.metaKey || event.ctrlKey) && event.key === 'n') {
        event.preventDefault();
        setNotesOpen((open) => !open);
      } else if (
        /*
         * The list's own keys — see `listKeys.ts`. Bare keys, so only when
         * nothing else could want them: not while typing, not with an overlay
         * up, and not with a modifier, which is the rail's shortcuts.
         */
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTyping(event.target) &&
        !paletteOpen &&
        !newTaskOpen &&
        !themeOpen &&
        !helpOpen
      ) {
        // Any key but the next move lets go of the card that just moved.
        if (!arrangeIntent(event.key)) following.current = undefined;
        const handled = ((): boolean => {
          if (arrange(event.key)) return true;
          switch (event.key) {
            case 'j':
            case 'k':
              moveCardFocus(event.key === 'j' ? 1 : -1);
              return true;
            case 'n':
              /*
               * Down the list first; then, past the last blocked card on
               * screen, the hidden drawer if its door says one of its cards is
               * blocked — open it and take the key there once its cards are
               * drawn; then round to the top. And when nothing at all needs
               * you, say so: a key that does nothing reads as a broken key.
               */
              if (focusNextAttention(false)) return true;
              // Only while the drawer is shut: open, its cards are already in
              // the walk above, and the door's count must not trap `n` there.
              if (document.querySelector('.hidden-attention') && !document.querySelector('.hidden-group')) {
                pendingAttention.current = true;
                setHiddenOpen(true);
                return true;
              }
              if (!focusNextAttention(true)) setToast({ message: 'nothing needs you', ok: true });
              return true;
            case 'a':
              return answerFocusedPrompt('approve') || hintNoPrompt();
            case 'd':
              return answerFocusedPrompt('deny') || hintNoPrompt();
            case 'm':
              return openFocusedMenu();
            case 'l':
            case 'ArrowRight':
              return enterFocusedCard();
            case 'h':
            case 'ArrowLeft':
              return leaveFocusedRow();
            case '?':
              setHelpOpen(true);
              return true;
            default:
              // The terminal numbers its options, and so does the card.
              return /^[1-9]$/.test(event.key) && (answerFocusedPrompt({ key: event.key }) || hintNoPrompt());
          }
        })();
        if (handled) event.preventDefault();
      }
      if (event.defaultPrevented) return;
      if (event.key === 'Escape' && helpOpen) {
        setHelpOpen(false);
      } else if (event.key === 'Escape' && !paletteOpen && !newTaskOpen && !themeOpen) {
        /*
         * The way out of the pane.
         *
         * Guarded on what else is open rather than trusting each of them to stop
         * the event: escape means the innermost thing showing, and closing a
         * palette that happened to be over the pane must not also close the pane
         * behind it. The inline editors — notes, add-repo — do stop it, because
         * this handler cannot see them.
         */
        setFocusedSlug(undefined);
        setFocusedPlan(undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refresh, paletteOpen, newTaskOpen, themeOpen, helpOpen]);

  const onResult = (message: string, ok: boolean): void => setToast({ message, ok });

  const counts = snapshot?.fleet.counts;
  const merged = snapshot?.merged?.prs ?? [];
  const prCount = snapshot?.prs
    ? snapshot.prs.reviewRequested.length + snapshot.prs.mine.length + merged.length
    : undefined;
  /**
   * Merges whose image is built and which nothing deployed.
   *
   * This is the number the feature exists for: it is what you would otherwise
   * announce as shipped without shipping it. Hoisted to the top rail so it does
   * not depend on having the pull requests tab open.
   */
  const toDeploy = merged.filter((pr) => needsDeploy(pr)).length;

  /*
   * What the power tab says in the rail, and when it says it loudly.
   *
   * The label is the schedule itself rather than a count, and the alert is the
   * minutes left once the warning is up — see `TopBar`. Rounded up, so the last
   * minute reads `1` rather than `0` while the machine is still on.
   */
  const shutdown = snapshot?.shutdown;
  const shutdownLabel = shutdown?.enabled ? shutdown.time : 'off';
  /*
   * The warning opens the notes.
   *
   * Fifteen minutes before the machine goes down is what the drawer is for, and
   * the overlay that says so is on another window: when you put it away and
   * come to the panel, the place to write where you are is already open. Keyed
   * on the phase, so it opens once per warning and not on every poll during it
   * — closing it again is allowed to stick.
   */
  const shutdownPhase = shutdown?.phase;
  useEffect(() => {
    if (shutdownPhase === 'warning') setNotesOpen(true);
  }, [shutdownPhase]);
  const shutdownAlert =
    shutdown?.phase === 'warning' && shutdown.at !== undefined
      ? Math.max(1, Math.ceil((shutdown.at - Date.now()) / 60_000))
      : 0;

  /*
   * Numbered sessions sit where you put them; the rest go sessions with agents
   * first, then tmux's order. Never by attention — a blocked card gets louder
   * where it is, and the list holds still under your hand.
   * Both halves of that rule live in `sortSessions`, so `fw status` draws the
   * same list.
   */
  const ranked = snapshot ? sortSessions(snapshot.fleet.sessions) : [];
  /*
   * Then down to the sessions the list is about — a task, a pull request, or one
   * with an agent running in it, see `fleetList.ts`. The shell in `~`, the one you spawned to try a command, every
   * project you have ever attached to: tmux has them and the fleet is not about
   * them, and they were pushing the rows that are down the page.
   *
   * Dropped outright rather than folded: the fold below is a decision you made
   * about a session that belongs here, and these never did. They still reach the
   * header, which is read off `fleet.counts` — every session, these included.
   */
  const offList = ranked.filter((session) => !isFleetSession(session));
  const fleet = ranked.filter((session) => isFleetSession(session));
  /*
   * Split off the sessions marked hidden — a dash on the front of the tmux name,
   * see `sessionOrder.ts`. Only the list is split: the fleet's counts and the
   * status bar still speak for every session, because an agent nobody is looking
   * at is still spending a token and still capable of getting stuck.
   */
  const sessions = fleet.filter((session) => !isHidden(session.name));
  const hidden = fleet.filter((session) => isHidden(session.name));
  const hiddenAttention = hidden.filter((session) => session.needsAttention).length;
  /*
   * The hidden group is its own list to move within, so a card in the drawer can
   * still be ordered — `planReorder` renumbers what it is given, and the marker
   * survives a renumber, so nothing here can push a card back on screen.
   */
  const hiddenOrder = hidden.map((session) => session.name);

  /*
   * The focused task, re-found in the snapshot that just landed.
   *
   * `undefined` covers the task being archived while you are looking at it —
   * from the pane's own button, or from `fw` in the terminal beside the panel —
   * and the fleet is simply what is drawn instead. No banner: the list coming
   * back is the message.
   */
  const focused = resolveFocus(snapshot?.tasks, sessions, focusedSlug);

  /*
   * The join that merges the two lists: `@fw_task` is stamped on the session at
   * creation, so a session knows its task and a task knows its session name.
   * Keyed by name rather than id because that is what `Task.session` holds.
   *
   * No special sort is needed to put tasks near the top — they are the sessions
   * with agents in them, and the sort above already ranks by that.
   */
  /*
   * Every agent stopped on a permission prompt, hidden and cardless ones too —
   * an agent nobody is looking at can still be the one holding everything up.
   * Joined into a key so the announcement below runs on a change in *who* is
   * blocked, not on every one-second snapshot.
   */
  const blockedAgents: BlockedAgent[] = [
    ...(snapshot?.fleet.sessions ?? []).flatMap((session) =>
      session.agents
        .filter((agent) => agent.status === 'blocked_permission')
        .map((agent) => ({ key: agent.key, card: sessionLabel(session.name), activity: agent.activity })),
    ),
    ...(snapshot?.fleet.orphans ?? [])
      .filter((agent) => agent.status === 'blocked_permission')
      .map((agent) => ({ key: agent.key, card: agent.tool, activity: agent.activity })),
  ];
  const blockedKeys = blockedAgents.map((agent) => agent.key).join(' ');
  const announced = useRef<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const said = blockedAnnouncement(announced.current, blockedAgents);
    announced.current = new Set(blockedAgents.map((agent) => agent.key));
    if (said) setAnnouncement(said);
    // Keyed on who is blocked, on purpose: `blockedAgents` is a new array every
    // snapshot, and re-running on that would diff the same set every second.
  }, [blockedKeys]);

  const taskBySession = new Map(
    (snapshot?.tasks ?? []).filter((t) => t.session).map((t) => [t.session as string, t]),
  );
  /*
   * Tasks with no session at all.
   *
   * Listed last and under their own heading rather than mixed in: a session-keyed
   * list would otherwise drop them entirely, and "the task exists, nothing is
   * running it" is the state a folder of worktrees spends most of its life in.
   *
   * In the slot and the fold their last session had, so the morning after a
   * reboot — when this is every task — reads like the evening before it. The
   * hidden ones go behind the same drawer as the hidden sessions.
   */
  const { shown: dormant, hidden: hiddenDormant } = dormantTasks(snapshot?.tasks ?? []);
  /*
   * Workspaces nobody has opened yet — see `fleetList.ts`. Above the dormant
   * tasks rather than among them: a task card is worktrees waiting on a branch,
   * and this is a folder waiting on nothing but a session.
   */
  const idleWorkspaces = snapshot?.dormantWorkspaces ?? [];

  /*
   * Plans: each Notion milestone a task here is linked to, read against this
   * same snapshot's tasks, pull requests and agents — see `core/plan.ts`. Read
   * here rather than in main so a plan never says a ticket is waiting on an
   * agent the card under it shows as already answered.
   */
  const plans = snapshot?.plans?.plans ?? [];
  const links = linkTickets(
    snapshot?.tasks ?? [],
    snapshot?.taskPrs?.byTask,
    Object.fromEntries((snapshot?.fleet.sessions ?? []).map((session) => [session.name, session.agents])),
  );
  const planRows = new Map(plans.map((plan) => [plan.milestoneId, readPlan(plan, links)]));
  const openPlan = plans.find((plan) => plan.milestoneId === focusedPlan);
  /*
   * The list, with each plan's tasks folded under its row. Sessions and dormant
   * tasks are folded as one list, so a plan whose tasks are all parked still
   * gets its row — after the running work, which is where its first task stood.
   * The hidden drawer is left alone: hiding a session is a decision about that
   * session, and a plan row must not undo it.
   */
  type ListItem = { kind: 'session'; session: FleetSession } | { kind: 'dormant'; task: Task };
  const taskOf = (item: ListItem): Task | undefined =>
    item.kind === 'dormant' ? item.task : taskBySession.get(item.session.name);
  const listRows = foldFleet<ListItem>(
    [
      ...sessions.map((session): ListItem => ({ kind: 'session', session })),
      ...dormant.map((task): ListItem => ({ kind: 'dormant', task })),
    ],
    plans,
    (item) => {
      const task = taskOf(item);
      return task ? (ticketIdOf(task.slug) ?? ticketIdOf(task.branch)) : undefined;
    },
    (item) => item.kind === 'session' && hasLiveAgent(item.session.agents),
    expandedPlans,
  );
  /**
   * What a reorder click is relative to: the order actually on screen — which,
   * with plans folded, leaves out every session tucked under a collapsed plan.
   */
  const order = shownItems(listRows).flatMap((item) => (item.kind === 'session' ? [item.session.name] : []));
  arrangeLists.current = { shown: order, hidden: hiddenOrder };
  const unplannedDormant = listRows.flatMap((row) =>
    row.kind === 'item' && row.item.kind === 'dormant' ? [row.item.task] : [],
  );
  const listItem = (item: ListItem): React.JSX.Element =>
    item.kind === 'session' ? sessionRow(item.session, order) : dormantRow(item.task);
  const onStartTicket = (ticket: Ticket): void => {
    setNewTaskDraft(draftFromTicket(ticket));
    setNewTaskOpen(true);
  };
  const refreshPlans = (): void => {
    setRefreshingPlans(true);
    void send({ kind: 'refreshPlans' })
      .then((result) => onResult(result.detail, result.ok))
      .finally(() => setRefreshingPlans(false));
  };

  /**
   * One row of the fleet: a task card when we know what task the session is
   * working, a plain session card otherwise.
   *
   * A function rather than inline JSX because the hidden group draws exactly the
   * same rows — a hidden card is not a lesser card, it is the same one behind a
   * divider, with every control it always had. `rowOrder` is the list the card's
   * reorder menu moves within, which is its own group and not the whole fleet.
   */
  function sessionRow(session: FleetSession, rowOrder: string[]): React.JSX.Element {
    const task = taskBySession.get(session.name);
    const here = session.name === snapshot?.currentSession;
    return task ? (
      <TaskCard
        key={session.sessionId}
        task={task}
        prs={snapshot?.taskPrs?.byTask[task.slug]}
        prsStale={snapshot?.taskPrs?.degraded}
        session={session}
        order={rowOrder}
        editor={snapshot?.editor ?? ''}
        onResult={onResult}
        onFocus={() => setFocusedSlug(task.slug)}
        here={here}
      />
    ) : (
      <SessionCard
        key={session.sessionId}
        session={session}
        pr={session.meta.pr ? snapshot?.sessionPrs?.[session.meta.pr] : undefined}
        order={rowOrder}
        onResult={onResult}
        here={here}
      />
    );
  }

  /**
   * A workspace with no session: the header opens one, as on a dormant task.
   *
   * Nothing else to draw — no agents, no repos, no menu. Once the session exists
   * it is an ordinary session card, marked `workspace`, with every control those
   * have.
   */
  function workspaceRow(path: string): React.JSX.Element {
    const name = path.split('/').filter(Boolean).pop() ?? path;
    return (
      <div key={path} className="card dormant">
        <div
          className="card-head"
          onClick={() => void send({ kind: 'openProject', path }).then((r) => onResult(r.detail, r.ok))}
          title={`no session yet — open one on ${tildify(path)}`}
        >
          <span className="attached-dot sev-quiet detached" title="no session yet" />
          {/* The keyboard's way in — see the same button on `TaskCard`. */}
          <button type="button" className="session-name card-title">
            <Slug text={name} />
          </button>
          <span className="head-path">{shortenPath(path, 22)}</span>
        </div>
      </div>
    );
  }

  /**
   * Agents with no card: the ones in the claude daemon, and the ones whose
   * terminal is gone.
   *
   * Two different situations, so not filed under one scary label: a
   * daemon-hosted one is running fine — we just cannot tell which terminal is
   * showing it. Said in the panel's own voice; `pane gone — ended without a
   * closing event` was the collector's state name, verbatim.
   */
  function orphanGroup(reason: 'daemon-hosted' | 'pane-gone'): React.JSX.Element | null {
    const group = (snapshot?.fleet.orphans ?? []).filter((a) => (a.orphanReason ?? 'pane-gone') === reason);
    if (group.length === 0) return null;
    return (
      <div key={reason}>
        <div
          className="section-title"
          title={
            reason === 'daemon-hosted'
              ? 'running in the claude daemon — no terminal to attach to'
              : 'left over — the terminal these ran in is gone'
          }
        >
          {reason === 'daemon-hosted' ? 'running, no terminal' : 'left over'} · {group.length}
        </div>
        {/* `orphans` so the list keys reach these rows — see `listKeys.ts`. */}
        <div className="card orphans">
          <div className="agents">
            {group.map((agent) => (
              /* With no card above it, the row is the only place to say which
                 work this agent is on: the folder it runs in. */
              <AgentRow key={agent.key} agent={agent} where={agent.cwd ? folderName(agent.cwd) : undefined} onResult={onResult} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  /** A task with no session: its card, with the one button that starts one. */
  function dormantRow(task: Task): React.JSX.Element {
    return (
      <TaskCard
        key={task.slug}
        task={task}
        prs={snapshot?.taskPrs?.byTask[task.slug]}
        prsStale={snapshot?.taskPrs?.degraded}
        editor={snapshot?.editor ?? ''}
        onResult={onResult}
        onFocus={() => setFocusedSlug(task.slug)}
        compact
      />
    );
  }

  return (
    <div className="app">
      <TopBar
        tab={tab}
        onTab={(next) => {
          // Leaving the pane is implied by asking for a list.
          setFocusedSlug(undefined);
          setFocusedPlan(undefined);
          setTab(next);
        }}
        counts={counts}
        fleetCount={sessions.length}
        parkedCount={idleWorkspaces.length + dormant.length}
        prCount={prCount}
        historyCount={snapshot?.history.length ?? 0}
        shutdownLabel={shutdownLabel}
        shutdownAlert={shutdownAlert}
        toDeploy={toDeploy}
        pinned={pinned}
        onPin={() => {
          const next = !pinned;
          setPinned(next);
          void send({ kind: 'setAlwaysOnTop', value: next });
        }}
        onRefresh={refresh}
        refreshing={refreshing}
        focusedTask={focused?.task.slug ?? openPlan?.name}
        onBack={() => {
          setFocusedSlug(undefined);
          setFocusedPlan(undefined);
        }}
        onNewTask={() => {
          setNewTaskDraft(EMPTY_DRAFT);
          setNewTaskOpen(true);
        }}
        themePicker={
          snapshot && (
            <ThemePicker
              current={snapshot.theme}
              bgOpacity={snapshot.bgOpacity}
              open={themeOpen}
              onToggle={() => setThemeOpen((open) => !open)}
              onClose={() => setThemeOpen(false)}
              onResult={onResult}
            />
          )
        }
      />

      <div className="body">
        {snapshot && !snapshot.hooksInstalled && (
          <div className="banner">
            <span>
              agent hooks aren’t installed — statuses are guessed from the screen, not reported
            </span>
            <button
              className="chip"
              onClick={() => void send({ kind: 'installHooks' }).then((r) => onResult(r.detail, r.ok))}
            >
              install hooks
            </button>
          </div>
        )}

        {!snapshot && <div className="empty">connecting to tmux…</div>}

        {/* One task, and nothing else. Ahead of both lists rather than as a third
            tab: it is one of them, opened — and it is literally the same card,
            because a second rendering of a task was a second thing to keep true
            and the one that was always a step behind. No `onFocus`: you are
            already here, so the card draws no button back to where you are. */}
        {snapshot && focused && (
          <TaskCard
            task={focused.task}
            prs={snapshot.taskPrs?.byTask[focused.task.slug]}
            prsStale={snapshot.taskPrs?.degraded}
            session={focused.session}
            editor={snapshot.editor}
            onResult={onResult}
            onArchive={() => setFocusedSlug(undefined)}
            here={focused.session !== undefined && focused.session.name === snapshot.currentSession}
          />
        )}

        {/* A plan opened, alone in the body like an opened task. A task opened
            from it takes over, and back goes to the fleet, as from any task. */}
        {snapshot?.plans && !focused && openPlan && (
          <PlanView
            plan={openPlan}
            rows={planRows.get(openPlan.milestoneId) ?? []}
            fetchedAt={snapshot.plans.fetchedAt}
            stale={snapshot.plans.stale}
            refreshing={refreshingPlans}
            onRefresh={refreshPlans}
            onStart={onStartTicket}
            onOpenTask={(slug) => {
              setFocusedPlan(undefined);
              setFocusedSlug(slug);
            }}
            onResult={onResult}
          />
        )}

        {snapshot && !focused && !openPlan && tab === 'fleet' && (
          <>
            {sessions.length === 0 && idleWorkspaces.length === 0 && dormant.length === 0 && (
              // "No tmux sessions" over a drawer saying there are three would read
              // as fleetwood having lost them. And with nothing on screen to
              // point at, the one thing you can do comes to the middle of the
              // panel rather than staying a 24px glyph up in the rail.
              <div className="empty">
                <span>
                  {hidden.length + hiddenDormant.length > 0
                    ? 'every session is hidden'
                    : offList.length > 0
                      ? // Said rather than left out: with tmux plainly busy, an
                        // empty panel over "no tmux sessions" would read as
                        // fleetwood having lost the lot.
                        `no tasks running — ${offList.length} other tmux session${offList.length === 1 ? '' : 's'}, not the fleet's`
                      : 'no tmux sessions'}
                </span>
                <button
                  className="button"
                  onClick={() => {
                    setNewTaskDraft(EMPTY_DRAFT);
                    setNewTaskOpen(true);
                  }}
                >
                  new task <span className="key">⌘T</span>
                </button>
                <span className="empty-hint">
                  press <kbd className="key-cap">?</kbd> for every key and mark
                </span>
              </div>
            )}
            {listRows.map((row) =>
              // A dormant task outside every plan is drawn under `not running`, below.
              row.kind === 'item' ? (
                row.item.kind === 'session' && listItem(row.item)
              ) : (
                <PlanRow
                  key={row.plan.milestoneId}
                  plan={row.plan}
                  rows={planRows.get(row.plan.milestoneId) ?? []}
                  expanded={expandedPlans.has(row.plan.milestoneId)}
                  folded={row.items.length - row.shown.length}
                  onToggle={() =>
                    setExpandedPlans((was) => {
                      const next = new Set(was);
                      if (!next.delete(row.plan.milestoneId)) next.add(row.plan.milestoneId);
                      return next;
                    })
                  }
                  onOpen={() => setFocusedPlan(row.plan.milestoneId)}
                >
                  {row.shown.length > 0 ? row.shown.map(listItem) : undefined}
                </PlanRow>
              ),
            )}
            {/* Running agents with no terminal belong with the running work, not
                under the parked tasks; the ones whose terminal is gone go last. */}
            {orphanGroup('daemon-hosted')}
            {idleWorkspaces.length > 0 && (
              <>
                {/* A label, not a sentence: it names the group under it, and the
                    long form was the heaviest line on screen for the least
                    urgent group in the list. The rest is on hover. */}
                <div className="section-title" title="folders fleetwood knows, with no tmux session open on them">
                  workspaces · {idleWorkspaces.length}
                </div>
                {idleWorkspaces.map((path) => workspaceRow(path))}
              </>
            )}
            {unplannedDormant.length > 0 && (
              <>
                <div className="section-title" title="tasks with their worktrees ready and no session running them">
                  not running · {unplannedDormant.length}
                </div>
                {unplannedDormant.map((task) => dormantRow(task))}
              </>
            )}
            {orphanGroup('pane-gone')}
          </>
        )}

        {snapshot && !focused && tab === 'prs' && (
          <PrList
            prs={snapshot.prs}
            merged={snapshot.merged}
            tasks={snapshot.tasks}
            prSessions={snapshot.prSessions}
            onResult={onResult}
          />
        )}

        {snapshot && !focused && tab === 'history' && (
          <HistoryList history={snapshot.history} onResult={onResult} />
        )}

        {snapshot && !focused && tab === 'power' && (
          <Power shutdown={snapshot.shutdown} counts={snapshot.fleet.counts} onResult={onResult} />
        )}
      </div>

      {/* The foot of the panel: two drawers between the list and the rail, drawn
          by one component so they are one kind of thing — see `Drawer`. */}

      {/* The sessions you asked to have out of the way. A drawer under the list
          rather than a row at the end of it, which is where it used to be: out
          of the way is the same place whether the list above is three cards or
          thirty. The count of what needs you rides on the door rather than
          lifting the card back into the list — hiding a session that is
          blocked is a thing you are allowed to do, and being told about it is
          not the same as having it put back. */}
      {snapshot && !focused && !openPlan && tab === 'fleet' && hidden.length + hiddenDormant.length > 0 && (
        <Drawer
          open={hiddenOpen}
          onToggle={() => setHiddenOpen((open) => !open)}
          label="hidden"
          title={
            hiddenOpen
              ? 'fold the hidden sessions away'
              : 'sessions marked hidden — a dash on the front of the tmux name. Unhide one from its own ⋮ menu.'
          }
          summary={
            <>
              <span className="hidden-count">{hidden.length + hiddenDormant.length}</span>
              {/* The rail's own alert, not a sentence: a dot and a number is
                  how this panel says "some of these want you" everywhere
                  else, and the drawer is the one place it had been spelling
                  it out in words instead. */}
              {hiddenAttention > 0 && (
                <span className="hidden-attention" title={`${hiddenAttention} of them ${hiddenAttention === 1 ? 'is' : 'are'} waiting on a permission prompt`}>
                  <span className="dot" />
                  {hiddenAttention}
                </span>
              )}
            </>
          }
        >
          <div className="drawer-body hidden-group">
            {hidden.map((session) => sessionRow(session, hiddenOrder))}
            {hiddenDormant.map((task) => dormantRow(task))}
          </div>
        </Drawer>
      )}

      {/* On every tab: the one thing here you write rather than read, kept
          under whatever you are looking at while you write it — see `Notes`. */}
      {snapshot && (
        <Notes
          notes={snapshot.notes}
          editor={snapshot.editor}
          open={notesOpen}
          onToggle={() => setNotesOpen((open) => !open)}
          onResult={onResult}
        />
      )}

      {/* Pinned below the scrolling body: everything down there is ambient
          context rather than something you act on — see `StatusBar`. */}
      {counts && (
        <StatusBar
          counts={counts}
          limits={snapshot?.limits}
          cursorUsage={snapshot?.cursorUsage}
          onHelp={() => setHelpOpen(true)}
        />
      )}

      <NewTask
        open={newTaskOpen}
        initialDraft={newTaskDraft}
        onClose={() => setNewTaskOpen(false)}
        onResult={onResult}
      />

      <Palette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        /* Every session tmux has, not the list above: the palette is the way
           back to one the fleet leaves out, so it is the one place that must
           not be filtered. */
        sessions={snapshot?.fleet.sessions.map((s) => s.name) ?? []}
        /* The palette can only carry the summary; the form asks for the rest.
           Forcing the fleet tab first so the card it creates is in view. */
        onNewTask={(summary) => {
          setTab('fleet');
          setFocusedSlug(undefined);
          setFocusedPlan(undefined);
          setNewTaskDraft({ ...EMPTY_DRAFT, summary });
          setNewTaskOpen(true);
        }}
        onResult={onResult}
      />

      {/*
       * Two regions, mounted always and filled when there is something to say.
       *
       * A live region only announces a change to a region that already exists,
       * so one that appears with its message is one a screen reader never
       * reads — and one whose politeness flips in the same render as its text is
       * one it may not read either. So a region per politeness, each fixed: a
       * failure interrupts, a success waits its turn.
       */}
      {/*
       * The fleet's own news, for a screen reader: an agent that just stopped
       * on you. The rail's red count says it to the eye; nothing said it aloud,
       * so a blocked agent went unheard until someone happened past its card.
       */}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>

      <div className="toast-region">
        <div role="status" aria-live="polite">
          {toast?.ok && <ToastLine toast={toast} onDismiss={() => setToast(undefined)} />}
        </div>
        <div role="alert" aria-live="assertive">
          {toast && !toast.ok && <ToastLine toast={toast} onDismiss={() => setToast(undefined)} />}
        </div>
      </div>

      <KeysSheet open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

/**
 * One result, said at the foot of the panel.
 *
 * Text, with its own small close control, rather than a button that is all
 * message: inside a live region a button is announced as a button, and the
 * words are what has to be heard.
 */
function ToastLine({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }): React.JSX.Element {
  return (
    <div className={`toast${toast.ok ? '' : ' error'}`}>
      <span className="toast-text">{toast.message}</span>
      <button type="button" className="toast-close" onClick={onDismiss}>
        ×<span className="sr-only">dismiss</span>
      </button>
    </div>
  );
}

/** The last segment of a path, for naming a folder in a row. */
function folderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}
