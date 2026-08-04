import { useEffect, useMemo, useState } from 'react';
import { send } from './api.ts';

interface Project {
  path: string;
  name: string;
  repo?: string;
  isRepo: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onResult: (message: string, ok: boolean) => void;
}

const TYPES = ['feature', 'fix', 'chore'] as const;

/** Mirrors `slugify` in core, so the preview matches the branch that gets created. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function buildBranch(type: string, microservice: string, summary: string): string {
  const rest = [slugify(microservice), slugify(summary)].filter((p) => p.length > 0).join('-');
  return `${slugify(type) || 'feature'}/${rest}`;
}

/**
 * Create a task: one branch, a worktree per repo, one session.
 *
 * The branch is shown live and every repo's branch is visible before anything is
 * created — the convention puts a microservice in the name, and only you know
 * which one, so nothing is guessed silently.
 */
export function NewTask({ open, onClose, onResult }: Props): React.JSX.Element | null {
  const [type, setType] = useState<string>('feature');
  const [microservice, setMicroservice] = useState('');
  const [summary, setSummary] = useState('');
  const [goal, setGoal] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setType('feature');
    setMicroservice('');
    setSummary('');
    setGoal('');
    setQuery('');
    setSelected([]);
    void send({ kind: 'listProjects' }).then((result) => {
      if ('projects' in result) setProjects(result.projects.filter((p) => p.isRepo));
    });
  }, [open]);

  const branch = buildBranch(type, microservice, summary);
  const ready = microservice.trim().length > 0 && summary.trim().length > 0 && selected.length > 0;

  const matches = useMemo(() => {
    const needle = query.toLowerCase().trim();
    const pool = needle.length === 0 ? projects : projects.filter((p) => p.name.toLowerCase().includes(needle));
    // Selected repos stay visible even when the search would exclude them.
    const chosen = projects.filter((p) => selected.includes(p.name) && !pool.includes(p));
    return [...chosen, ...pool].slice(0, 40);
  }, [projects, query, selected]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    if (!ready || busy) return;
    setBusy(true);
    const result = await send({
      kind: 'createTask',
      type,
      microservice,
      summary,
      goal: goal.trim().length > 0 ? goal.trim() : undefined,
      repos: selected,
    });
    setBusy(false);
    onResult(result.detail, result.ok);
    if (result.ok) onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-title">new task</div>

        <div className="field-row">
          {TYPES.map((t) => (
            <button key={t} className={`type-chip${type === t ? ' on' : ''}`} onClick={() => setType(t)}>
              {t}
            </button>
          ))}
        </div>

        <input
          autoFocus
          className="field"
          value={microservice}
          placeholder="microservice, e.g. flow"
          onChange={(event) => setMicroservice(event.target.value)}
        />
        <input
          className="field"
          value={summary}
          placeholder="summary, e.g. execution labels"
          onChange={(event) => setSummary(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && ready) void submit();
          }}
        />

        <div className="branch-preview" title="the branch created in every repo you pick">
          {branch}
        </div>

        <textarea
          className="field"
          rows={2}
          value={goal}
          placeholder="goal for TASK.md (optional)"
          onChange={(event) => setGoal(event.target.value)}
        />

        <input
          className="field"
          value={query}
          placeholder="filter repos…"
          onChange={(event) => setQuery(event.target.value)}
        />

        <div className="repo-picker">
          {matches.map((project) => {
            const on = selected.includes(project.name);
            return (
              <label key={project.path} className={`repo-option${on ? ' on' : ''}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    setSelected((current) =>
                      current.includes(project.name)
                        ? current.filter((n) => n !== project.name)
                        : [...current, project.name],
                    )
                  }
                />
                <span>{project.name}</span>
                {on && <span className="repo-branch-hint">{branch}</span>}
              </label>
            );
          })}
        </div>

        <div className="modal-actions">
          <span className="modal-note">
            {selected.length === 0
              ? 'pick at least one repo — you can add more later'
              : `${selected.length} worktree${selected.length === 1 ? '' : 's'} will be created`}
          </span>
          <button className="chip" onClick={onClose}>
            cancel
          </button>
          <button className="button approve" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? 'creating…' : 'create'}
          </button>
        </div>
      </div>
    </div>
  );
}
