import { useEffect, useMemo, useRef, useState } from 'react';
import { sameSession, sessionLabel } from '@fleetwood/core/sessionOrder';
import { send, tildify } from './api.ts';

interface Project {
  path: string;
  name: string;
  repo?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  sessions: string[];
  onNewTask: (summary: string) => void;
  onResult: (message: string, ok: boolean) => void;
}

interface Item {
  kind: 'session' | 'project' | 'new-task';
  /** What to act on: a real tmux session name, order prefix and all. */
  name: string;
  /** What to show and search on — the name without its order prefix. */
  label: string;
  path: string;
}

/**
 * ⌘K entry point: jump to a session, open a project, or start a task.
 *
 * Projects come from the same roots the existing tmux-sessionizer scans, and
 * opening one is find-or-create by the same session name — so this and
 * `prefix+g` always land in the same session rather than making two.
 */
export function Palette({ open, onClose, sessions, onNewTask, onResult }: Props): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    inputRef.current?.focus();
    void send({ kind: 'listProjects' }).then((result) => {
      if ('projects' in result) setProjects(result.projects);
    });
  }, [open]);

  const items = useMemo((): Item[] => {
    const needle = query.toLowerCase().trim();
    const sessionItems = sessions.map((name) => ({
      kind: 'session' as const,
      name,
      label: sessionLabel(name),
      path: '',
    }));
    const projectItems = projects
      // A project with a live session is already offered above — by label, since
      // an ordered session is still that project's.
      .filter((p) => !sessions.some((name) => sameSession(name, p.name.replaceAll('.', '_'))))
      .map((p) => ({ kind: 'project' as const, name: p.name, label: p.name, path: p.path }));
    const all = [...sessionItems, ...projectItems];
    const found =
      needle.length === 0
        ? all.slice(0, 40)
        : all
            .filter((i) => i.label.toLowerCase().includes(needle) || i.path.toLowerCase().includes(needle))
            .slice(0, 40);
    /*
     * Every list here is of things that already exist, which dead-ends at exactly
     * the moment worth catching: you typed the name of the work, nothing matched,
     * and what you actually wanted was to start it. So the action is always
     * present and the text you typed becomes the task's summary.
     *
     * Last rather than first, because Enter on a match has to stay a jump — that
     * is what the palette is opened for the other ninety-nine times.
     */
    return [...found, { kind: 'new-task', name: query.trim(), label: query.trim(), path: '' }];
  }, [query, projects, sessions]);

  if (!open) return null;

  const choose = async (index: number): Promise<void> => {
    const item = items[index];
    if (!item) return;
    onClose();
    if (item.kind === 'new-task') {
      // Handed to the form rather than created here: a task needs a microservice
      // and a repo set, and neither is guessable from a palette query.
      onNewTask(item.name);
      return;
    }
    const result =
      item.kind === 'session'
        ? await send({ kind: 'focusSession', session: item.name })
        : await send({ kind: 'openProject', path: item.path });
    onResult(result.detail, result.ok);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgb(0 0 0 / 55%)',
        padding: '40px 12px 12px',
        zIndex: 10,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--edge)',
          borderRadius: 'var(--radius)',
          overflow: 'hidden',
          maxHeight: '80%',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          placeholder="jump to a session, open a project, start a task…"
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
            else if (event.key === 'ArrowDown') setCursor((c) => Math.min(c + 1, items.length - 1));
            else if (event.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0));
            else if (event.key === 'Enter') void choose(cursor);
          }}
          style={{
            padding: '10px 12px',
            background: 'transparent',
            border: 0,
            borderBottom: '1px solid var(--edge)',
            color: 'var(--text)',
            font: 'inherit',
            outline: 'none',
          }}
        />
        <div style={{ overflowY: 'auto' }}>
          {items.map((item, index) => (
            <div
              key={`${item.kind}:${item.name}:${item.path}`}
              onMouseEnter={() => setCursor(index)}
              onClick={() => void choose(index)}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'baseline',
                padding: '6px 12px',
                background: index === cursor ? 'var(--edge)' : 'transparent',
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  color:
                    item.kind === 'session'
                      ? 'var(--ok)'
                      : item.kind === 'new-task'
                        ? 'var(--accent)'
                        : 'var(--dim)',
                  fontSize: 10,
                }}
              >
                {item.kind === 'new-task' ? 'task' : item.kind}
              </span>
              <span>
                {item.kind === 'new-task'
                  ? item.label.length > 0
                    ? `new task: ${item.label}`
                    : 'new task…'
                  : item.label}
              </span>
              {item.kind === 'new-task' && (
                <span className="path" style={{ marginLeft: 'auto' }}>
                  ⌘T
                </span>
              )}
              {item.path && (
                <span className="path" style={{ marginLeft: 'auto', maxWidth: '55%' }}>
                  {tildify(item.path)}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
