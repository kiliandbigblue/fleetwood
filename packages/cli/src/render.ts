import type { AgentStatus, FleetAgent, FleetState } from '@fleetwood/core';
import { c, pad, relativeAge, tildify, width } from './ui.ts';

interface Style {
  glyph: string;
  paint: (s: string) => string;
  label: string;
}

const STYLES: Record<AgentStatus, Style> = {
  working: { glyph: '▶', paint: c.foam, label: 'working' },
  blocked_permission: { glyph: '✋', paint: c.love, label: 'permission' },
  blocked_input: { glyph: '✋', paint: c.gold, label: 'waiting' },
  compacting: { glyph: '⟳', paint: c.iris, label: 'compacting' },
  idle: { glyph: '○', paint: c.muted, label: 'idle' },
  starting: { glyph: '◌', paint: c.muted, label: 'starting' },
  error: { glyph: '✗', paint: c.love, label: 'error' },
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
      return c.iris('claude');
    case 'cursor':
      return c.foam('cursor');
    case 'codex':
      return c.gold('codex ');
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

export function renderAgentLine(agent: FleetAgent, indent = '    '): string {
  const style = STYLES[agent.status];
  const status = `${style.paint(style.glyph)} ${pad(style.paint(style.label), 11)}`;
  // "up 6h" reads as uptime; a bare "6h" would claim the agent has been in this
  // status that long, which nothing measured.
  const age = agent.ageIsUptime ? `up ${duration(agent.forSeconds)}` : duration(agent.forSeconds);
  const forTime = c.muted(pad(age, 8));
  // ⤶ a nested agent, ⇢ one hosted by the claude daemon and matched to this pane.
  const nested = agent.nested ? c.dim('⤶') : agent.hosted ? c.dim('⇢') : ' ';
  const subagents = agent.subagents > 0 ? c.iris(` +${agent.subagents}`) : '';
  const activity = agent.activity ? c.dim(` ${agent.activity}`) : '';
  const pane = c.muted(pad(agent.pane ?? '—', 4));
  return `${indent}${status}${provenanceMark(agent)} ${pane} ${toolLabel(agent.tool)}${nested}${subagents} ${forTime}${activity}`;
}

export function renderFleet(fleet: FleetState): string {
  const lines: string[] = [];
  const { counts } = fleet;

  const summary = [
    counts.working > 0 ? c.foam(`${counts.working} working`) : '',
    counts.blocked_permission + counts.blocked_input > 0
      ? c.love(`${counts.blocked_permission + counts.blocked_input} blocked`)
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

  const nameWidth = Math.max(...fleet.sessions.map((s) => width(s.name)), 10);

  for (const session of fleet.sessions) {
    const attached = session.attached > 0 ? c.foam('●') : c.muted('○');
    const attention = session.needsAttention ? c.love(' ✋') : '';
    const kind = session.meta.kind ? c.iris(session.meta.kind) : '';
    const pr = session.meta.pr ? c.gold(` ${session.meta.pr}`) : '';
    const branch = session.meta.branch ? c.rose(` ${session.meta.branch}`) : '';

    lines.push(
      `${attached} ${c.bold(pad(session.name, nameWidth))}${attention} ${kind}${branch}${pr} ${c.muted(tildify(session.path))} ${c.dim(relativeAge(session.createdAt))}`,
    );

    if (session.agents.length === 0) {
      const panes = session.windows.reduce((n, w) => n + w.panes.length, 0);
      lines.push(`    ${c.dim(`no agents · ${panes} pane${panes === 1 ? '' : 's'}`)}`);
    } else {
      // Whoever needs the human comes first.
      const ordered = [...session.agents].sort((a, b) => rank(a) - rank(b));
      for (const agent of ordered) lines.push(renderAgentLine(agent));
    }
    lines.push('');
  }

  // Three different situations, so don't file them under one scary label: an
  // agent in an editor was never in tmux, and a daemon-hosted one is running fine
  // — we just couldn't tell which terminal is showing it.
  const ORPHAN_LABELS = {
    'pane-gone': 'pane gone (ended without a closing event):',
    'daemon-hosted': 'hosted by the claude daemon (no terminal matched):',
    'outside-tmux': 'not in tmux (running in an editor):',
  } as const;
  for (const [reason, label] of Object.entries(ORPHAN_LABELS)) {
    const group = fleet.orphans.filter((a) => (a.orphanReason ?? 'pane-gone') === reason);
    if (group.length === 0) continue;
    lines.push(c.muted(label));
    for (const agent of group) lines.push(renderAgentLine(agent));
    lines.push('');
  }

  return lines.join('\n').replace(/\n+$/, '\n');
}

function rank(agent: FleetAgent): number {
  switch (agent.status) {
    case 'blocked_permission':
      return 0;
    case 'blocked_input':
      return 1;
    case 'error':
      return 2;
    case 'working':
      return 3;
    case 'compacting':
      return 4;
    case 'starting':
      return 5;
    case 'idle':
      return 6;
    case 'gone':
      return 7;
  }
}
