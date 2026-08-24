import { run } from './exec.ts';
import type { AgentProcess, AgentTool } from './types.ts';

export interface ProcRow {
  pid: number;
  ppid: number;
  cpu: number;
  elapsedSeconds: number;
  command: string;
}

export interface ProcTable {
  byPid: Map<number, ProcRow>;
  children: Map<number, number[]>;
}

/**
 * Agent detection runs on full argv, never on the process name.
 *
 * Claude Code's real pane process is the versioned binary
 * (`~/.local/share/claude/versions/2.1.220`), so tmux reports
 * `pane_current_command` as "2.1.220" and `comm` is equally useless.
 *
 * The excludes matter as much as the includes: a single interactive Claude Code
 * session also spawns `claude daemon run`, several `claude bg-pty-host`
 * helpers, and a `ClaudeCode.app` host — all descendants of the same pane. Left
 * unfiltered they'd read as five agents in one pane.
 */
interface Matcher {
  tool: AgentTool;
  include: RegExp;
  exclude?: RegExp;
}

const MATCHERS: Matcher[] = [
  {
    tool: 'claude',
    include: /(?:\/\.local\/share\/claude\/versions\/|(?:^|\/)claude(?:\s|$))/,
    exclude:
      /(?:\/Applications\/Claude\.app\/|\bdaemon\s+run\b|\bbg-pty-host\b|--bg-pty-host|--bg-spare)/,
  },
  {
    tool: 'cursor',
    // Cursor ships both names: `cursor-agent` (older) and `agent` (current
    // installer symlink). The short name alone would false-positive on any
    // binary called `agent`, so it only counts when argv still points at the
    // cursor-agent install under ~/.local/share/cursor-agent/.
    include: /(?:^|\/)cursor-agent(?:\s|$)|(?:^|\/)agent\s+.*\/cursor-agent\//,
    exclude: /\/Applications\/Cursor\.app\//,
  },
  {
    tool: 'codex',
    include: /(?:^|\/)codex(?:\s|$)/,
    exclude: /\/Applications\//,
  },
];

/** Which agent CLI a command line represents, if any. */
export function classify(command: string): AgentTool | undefined {
  for (const m of MATCHERS) {
    if (m.exclude?.test(command)) continue;
    if (m.include.test(command)) return m.tool;
  }
  return undefined;
}

/** ps reports elapsed time as [[DD-]HH:]MM:SS. */
export function parseElapsed(etime: string): number {
  const [daysPart, clockPart] = etime.includes('-')
    ? (etime.split('-') as [string, string])
    : ['0', etime];
  const days = Number.parseInt(daysPart, 10) || 0;
  const bits = clockPart.split(':').map((b) => Number.parseInt(b, 10) || 0);
  const [h, m, s] = bits.length === 3 ? bits : [0, bits[0] ?? 0, bits[1] ?? 0];
  return days * 86_400 + (h ?? 0) * 3_600 + (m ?? 0) * 60 + (s ?? 0);
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/;

export function parsePs(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    rows.push({
      pid: Number.parseInt(m[1] as string, 10),
      ppid: Number.parseInt(m[2] as string, 10),
      cpu: Number.parseFloat(m[3] as string),
      elapsedSeconds: parseElapsed(m[4] as string),
      command: m[5] as string,
    });
  }
  return rows;
}

export function buildProcTable(rows: ProcRow[]): ProcTable {
  const byPid = new Map<number, ProcRow>();
  const children = new Map<number, number[]>();
  for (const r of rows) {
    byPid.set(r.pid, r);
    const siblings = children.get(r.ppid);
    if (siblings) siblings.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  return { byPid, children };
}

/** One `ps` for the whole machine; callers slice it per pane. */
export async function scanProcesses(): Promise<ProcTable> {
  const { stdout } = await run('ps', ['-Ao', 'pid=,ppid=,pcpu=,etime=,command=']);
  return buildProcTable(parsePs(stdout));
}

/**
 * Agents running under a pane, breadth-first so the outermost process wins.
 *
 * At most one hit per tool: a Claude Code session nests several matching
 * processes, and the shallowest is the one the human is talking to.
 */
export function agentsInPane(table: ProcTable, panePid: number, maxDepth = 8): AgentProcess[] {
  const found = new Map<AgentTool, AgentProcess>();
  let frontier = [panePid];
  const seen = new Set<number>([panePid]);

  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const pid of frontier) {
      const row = table.byPid.get(pid);
      if (row) {
        const tool = classify(row.command);
        if (tool && !found.has(tool)) {
          found.set(tool, {
            pid: row.pid,
            ppid: row.ppid,
            cpu: row.cpu,
            elapsedSeconds: row.elapsedSeconds,
            command: row.command,
            tool,
          });
        }
      }
      for (const child of table.children.get(pid) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        next.push(child);
      }
    }
    frontier = next;
  }

  return [...found.values()];
}

/** Is a specific pid still alive and still looking like the agent we recorded? */
export function processAlive(table: ProcTable, pid: number | undefined): boolean {
  return pid !== undefined && table.byPid.has(pid);
}

/**
 * Which pane owns `pid`, by walking up its ancestry.
 *
 * Needed because a background or nested agent's hooks run with no `$TMUX_PANE`
 * — their environment is detached from the terminal — so the only way back to
 * the pane is through the process tree.
 *
 * `panePids` maps a pane's pid to its pane id; a pane's own process counts as a
 * match, since an interactive agent often *is* the pane process.
 */
export function resolvePaneForPid(
  table: ProcTable,
  pid: number,
  panePids: Map<number, string>,
  maxHops = 24,
): string | undefined {
  let current: number | undefined = pid;
  const seen = new Set<number>();
  for (let hop = 0; hop < maxHops && current !== undefined && current > 1; hop++) {
    const pane = panePids.get(current);
    if (pane) return pane;
    if (seen.has(current)) break;
    seen.add(current);
    current = table.byPid.get(current)?.ppid;
  }
  return undefined;
}
