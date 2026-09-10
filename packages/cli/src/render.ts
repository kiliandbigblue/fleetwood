import type { AgentStatus, CursorUsage, FleetAgent, FleetState, PlanLimits } from '@fleetwood/core';
import { agentUrgency, formatUsd, isHidden, isPinned, sessionLabel, sortSessions } from '@fleetwood/core';
import { c, pad, relativeAge, tildify, width } from './ui.ts';

function resetClock(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return '';
  if (resetsAt - now <= 0) return 'resetting';
  const at = new Date(resetsAt * 1000);
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  const today = new Date(now * 1000);
  const startOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(at) - startOf(today)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) {
    const weekday = at.toLocaleDateString(undefined, { weekday: 'short' });
    return `${weekday} ${time}`;
  }
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * The Claude plan's quota, as `/usage` shows it.
 *
 * Rendered as bars rather than bare percentages because the point is a glance:
 * how much runway is left before the fleet stalls, not the exact figure.
 *
 * Labelled `claude` in that tool's own colour: a fleet also running cursor-agent
 * or codex would otherwise read this as covering all of them. Cursor has its own
 * block beside this one when `limits.cursorTokenCommand` is set.
 */
export function renderLimits(limits: PlanLimits): string {
  if (limits.windows.length === 0) return '';
  const now = Math.floor(Date.now() / 1000);
  const titleWidth = Math.max(...limits.windows.map((w) => width(w.title)));
  const lines: string[] = [`  ${c.accent('claude')} ${c.muted('plan usage')}`];

  for (const window of limits.windows) {
    const percent = Math.round(window.utilization * 100);
    const filled = Math.max(1, Math.round(window.utilization * 16));
    const paint = percent >= 90 ? c.danger : percent >= 75 ? c.warn : c.ok;
    const bar = `${paint('█'.repeat(filled))}${c.dim('░'.repeat(16 - filled))}`;
    const clock = resetClock(window.resetsAt, now);
    const reset = clock ? c.dim(` ${clock}`) : '';
    lines.push(
      `  ${c.muted(pad(window.title, titleWidth))}  ${bar} ${pad(`${percent}%`, 4)}${reset}`,
    );
  }
  if (limits.stale) {
    lines.push(c.dim(`  as of ${duration(now - limits.fetchedAt)} ago`));
  }
  return lines.join('\n');
}

/**
 * Cursor on-demand: this cycle, and today. Included is omitted — it is spent
 * every month on this plan, so a 100% bar would never change.
 */
export function renderCursorUsage(usage: CursorUsage): string {
  const now = Math.floor(Date.now() / 1000);
  const today = usage.todayCents === undefined ? c.dim('—') : formatUsd(usage.todayCents);
  const lines: string[] = [
    `  ${c.ok('cursor')} ${c.muted('plan usage')}`,
    `  ${c.muted(pad('This cycle', 12))}  ${formatUsd(usage.seatCents)}`,
    `  ${c.muted(pad('Today', 12))}  ${today}`,
  ];
  if (usage.stale) {
    lines.push(c.dim(`  as of ${duration(now - usage.fetchedAt)} ago`));
  }
  return lines.join('\n');
}

interface Style {
  glyph: string;
  paint: (s: string) => string;
  label: string;
}

const STYLES: Record<AgentStatus, Style> = {
  working: { glyph: '▶', paint: c.ok, label: 'working' },
  blocked_permission: { glyph: '✋', paint: c.danger, label: 'permission' },
  blocked_input: { glyph: '✋', paint: c.warn, label: 'waiting' },
  compacting: { glyph: '⟳', paint: c.accent, label: 'compacting' },
  idle: { glyph: '○', paint: c.muted, label: 'idle' },
  starting: { glyph: '◌', paint: c.muted, label: 'starting' },
  error: { glyph: '✗', paint: c.danger, label: 'error' },
  gone: { glyph: '×', paint: c.dim, label: 'gone' },
};

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  // Roll over to days: a session left running for a week is not "167h".
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return h % 24 === 0 ? `${d}d` : `${d}d${h % 24}h`;
  }
  return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
}

function toolLabel(tool: string): string {
  switch (tool) {
    case 'claude':
      return c.accent('claude');
    case 'cursor':
      return c.ok('cursor');
    case 'codex':
      return c.warn('codex ');
    default:
      return c.muted(tool);
  }
}

/** A trust marker, so an inferred status never looks as solid as a reported one. */
function provenanceMark(agent: FleetAgent): string {
  switch (agent.provenance) {
    case 'hook':
      return '';
    case 'screen':
      return c.dim('~');
    case 'process':
      return c.dim('?');
    case 'stale':
      return c.dim('…');
  }
}

/**
 * `▶ working` in the status' own colour, for a row that has no space for more.
 *
 * Exported so the picker's rows read as the fleet list's do: one glyph and one
 * word per status, chosen once. `pad` before painting, since every role closes
 * with a reset and padding after it would sit outside the colour.
 */
export function statusChip(status: AgentStatus, labelWidth = 0): string {
  const style = STYLES[status];
  return `${style.paint(style.glyph)} ${style.paint(pad(style.label, labelWidth))}`;
}

/** How long the agent has been in that status, or its uptime when nothing timed it. */
export function agentAge(agent: FleetAgent): string {
  return agent.ageIsUptime ? `up ${duration(agent.forSeconds)}` : duration(agent.forSeconds);
}

export function renderAgentLine(agent: FleetAgent, indent = '    '): string {
  const style = STYLES[agent.status];
  const status = `${style.paint(style.glyph)} ${pad(style.paint(style.label), 11)}`;
  // "up 6h" reads as uptime; a bare "6h" would claim the agent has been in this
  // status that long, which nothing measured.
  const age = agent.ageIsUptime ? `up ${duration(agent.forSeconds)}` : duration(agent.forSeconds);
  const forTime = c.muted(pad(age, 8));
  // ⤶ a nested agent, ⇢ one hosted by the claude daemon and matched to this pane.
  const nested = agent.nested ? c.dim('⤶') : agent.hosted ? c.dim('⇢') : ' ';
  const subagents = agent.subagents > 0 ? c.accent(` +${agent.subagents}`) : '';
  const activity = agent.activity ? c.dim(` ${agent.activity}`) : '';
  const pane = c.muted(pad(agent.pane ?? '—', 4));
  return `${indent}${status}${provenanceMark(agent)} ${pane} ${toolLabel(agent.tool)}${nested}${subagents} ${forTime}${activity}`;
}

/**
 * The fleet, as `fw status` and `fw watch` print it.
 *
 * `showHidden` is `--all`: sessions marked hidden (a `-` on the front of the tmux
 * name) are left out by default, exactly as the panel leaves them out, and
 * counted in a footer so the list never quietly shrinks.
 */
export function renderFleet(
  fleet: FleetState,
  limits?: PlanLimits,
  showHidden = false,
  cursorUsage?: CursorUsage,
): string {
  const lines: string[] = [];
  const { counts } = fleet;

  const summary = [
    counts.working > 0 ? c.ok(`${counts.working} working`) : '',
    counts.blocked_permission + counts.blocked_input > 0
      ? c.danger(`${counts.blocked_permission + counts.blocked_input} blocked`)
      : '',
    counts.idle > 0 ? c.muted(`${counts.idle} idle`) : '',
  ].filter(Boolean);

  lines.push(
    `${c.bold('fleetwood')} ${c.muted('·')} ${fleet.sessions.length} sessions ${c.muted('·')} ${
      summary.length > 0 ? summary.join(c.muted(' · ')) : c.muted('no agents')
    }`,
  );
  lines.push('');

  if (fleet.sessions.length === 0) {
    lines.push(c.muted('  no tmux server running'));
    return lines.join('\n');
  }

  /*
   * The same order and the same labels as the panel: a numbered session sits in
   * its slot, the rest are ranked by what they are doing, and the number itself
   * is fleetwood's bookkeeping rather than something to read here. `fw sessions`
   * is the view that still prints raw tmux names.
   */
  const ranked = sortSessions(fleet.sessions);
  const hidden = ranked.filter((s) => isHidden(s.name));
  const sessions = showHidden ? ranked : ranked.filter((s) => !isHidden(s.name));
  // `sessions` can be empty here while the fleet is not — everything is hidden.
  const nameWidth = Math.max(...sessions.map((s) => width(sessionLabel(s.name))), 10);

  for (const session of sessions) {
    const attached = session.attached > 0 ? c.ok('●') : c.muted('○');
    // Why this row is up here rather than where its agents would put it.
    const pin = isPinned(session.name) ? c.accent(' +') : '';
    const attention = session.needsAttention ? c.danger(' ✋') : '';
    // The word only shows under --all, which is where seeing which rows these
    // are is the whole point of the flag.
    const kind = [
      isHidden(session.name) ? c.dim('hidden') : '',
      session.meta.kind ? c.accent(session.meta.kind) : '',
    ]
      .filter(Boolean)
      .join(' ');
    const pr = session.meta.pr ? c.warn(` ${session.meta.pr}`) : '';
    const branch = session.meta.branch ? c.branch(` ${session.meta.branch}`) : '';

    lines.push(
      `${attached} ${c.bold(pad(sessionLabel(session.name), nameWidth))}${pin}${attention} ${kind}${branch}${pr} ${c.muted(tildify(session.path))} ${c.dim(relativeAge(session.createdAt))}`,
    );

    if (session.agents.length === 0) {
      const panes = session.windows.reduce((n, w) => n + w.panes.length, 0);
      lines.push(`    ${c.dim(`no agents · ${panes} pane${panes === 1 ? '' : 's'}`)}`);
    } else {
      // Whoever needs the human comes first.
      const ordered = [...session.agents].sort((a, b) => agentUrgency(a) - agentUrgency(b));
      for (const agent of ordered) lines.push(renderAgentLine(agent));
    }
    lines.push('');
  }

  /*
   * What the list left out, and how to see it.
   *
   * A count and not the rows: hiding a session is a decision, and reprinting it
   * under a "but here they are" heading would undo it. The number of them that
   * needs you rides along, because that is the one thing you would want to know
   * without asking. Painted in three pieces because every role here closes with
   * a reset, so a coloured span inside a muted one un-mutes the rest.
   */
  if (!showHidden && hidden.length > 0) {
    const needsYou = hidden.filter((s) => s.needsAttention).length;
    lines.push(
      c.muted(`${hidden.length} hidden`) +
        (needsYou > 0 ? c.warn(` · ${needsYou} needs you`) : '') +
        c.muted(' — fw status --all'),
    );
    lines.push('');
  }

  // Two different situations, so don't file them under one scary label: a
  // daemon-hosted one is running fine — we just couldn't tell which terminal is
  // showing it. Editor-hosted agents are dropped in buildFleet, not listed here.
  const ORPHAN_LABELS = {
    'pane-gone': 'pane gone (ended without a closing event):',
    'daemon-hosted': 'hosted by the claude daemon (no terminal matched):',
  } as const;
  for (const [reason, label] of Object.entries(ORPHAN_LABELS)) {
    const group = fleet.orphans.filter((a) => (a.orphanReason ?? 'pane-gone') === reason);
    if (group.length === 0) continue;
    lines.push(c.muted(label));
    for (const agent of group) lines.push(renderAgentLine(agent));
    lines.push('');
  }

  const body = lines.join('\n').replace(/\n+$/, '\n');

  // Quota last: standing context for the agent tools, not a per-agent fact.
  const bars = [limits ? renderLimits(limits) : '', cursorUsage ? renderCursorUsage(cursorUsage) : '']
    .filter(Boolean)
    .join('\n\n');
  return bars ? `${body}\n${bars}\n` : body;
}
