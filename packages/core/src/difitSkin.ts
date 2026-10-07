/**
 * What fleetwood adds to a difit page: its theme, a way to hand the review to
 * the agent, and a way to see a whole file.
 *
 * difit has none of them. Its colours are fixed GitHub greys with a choice of stock
 * syntax themes, and its comments leave the page only as a "Copy All Prompt" for
 * the clipboard. Both are added from outside rather than by patching difit: the
 * review proxy (`difitProxy.ts`) serves difit's own page with a stylesheet and a
 * script from here spliced into its head. Everything in this module is pure, so
 * the parts that read difit's shapes are tested against them.
 */
import type { Palette } from './theme.ts';
import type { FleetSession } from './fleet.ts';

/** Where the proxy serves what it adds, out of the way of difit's own routes. */
export const SKIN_PREFIX = '/__fleetwood';

/** `#rrggbb` at an alpha, as `#rrggbbaa` — difit's own variables are written that way. */
function alpha(hex: string, a: number): string {
  return `${hex}${Math.round(a * 255)
    .toString(16)
    .padStart(2, '0')}`;
}

/**
 * difit's colour variables, filled from a fleetwood palette.
 *
 * difit writes its theme as inline custom properties on `<html>`, so these need
 * `!important` to win. They are set on `:root` whatever difit's own appearance
 * says, because every fleetwood palette is dark: a light difit under a dark
 * palette is half of each. The script below asks difit for dark as well, so its
 * own light-only classes stay out of the way.
 *
 * Syntax follows `helldivers.lua` and the panel's roles alike: branch-blue
 * keywords, warm strings and numbers, the accent spent on functions and tags,
 * green types, comments in `dim`.
 */
export function difitSkinCss(p: Palette): string {
  const vars: Record<string, string> = {
    '--color-github-bg-primary': p.bg,
    '--color-github-bg-secondary': p.panel,
    '--color-github-bg-tertiary': p.edge,
    '--color-github-border': p.edge,
    '--color-github-text-primary': p.text,
    '--color-github-text-secondary': p.soft,
    '--color-github-text-muted': p.dim,
    '--color-github-accent': p.accent,
    '--color-github-danger': p.danger,
    '--color-github-warning': p.warn,
    '--color-diff-addition-bg': alpha(p.ok, 0.2),
    '--color-diff-addition-border': p.ok,
    '--color-diff-deletion-bg': alpha(p.danger, 0.2),
    '--color-diff-deletion-border': p.danger,
    '--color-diff-neutral-bg': p.panel,
    '--color-diff-selected-bg': alpha(p.warn, 0.15),
    '--color-diff-selected-border': alpha(p.warn, 0.4),
    '--color-comment-bg': p.panel,
    '--color-comment-border': p.edge,
    '--color-comment-text': p.text,
    // The "Copy All Prompt" button and the commented-file chips: difit's amber.
    '--color-yellow-btn-bg': alpha(p.accent, 0.15),
    '--color-yellow-btn-border': alpha(p.accent, 0.5),
    '--color-yellow-btn-text': p.accent,
    '--color-yellow-btn-hover-bg': alpha(p.accent, 0.25),
    '--color-yellow-btn-hover-border': p.accent,
    '--color-yellow-path-bg': alpha(p.accent, 0.2),
    '--color-yellow-path-text': p.accent,
    '--color-editor-btn-bg': alpha(p.text, 0.06),
    '--color-editor-btn-border': alpha(p.text, 0.25),
    '--color-editor-btn-text': p.text,
    '--color-editor-btn-hover-bg': alpha(p.text, 0.12),
    '--color-editor-btn-hover-border': alpha(p.text, 0.4),
    '--word-diff-added-bg': alpha(p.ok, 0.45),
    '--word-diff-removed-bg': alpha(p.danger, 0.45),
    '--word-highlight-color': alpha(p.warn, 0.3),
  };
  const root = Object.entries(vars)
    .map(([name, value]) => `  ${name}: ${value} !important;`)
    .join('\n');

  // prism-react-renderer paints each token inline from the syntax theme, and
  // also names it with classes — which is what lets a stylesheet take over.
  const tokens: [string, string, string?][] = [
    ['comment, .token.prolog, .token.doctype, .token.cdata', p.dim, 'font-style: italic !important;'],
    ['keyword, .token.important, .token.atrule, .token.selector', p.branch],
    ['string, .token.char, .token.template-string, .token.regex, .token.url', p.warn],
    ['number, .token.boolean', p.warn],
    ['function, .token.function-variable, .token.tag, .token.macro', p.accent],
    ['class-name, .token.builtin, .token.constant, .token.symbol, .token.namespace', p.ok],
    ['operator, .token.punctuation, .token.property, .token.attr-name', p.soft],
    ['variable, .token.parameter, .token.plain', p.text],
    ['deleted', p.danger],
    ['inserted', p.ok],
  ];
  const syntax = tokens
    .map(([selector, color, extra]) => `.token.${selector} { color: ${color} !important; ${extra ?? ''}}`)
    .join('\n');

  // The code in the terminal's font, ligatures on, as nvim draws it in Ghostty:
  // `:=` and `!=` read as the glyphs they are there.
  const code = `:root { --font-mono: 'FiraCode Nerd Font', 'Fira Code', ui-monospace, monospace !important; }
.font-mono, pre, code, .prism-code { font-family: var(--font-mono) !important; font-variant-ligatures: contextual; font-feature-settings: 'calt'; }`;

  // A pastel tint alone is easy to read past on a dark page, so a changed line
  // also gets a bar down its code edge and its line number in the change's
  // colour, as a gutter sign does in nvim. difit marks a changed line with
  // `bg-diff-*-bg` on the `<tr>` in the unified view and on the code `<td>`
  // side by side, where the line number is the cell just before it. The `+`
  // in the unified view is `text-github-accent`, which this palette makes the
  // accent rather than green, so it is set back to the change's colour.
  const changes = (['addition', 'deletion'] as const)
    .map((kind) => {
      const color = kind === 'addition' ? p.ok : p.danger;
      const bg = `.bg-diff-${kind}-bg`;
      return `tr${bg} > td:last-child, td${bg} { box-shadow: inset 3px 0 0 ${color}; }
tr${bg} > td:nth-child(-n+2), td:has(+ td${bg}) { color: ${color} !important; background-color: ${alpha(color, 0.12)} !important; }
span${bg} { color: ${color} !important; }`;
    })
    .join('\n');

  return `:root, :root[data-theme] {\n${root}\n  color-scheme: dark;\n}\n${code}\n${changes}\n${syntax}\n`;
}

/**
 * difit's page with the skin and the send button added to its head.
 *
 * The stylesheet goes last in the head so it follows difit's own; the script
 * goes first, because it has to settle difit's appearance before difit's module
 * reads it. A page with no `</head>` — difit changed shape — comes back as it
 * was rather than mangled: an unthemed review is still a review.
 */
export function injectSkin(html: string): string {
  if (!html.includes('</head>')) return html;
  const script = `<script src="${SKIN_PREFIX}/page.js"></script>`;
  const style = `<link rel="stylesheet" href="${SKIN_PREFIX}/skin.css">`;
  const withScript = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (head) => `${head}\n    ${script}`)
    : html;
  return withScript.replace('</head>', `    ${style}\n  </head>`);
}

/** A difit comment thread, as `/api/comments-json` returns it (difit's `DiffCommentThread`). */
export interface DifitThread {
  id: string;
  filePath: string;
  position: { side: 'old' | 'new'; line: number | { start: number; end: number } };
  codeSnapshot?: { content: string; language?: string };
  messages: { body: string; author?: string }[];
}

function lineRange(line: DifitThread['position']['line']): string {
  if (typeof line === 'number') return String(line);
  const { start, end } = line;
  return start === end ? String(start) : `${start}-${end}`;
}

/** A repo-relative path as an agent in `paneCwd` would write it. */
function pathFor(file: string, worktree: string, paneCwd: string | undefined): string {
  const absolute = `${worktree.replace(/\/$/, '')}/${file}`;
  if (!paneCwd) return absolute;
  const base = paneCwd.replace(/\/$/, '');
  return absolute.startsWith(`${base}/`) ? absolute.slice(base.length + 1) : absolute;
}

/**
 * The threads as one prompt, in the shape the nvim review sent.
 *
 * One heading per comment, saying where it is, then the code it was made on,
 * then what was said — replies kept, with who said them. Paths are written as
 * the agent would write them from its own directory, which is often the task
 * folder above the worktree rather than the worktree itself.
 */
export function reviewPrompt(threads: DifitThread[], worktree: string, paneCwd?: string): string {
  const out = ['Review comments on your changes. Address each one, and say so if you disagree with any.', ''];
  for (const thread of threads) {
    let where = `${pathFor(thread.filePath, worktree, paneCwd)}:${lineRange(thread.position.line)}`;
    if (thread.position.side === 'old') where += ' (the code before your change)';
    out.push(`## ${where}`);
    const code = thread.codeSnapshot;
    if (code?.content) out.push(`\`\`\`${code.language ?? ''}`, code.content, '```');
    thread.messages.forEach((message, index) => {
      if (index > 0) out.push(`Reply (${message.author?.trim() || 'unknown'}):`);
      out.push(message.body.trim());
    });
    out.push('');
  }
  return out.join('\n').trimEnd();
}

export interface ReviewPane {
  paneId: string;
  cwd?: string;
  /** How the click names it back: `window: title`, as the nvim picker did. */
  label: string;
}

/**
 * The Claude pane a review of `worktree` should go to, if there is one.
 *
 * Only the task's own session, and only an agent at a terminal: a nested agent
 * is some other agent's helper, and pasting into its pane would type into the
 * parent. Among those, one working in this worktree beats one that is not — a
 * task with a reflow agent and a graphy agent wants each review back where it
 * came from — and otherwise the first is as good a guess as any.
 */
export function reviewPane(
  sessions: FleetSession[],
  session: string | undefined,
  worktree: string,
): ReviewPane | undefined {
  const home = sessions.find((s) => s.name === session);
  if (!home) return undefined;
  const claude = home.agents.filter((agent) => agent.tool === 'claude' && !agent.nested && agent.pane);
  const inside = (cwd: string | undefined): boolean =>
    cwd !== undefined && (cwd === worktree || cwd.startsWith(`${worktree}/`));
  const agent = claude.find((a) => inside(a.cwd)) ?? claude[0];
  if (!agent?.pane) return undefined;

  const pane = home.windows.flatMap((w) => w.panes.map((p) => ({ ...p, window: w.name }))).find(
    (p) => p.paneId === agent.pane,
  );
  return {
    paneId: agent.pane,
    cwd: agent.cwd ?? pane?.cwd,
    label: pane ? `${pane.window}: ${pane.title}` : agent.pane,
  };
}

/**
 * What difit's page gains: a "whole file" button on each file, and "Send to
 * Claude" with the open thread count.
 *
 * "whole file" works difit's own expand buttons rather than fetching the file
 * itself, so what it shows is exactly what difit would after enough clicks —
 * comments on the unfolded lines included. It finds them by their aria-labels.
 *
 * It asks the proxy, not difit, so the comments are read and resolved in one
 * place that also knows which pane to send to. When there is no pane to send to,
 * the proxy answers with the prompt instead and this puts it on the clipboard,
 * as the nvim review did — the review is never lost for want of an agent.
 *
 * Plain script, no module: it has to run before difit's own module does, to ask
 * for the dark appearance the skin is drawn for.
 */
export const PAGE_SCRIPT = `(() => {
  try {
    const key = 'reviewit-appearance-settings';
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    if (saved.theme !== 'dark') localStorage.setItem(key, JSON.stringify({ ...saved, theme: 'dark' }));
  } catch {}

  const prefix = ${JSON.stringify(SKIN_PREFIX)};
  const query = () => location.search;
  let count = 0;
  let busy = false;

  const button = document.createElement('button');
  button.id = 'fleetwood-send';
  const toast = document.createElement('div');
  toast.id = 'fleetwood-toast';

  const draw = () => {
    button.textContent = busy ? 'Sending…' : count > 0 ? 'Send to Claude (' + count + ')' : 'Send to Claude';
    button.disabled = busy || count === 0;
  };
  const say = (text, ok) => {
    toast.textContent = text;
    toast.dataset.ok = ok ? '1' : '0';
    toast.dataset.shown = '1';
    clearTimeout(say.timer);
    say.timer = setTimeout(() => { toast.dataset.shown = '0'; }, 4000);
  };

  const poll = async () => {
    try {
      const res = await fetch('/api/comments-json' + query());
      const body = await res.json();
      count = Array.isArray(body.threads) ? body.threads.length : 0;
    } catch {}
    draw();
  };

  button.addEventListener('click', async () => {
    busy = true;
    draw();
    try {
      const res = await fetch(prefix + '/send' + query(), { method: 'POST' });
      const body = await res.json();
      if (body.clipboard) {
        await navigator.clipboard.writeText(body.clipboard);
      }
      say(body.detail, body.ok);
    } catch (error) {
      say('could not reach fleetwood: ' + error, false);
    }
    busy = false;
    await poll();
  });

  // "whole file": difit unfolds a gap twenty lines at a time, or all of it once
  // it is twenty or fewer; this presses those until the file has no gaps left.
  // [0-9], not \\d: this is a template literal, which eats the backslash.
  const unfoldLabel = /^Expand (all [0-9]+|[0-9]+) hidden lines?/;
  // difit re-renders a file's card as lines arrive, so neither the card nor
  // the button on it can be held across a click: both are found again by path.
  const cardFor = (path) => document.querySelector('main [data-file-path="' + CSS.escape(path) + '"]');
  const unfolding = new Set();
  const label = (path) => {
    const control = cardFor(path)?.querySelector('.fleetwood-unfold');
    if (!control) return;
    control.disabled = unfolding.has(path);
    control.textContent = unfolding.has(path) ? 'unfolding…' : 'whole file';
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const quiet = async (path) => {
    for (let calm = 0; calm < 3; ) {
      await sleep(40);
      calm = cardFor(path)?.querySelector('.animate-spin') ? 0 : calm + 1;
    }
  };
  const expanders = (path) =>
    [...(cardFor(path)?.querySelectorAll('button[aria-label]') ?? [])].filter(
      (b) => !b.disabled && unfoldLabel.test(b.getAttribute('aria-label')),
    );
  const unfold = async (path) => {
    if (unfolding.has(path)) return;
    unfolding.add(path);
    label(path);
    cardFor(path)?.querySelector('button[title^="Expand file"]')?.click();
    try {
      for (let i = 0; i < 2000; i++) {
        await quiet(path);
        let buttons = expanders(path);
        if (buttons.length === 0) {
          await sleep(250);
          await quiet(path);
          buttons = expanders(path);
          if (buttons.length === 0) break;
        }
        const next = buttons.find((b) => b.getAttribute('aria-label').startsWith('Expand all')) ?? buttons[0];
        next.click();
      }
    } finally {
      unfolding.delete(path);
      label(path);
    }
  };
  const addUnfold = () => {
    for (const card of document.querySelectorAll('main [data-file-path]')) {
      const title = card.querySelector('h2');
      if (!title || card.querySelector('.fleetwood-unfold')) continue;
      const path = card.dataset.filePath;
      const control = document.createElement('button');
      control.className = 'fleetwood-unfold';
      control.type = 'button';
      control.title = 'Unfold every hidden line in this file';
      control.addEventListener('click', (event) => {
        event.stopPropagation();
        unfold(path);
      });
      title.after(control);
      label(path);
    }
  };

  const mount = () => {
    document.body.append(button, toast);
    draw();
    poll();
    setInterval(poll, 1500);
    addUnfold();
    new MutationObserver(addUnfold).observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
`;

/** The button's own look, appended to the skin so it wears the same palette. */
export function sendButtonCss(p: Palette): string {
  return `#fleetwood-send {
  position: fixed; right: 20px; bottom: 20px; z-index: 1000;
  padding: 8px 14px; border-radius: 6px; cursor: pointer;
  font: 600 13px/1 ui-monospace, 'Fira Code', monospace;
  background: ${p.accent}; color: ${p.bg}; border: 1px solid ${p.accent};
  box-shadow: 0 4px 16px ${alpha(p.bg, 0.6)};
}
#fleetwood-send:hover:not(:disabled) { filter: brightness(1.1); }
#fleetwood-send:disabled { cursor: default; background: ${p.panel}; color: ${p.dim}; border-color: ${p.edge}; }
button.fleetwood-unfold {
  flex: none; padding: 2px 8px; border-radius: 4px; cursor: pointer;
  font: 12px/1.4 ui-monospace, 'Fira Code', monospace;
  background: transparent; color: ${p.soft}; border: 1px solid ${p.edge};
}
button.fleetwood-unfold:hover:not(:disabled) { color: ${p.accent}; border-color: ${p.accent}; }
button.fleetwood-unfold:disabled { cursor: default; color: ${p.dim}; }
#fleetwood-toast {
  position: fixed; right: 20px; bottom: 64px; z-index: 1000; max-width: 420px;
  padding: 8px 12px; border-radius: 6px; font: 12px/1.4 ui-monospace, 'Fira Code', monospace;
  background: ${p.panel}; color: ${p.text}; border: 1px solid ${p.edge};
  opacity: 0; transform: translateY(4px); transition: opacity .15s, transform .15s; pointer-events: none;
}
#fleetwood-toast[data-shown='1'] { opacity: 1; transform: none; }
#fleetwood-toast[data-ok='0'] { border-color: ${p.danger}; }
`;
}
