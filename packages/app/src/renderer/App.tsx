import { useCallback, useEffect, useState } from 'react';
import type { Snapshot } from '../shared/ipc.ts';
import { SessionCard } from './SessionCard.tsx';
import { AgentRow } from './AgentRow.tsx';
import { PrList } from './PrList.tsx';
import { TaskCard } from './TaskCard.tsx';
import { NewTask } from './NewTask.tsx';
import { Palette } from './Palette.tsx';
import { StatusBar } from './StatusBar.tsx';
import { TopBar } from './TopBar.tsx';
import type { Tab } from './TopBar.tsx';
import { ThemePicker } from './ThemePicker.tsx';
// The leaf module: the barrel re-exports tmux and process scanning, which fail
// the renderer bundle on `node:child_process`.
import { needsDeploy } from '@fleetwood/core/deployState';
import { applyTheme } from './theme.ts';
import { send } from './api.ts';
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

  useEffect(() => api.onSnapshot(setSnapshot), []);

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

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(undefined), 3_500);
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
        setNewTaskSummary('');
        setNewTaskOpen((open) => !open);
      } else if ((event.metaKey || event.ctrlKey) && event.key === 'r') {
        event.preventDefault();
        refresh();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refresh]);

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

  // Sessions needing attention float to the top; the rest keep tmux's order.
  const sessions = snapshot
    ? [...snapshot.fleet.sessions].sort((a, b) => {
        if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
        const aAgents = a.agents.length > 0;
        const bAgents = b.agents.length > 0;
        if (aAgents !== bAgents) return aAgents ? -1 : 1;
        return 0;
      })
    : [];

  /*
   * The join that merges the two lists: `@fw_task` is stamped on the session at
   * creation, so a session knows its task and a task knows its session name.
   * Keyed by name rather than id because that is what `Task.session` holds.
   *
   * No special sort is needed to put tasks near the top — they are the sessions
   * with agents in them, and the sort above already ranks by that.
   */
  const taskBySession = new Map(
    (snapshot?.tasks ?? []).filter((t) => t.session).map((t) => [t.session as string, t]),
  );
  /*
   * Tasks with no session at all.
   *
   * Listed last and under their own heading rather than mixed in: a session-keyed
   * list would otherwise drop them entirely, and "the task exists, nothing is
   * running it" is the state a folder of worktrees spends most of its life in.
   */
  const dormantTasks = (snapshot?.tasks ?? []).filter((t) => !t.session);

  return (
    <div className="app">
      <TopBar
        tab={tab}
        onTab={setTab}
        counts={counts}
        fleetCount={sessions.length + dormantTasks.length}
        prCount={prCount}
        toDeploy={toDeploy}
        pinned={pinned}
        onPin={() => {
          const next = !pinned;
          setPinned(next);
          void send({ kind: 'setAlwaysOnTop', value: next });
        }}
        onRefresh={refresh}
        refreshing={refreshing}
        themePicker={
          snapshot && (
            <ThemePicker
              current={snapshot.theme}
              bgOpacity={snapshot.bgOpacity}
              open={themeOpen}
              onToggle={() => setThemeOpen((open) => !open)}
              onClose={() => setThemeOpen(false)}
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

        {snapshot && tab === 'fleet' && (
          <>
            {sessions.length === 0 && dormantTasks.length === 0 && (
              <div className="empty">no tmux sessions</div>
            )}
            {sessions.map((session) => {
              const task = taskBySession.get(session.name);
              return task ? (
                <TaskCard
                  key={session.sessionId}
                  task={task}
                  session={session}
                  editor={snapshot.editor}
                  onResult={onResult}
                />
              ) : (
                <SessionCard key={session.sessionId} session={session} onResult={onResult} />
              );
            })}
            {dormantTasks.length > 0 && (
              <>
                <div className="section-title">
                  no session ({dormantTasks.length}) — worktrees ready, nothing running
                </div>
                {dormantTasks.map((task) => (
                  <TaskCard key={task.slug} task={task} editor={snapshot.editor} onResult={onResult} />
                ))}
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
                    {reason === 'daemon-hosted'
                      ? `no terminal matched (${group.length}) — running in the claude daemon`
                      : `pane gone (${group.length}) — ended without a closing event`}
                  </div>
                  <div className="card" style={{ marginTop: 6 }}>
                    <div className="agents">
                      {group.map((agent) => (
                        <AgentRow key={agent.key} agent={agent} onResult={onResult} />
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
            {/* Last, not first: the top of this list is for whatever needs you, and
                a dashed strip that never changes does not. ⌘T is the fast path. */}
            <button
              className="new-task"
              onClick={() => {
                setNewTaskSummary('');
                setNewTaskOpen(true);
              }}
              title="new task (⌘T)"
            >
              + new task
            </button>
          </>
        )}

        {snapshot && tab === 'prs' && (
          <PrList
            prs={snapshot.prs}
            merged={snapshot.merged}
            tasks={snapshot.tasks}
            prSessions={snapshot.prSessions}
            onResult={onResult}
          />
        )}
      </div>

      {/* Pinned below the scrolling body: everything down there is ambient
          context rather than something you act on — see `StatusBar`. */}
      {counts && <StatusBar counts={counts} limits={snapshot?.limits} />}

      <NewTask
        open={newTaskOpen}
        initialSummary={newTaskSummary}
        onClose={() => setNewTaskOpen(false)}
        onResult={onResult}
      />

      <Palette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        sessions={snapshot?.fleet.sessions.map((s) => s.name) ?? []}
        /* The palette can only carry the summary; the form asks for the rest.
           Forcing the fleet tab first so the card it creates is in view. */
        onNewTask={(summary) => {
          setTab('fleet');
          setNewTaskSummary(summary);
          setNewTaskOpen(true);
        }}
        onResult={onResult}
      />

      {toast && <div className={`toast${toast.ok ? '' : ' error'}`}>{toast.message}</div>}
    </div>
  );
}
