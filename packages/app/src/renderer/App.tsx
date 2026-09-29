import { useCallback, useEffect, useRef, useState } from 'react';
import type { FleetSession, Task } from '@fleetwood/core';
import type { Snapshot } from '../shared/ipc.ts';
import { SessionCard } from './SessionCard.tsx';
import { AgentRow } from './AgentRow.tsx';
import { PrList } from './PrList.tsx';
import { HistoryList } from './HistoryList.tsx';
import { TaskCard } from './TaskCard.tsx';
import { NewTask } from './NewTask.tsx';
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
import { isHidden, sessionLabel, sortSessions } from '@fleetwood/core/sessionOrder';
import { isWorkSession } from '@fleetwood/core/fleetList';
import { dormantTasks } from '@fleetwood/core/taskView';
import { resolveFocus } from './focus.ts';
import {
  answerFocusedPrompt,
  focusNextAttention,
  foldFocusedCard,
  isTyping,
  moveCardFocus,
  openFocusedMenu,
} from './listKeys.ts';
import { KeysSheet } from './KeysSheet.tsx';
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
  // Carried from ⌘K into the form; empty for every other way in.
  const [newTaskSummary, setNewTaskSummary] = useState('');
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if ((event.metaKey || event.ctrlKey) && event.key === 't') {
        event.preventDefault();
        setTab('fleet');
        // The card it creates is in the list, so that is where you should be.
        setFocusedSlug(undefined);
        setNewTaskSummary('');
        setNewTaskOpen((open) => !open);
      } else if ((event.metaKey || event.ctrlKey) && event.key === 'r') {
        event.preventDefault();
        refresh();
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
        const handled = ((): boolean => {
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
              return answerFocusedPrompt('approve');
            case 'd':
              return answerFocusedPrompt('deny');
            case 'm':
              return openFocusedMenu();
            case 'ArrowRight':
            case 'ArrowLeft':
              return foldFocusedCard(event.key === 'ArrowRight');
            case '?':
              setHelpOpen(true);
              return true;
            default:
              // The terminal numbers its options, and so does the card.
              return /^[1-9]$/.test(event.key) && answerFocusedPrompt({ key: event.key });
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
   * Numbered sessions sit where you put them; the rest are ranked by what they
   * are doing — attention first, then sessions with agents, then tmux's order.
   * Both halves of that rule live in `sortSessions`, so `fw status` draws the
   * same list.
   */
  const ranked = snapshot ? sortSessions(snapshot.fleet.sessions) : [];
  /*
   * Then down to the sessions the list is about — a task or a pull request, see
   * `fleetList.ts`. The shell in `~`, the one you spawned to try a command, every
   * project you have ever attached to: tmux has them and the fleet is not about
   * them, and they were pushing the rows that are down the page.
   *
   * Dropped outright rather than folded: the fold below is a decision you made
   * about a session that belongs here, and these never did. They still reach the
   * header, which is read off `fleet.counts` — every session, these included.
   */
  const offList = ranked.filter((session) => !isWorkSession(session.meta));
  const fleet = ranked.filter((session) => isWorkSession(session.meta));
  /*
   * Split off the sessions marked hidden — a dash on the front of the tmux name,
   * see `sessionOrder.ts`. Only the list is split: the fleet's counts and the
   * status bar still speak for every session, because an agent nobody is looking
   * at is still spending a token and still capable of getting stuck.
   */
  const sessions = fleet.filter((session) => !isHidden(session.name));
  const hidden = fleet.filter((session) => isHidden(session.name));
  const hiddenAttention = hidden.filter((session) => session.needsAttention).length;
  /** What a reorder click is relative to: the order actually on screen. */
  const order = sessions.map((session) => session.name);
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
      />
    ) : (
      <SessionCard
        key={session.sessionId}
        session={session}
        pr={session.meta.pr ? snapshot?.sessionPrs?.[session.meta.pr] : undefined}
        order={rowOrder}
        onResult={onResult}
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
        focusedTask={focused?.task.slug}
        onBack={() => setFocusedSlug(undefined)}
        onNewTask={() => {
          setNewTaskSummary('');
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
              Agent hooks aren't installed, so statuses are guessed from the screen rather than reported.
            </span>
            <button
              className="chip"
              onClick={() => void send({ kind: 'installHooks' }).then((r) => onResult(r.detail, r.ok))}
            >
              install
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
          />
        )}

        {snapshot && !focused && tab === 'fleet' && (
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
                    setNewTaskSummary('');
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
            {sessions.map((session) => sessionRow(session, order))}
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
            {dormant.length > 0 && (
              <>
                <div className="section-title" title="tasks with their worktrees ready and no session running them">
                  not running · {dormant.length}
                </div>
                {dormant.map((task) => dormantRow(task))}
              </>
            )}
            {/* Two different situations, so don't file them under one scary label:
                a daemon-hosted one is running fine — we just couldn't tell which
                terminal is showing it. */}
            {(['daemon-hosted', 'pane-gone'] as const).map((reason) => {
              const group = snapshot.fleet.orphans.filter(
                (a) => (a.orphanReason ?? 'pane-gone') === reason,
              );
              if (group.length === 0) return null;
              return (
                <div key={reason}>
                  <div className="section-title">
                    {/* Said in the panel's own voice. `pane gone — ended without a
                        closing event` was the internal state name and the reason
                        it was set, verbatim: true, and the only line in the list
                        written for whoever wrote the collector. */}
                    {/* Labels, like the two groups above; the sentence that says
                        what each one means moved to the hover. */}
                    <span
                      title={
                        reason === 'daemon-hosted'
                          ? 'running in the claude daemon — no terminal to attach to'
                          : 'left over — the terminal these ran in is gone'
                      }
                    >
                      {reason === 'daemon-hosted' ? 'in the daemon' : 'left over'} · {group.length}
                    </span>
                  </div>
                  {/* `orphans` so the list keys reach these rows — see `listKeys.ts`. */}
                  <div className="card orphans">
                    <div className="agents">
                      {group.map((agent) => (
                        <AgentRow key={agent.key} agent={agent} onResult={onResult} />
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
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
          <Power shutdown={snapshot.shutdown} onResult={onResult} />
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
      {snapshot && !focused && tab === 'fleet' && hidden.length + hiddenDormant.length > 0 && (
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
                <span className="hidden-attention" title={`${hiddenAttention} of them is blocked on a permission prompt`}>
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
      {counts && <StatusBar counts={counts} limits={snapshot?.limits} cursorUsage={snapshot?.cursorUsage} />}

      <NewTask
        open={newTaskOpen}
        initialSummary={newTaskSummary}
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
          setNewTaskSummary(summary);
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
