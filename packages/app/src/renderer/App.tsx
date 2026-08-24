import { useEffect, useState } from 'react';
import type { Snapshot } from '../shared/ipc.ts';
import { SessionCard } from './SessionCard.tsx';
import { AgentRow } from './AgentRow.tsx';
import { PrList } from './PrList.tsx';
import { TaskList } from './TaskList.tsx';
import { NewTask } from './NewTask.tsx';
import { Palette } from './Palette.tsx';
import { LimitBars } from './LimitBars.tsx';
// The leaf module: the barrel re-exports tmux and process scanning, which fail
// the renderer bundle on `node:child_process`.
import { needsDeploy } from '@fleetwood/core/deployState';
import { money, send } from './api.ts';
import { api } from './api.ts';

type Tab = 'fleet' | 'tasks' | 'prs';

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

  useEffect(() => api.onSnapshot(setSnapshot), []);

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
        setTab('tasks');
        setNewTaskOpen((open) => !open);
      } else if ((event.metaKey || event.ctrlKey) && event.key === 'r') {
        event.preventDefault();
        void send({ kind: 'refresh' });
        void send({ kind: 'refreshPrs' });
        // A manual refresh means "ignore what you cached", including rows whose
        // state we assumed nothing could change.
        void send({ kind: 'refreshMerged', force: true });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onResult = (message: string, ok: boolean): void => setToast({ message, ok });

  const counts = snapshot?.fleet.counts;
  const blocked = counts ? counts.blocked_permission + counts.blocked_input : 0;
  const merged = snapshot?.merged?.prs ?? [];
  const prCount = snapshot?.prs
    ? snapshot.prs.reviewRequested.length + snapshot.prs.mine.length + merged.length
    : undefined;
  /**
   * Merges whose image is built and which nothing deployed.
   *
   * This is the number the feature exists for: it is what you would otherwise
   * announce as shipped without shipping it. Hoisted to the header so it does
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

  return (
    <div className="app">
      <div className="header">
        <div className="header-row">
          <span className="brand">fleetwood</span>
          <div className="pills">
            {blocked > 0 && <span className="pill blocked">✋ {blocked}</span>}
            {toDeploy > 0 && (
              <button
                className="pill to-deploy"
                title="merged, image built, nothing deployed it"
                onClick={() => setTab('prs')}
              >
                ⬆ {toDeploy} to deploy
              </button>
            )}
            {counts && counts.working > 0 && <span className="pill working">▶ {counts.working}</span>}
            {counts && <span className="pill">{counts.idle} idle</span>}
            {/* Summed over sessions and orphans alike, so the header agrees with
                the rows below it. */}
            {counts && counts.costUsd > 0 && (
              <span className="pill" title="what the whole fleet has spent, estimated at API rates">
                {money(counts.costUsd)}
              </span>
            )}
          </div>
          <button
            className={`icon-button${pinned ? ' on' : ''}`}
            title="keep on top of other windows"
            onClick={() => {
              const next = !pinned;
              setPinned(next);
              void send({ kind: 'setAlwaysOnTop', value: next });
            }}
          >
            ⇧
          </button>
          <button
            className="icon-button"
            title="refresh (⌘R)"
            onClick={() => {
              void send({ kind: 'refresh' });
              void send({ kind: 'refreshPrs' });
              void send({ kind: 'refreshMerged', force: true });
            }}
          >
            ↻
          </button>
        </div>
        <div className="tabs">
          <button className={`tab${tab === 'fleet' ? ' active' : ''}`} onClick={() => setTab('fleet')}>
            fleet<span className="count">{snapshot?.fleet.sessions.length ?? 0}</span>
          </button>
          <button className={`tab${tab === 'tasks' ? ' active' : ''}`} onClick={() => setTab('tasks')}>
            tasks<span className="count">{snapshot?.tasks.length ?? 0}</span>
          </button>
          <button className={`tab${tab === 'prs' ? ' active' : ''}`} onClick={() => setTab('prs')}>
            pull requests
            <span className="count">{prCount ?? '…'}</span>
          </button>
        </div>
      </div>

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
            {sessions.length === 0 && <div className="empty">no tmux sessions</div>}
            {sessions.map((session) => (
              <SessionCard key={session.sessionId} session={session} onResult={onResult} />
            ))}
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
          </>
        )}

        {snapshot && tab === 'tasks' && (
          <TaskList
            tasks={snapshot.tasks}
            fleet={snapshot.fleet}
            onResult={onResult}
            onNewTask={() => setNewTaskOpen(true)}
          />
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

      {/* Pinned below the scrolling body: it is ambient context, not something
          you act on, and it belongs to one agent tool rather than to the fleet. */}
      {snapshot?.limits && <LimitBars limits={snapshot.limits} />}

      <NewTask open={newTaskOpen} onClose={() => setNewTaskOpen(false)} onResult={onResult} />

      <Palette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        sessions={snapshot?.fleet.sessions.map((s) => s.name) ?? []}
        onResult={onResult}
      />

      {toast && <div className={`toast${toast.ok ? '' : ' error'}`}>{toast.message}</div>}
    </div>
  );
}
