import { homedir } from 'node:os';

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

function wrap(open: string): (s: string) => string {
  return (s) => (useColor ? `\x1b[${open}m${s}\x1b[0m` : s);
}

/** Rose Pine, to match the tmux theme. */
export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  love: wrap('38;2;235;111;146'), // red — blocked / error
  gold: wrap('38;2;246;193;119'), // yellow — waiting
  rose: wrap('38;2;234;154;151'),
  pine: wrap('38;2;49;116;143'), // teal — idle
  foam: wrap('38;2;156;207;216'), // cyan — working
  iris: wrap('38;2;196;167;231'), // purple — accents
  muted: wrap('38;2;110;106;134'),
  text: wrap('38;2;224;222;244'),
};

/** Collapse $HOME to ~ so paths stay scannable. */
export function tildify(p: string): string {
  const home = homedir();
  return p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

export function relativeAge(epochSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Visible width, ignoring ANSI escapes. */
export function width(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

export function pad(s: string, to: number): string {
  const gap = to - width(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}
