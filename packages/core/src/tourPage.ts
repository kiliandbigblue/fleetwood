import type { Palette } from './theme.ts';

const alpha = (hex: string, a: number): string =>
  `${hex}${Math.round(a * 255)
    .toString(16)
    .padStart(2, '0')}`;

/**
 * The review page: one HTML document, its script and style inline.
 *
 * Three panes. The section rail on the left says where you are and what is
 * left; the centre is the section's code and nothing else; the inspector on
 * the right holds everything *about* the code — the summary, the unchanged
 * code it leans on, and the thread of the line under the cursor, which it
 * follows as you move.
 *
 * It reads everything from `./data` and writes through the routes beside it
 * (see `tour.ts`), so there is no build step and nothing to serve but this.
 * The script is plain ES with no template literals, so it sits in this one
 * without escaping.
 */
export function tourPage(p: Palette): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review</title>
<style>
${pageCss(p)}
</style>
</head>
<body>
<div class="app">
  <nav class="rail" id="rail" aria-label="Sections"></nav>
  <main class="stage" id="stage"></main>
  <aside class="inspector" id="inspector" aria-label="Inspector"></aside>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>
${PAGE_SCRIPT}
</script>
</body>
</html>`;
}

function pageCss(p: Palette): string {
  return `
:root {
  color-scheme: dark;
  --bg: ${p.bg}; --panel: ${p.panel}; --edge: ${p.edge}; --dim: ${p.dim}; --soft: ${p.soft};
  --text: ${p.text}; --danger: ${p.danger}; --warn: ${p.warn}; --ok: ${p.ok}; --accent: ${p.accent};
  --branch: ${p.branch};
  --add-row: ${alpha(p.ok, 0.08)}; --add-word: ${alpha(p.ok, 0.26)};
  --del-row: ${alpha(p.danger, 0.08)}; --del-word: ${alpha(p.danger, 0.26)};
  --cursor: ${alpha(p.accent, 0.12)}; --hover: ${alpha(p.text, 0.035)};
  --accent-soft: ${alpha(p.accent, 0.16)}; --warn-soft: ${alpha(p.warn, 0.14)};
  --ok-soft: ${alpha(p.ok, 0.16)}; --danger-soft: ${alpha(p.danger, 0.12)};
  --code: 'FiraCode Nerd Font', 'Fira Code', ui-monospace, monospace;
  --chrome: ui-monospace, 'SF Mono', Menlo, monospace;
  --prose: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px;
  --radius: 6px;
  --ease: cubic-bezier(.16, 1, .3, 1);
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); }
body { font: 13px/1.5 var(--chrome); -webkit-font-smoothing: antialiased; }
::selection { background: ${alpha(p.accent, 0.32)}; color: var(--text); }
:focus-visible { outline: 1.5px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
* { scrollbar-width: thin; scrollbar-color: var(--edge) transparent; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: var(--edge); border-radius: 10px; border: 3px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-track { background: transparent; }
svg.i { width: 14px; height: 14px; flex: none; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

button { font: inherit; color: var(--soft); background: transparent; border: 1px solid var(--edge); border-radius: var(--radius);
  padding: 5px 10px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; flex: none; transition: color .15s, border-color .15s, background .15s; }
button:hover:not(:disabled) { color: var(--text); border-color: ${alpha(p.text, 0.22)}; }
button:active:not(:disabled) { transform: translateY(.5px); }
button:disabled { opacity: .45; cursor: default; }
button.ghost { border-color: transparent; padding: 3px 6px; }
button.ghost:hover:not(:disabled) { background: var(--hover); border-color: transparent; }
button.primary { color: var(--bg); background: var(--accent); border-color: var(--accent); font-weight: 600; }
button.primary:hover:not(:disabled) { color: var(--bg); background: ${alpha(p.accent, 0.88)}; }
button.done { color: var(--ok); border-color: ${alpha(p.ok, 0.4)}; }
button.send { color: var(--bg); background: var(--warn); border-color: var(--warn); font-weight: 600; width: 100%; justify-content: center; }
button.send:hover:not(:disabled) { color: var(--bg); background: ${alpha(p.warn, 0.88)}; }
button.send:disabled { background: transparent; border-color: var(--edge); color: var(--dim); opacity: 1; font-weight: 400; }
kbd { font: 11px var(--chrome); color: var(--dim); border: 1px solid var(--edge); border-bottom-width: 2px; border-radius: 4px; padding: 0 5px; min-width: 18px; text-align: center; display: inline-block; }
button kbd { border-color: currentColor; opacity: .7; color: inherit; }

.app { display: grid; grid-template-columns: 252px minmax(0, 1fr) 380px; height: 100vh; }

/* ── rail ── */
.rail { background: var(--panel); border-right: 1px solid var(--edge); display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.rail-head { padding: var(--s5) var(--s4) var(--s4); }
.repo { font: 600 14px/1.3 var(--code); color: var(--text); overflow-wrap: anywhere; }
.base { color: var(--dim); margin-top: 2px; display: flex; align-items: center; gap: 6px; }
.base .ref { color: var(--branch); }
.progress { padding: 0 var(--s4) var(--s4); border-bottom: 1px solid var(--edge); }
.segments { display: flex; gap: 3px; height: 4px; }
.segments span { flex: 1; border-radius: 2px; background: var(--edge); transition: background .25s var(--ease); }
.segments span.done { background: var(--ok); }
.segments span.current { background: var(--accent); }
.progress-label { color: var(--dim); margin-top: var(--s2); font-variant-numeric: tabular-nums; }
.progress-label b { color: var(--text); font-weight: 600; }
.sections { list-style: none; margin: 0; padding: var(--s2); overflow-y: auto; flex: 1; }
.sections li { display: grid; grid-template-columns: 16px 22px 1fr; gap: 6px; align-items: start; padding: 7px var(--s2); border-radius: var(--radius); cursor: pointer; color: var(--soft); transition: background .15s; }
.sections li:hover { background: var(--hover); }
.sections li.current { background: var(--accent-soft); color: var(--text); }
.sections li .mark { color: var(--dim); margin-top: 2px; }
.sections li.done .mark { color: var(--ok); }
.sections li.current .mark { color: var(--accent); }
.sections li .n { color: var(--dim); font-variant-numeric: tabular-nums; }
.sections li.current .n { color: var(--accent); }
.sections li .t { line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.sections li.done:not(.current) .t { color: var(--dim); }
.sections li .tag { display: block; color: var(--dim); font-size: 11px; margin-top: 1px; }
.sections li.uncovered .tag { color: var(--warn); }
.legend { border-top: 1px solid var(--edge); padding: var(--s3) var(--s4); color: var(--dim); font-size: 11.5px; display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; }

/* ── stage ── */
.stage { overflow-y: auto; min-width: 0; scroll-padding-top: 96px; }
.stage-head { position: sticky; top: 0; z-index: 3; background: ${alpha(p.bg, 0.92)}; backdrop-filter: blur(8px);
  display: flex; align-items: center; justify-content: space-between; gap: var(--s5); padding: var(--s5) var(--s6) var(--s4); border-bottom: 1px solid var(--edge); }
.stage-head h1 { margin: 0; font: 600 20px/1.3 var(--code); letter-spacing: -0.01em; text-wrap: balance; display: flex; gap: var(--s3); align-items: baseline; }
.stage-head h1 .n { color: var(--accent); font-weight: 500; font-variant-numeric: tabular-nums; }
.stage-head h1 .kind { font: 400 12px var(--chrome); color: var(--dim); white-space: nowrap; }
.stage-body { padding: var(--s5) var(--s6) 160px; }
.banner { display: flex; align-items: center; justify-content: space-between; gap: var(--s4); margin: var(--s4) var(--s6) 0; padding: var(--s3) var(--s4);
  border-radius: var(--radius); background: var(--warn-soft); color: var(--warn); }
.banner button { color: var(--warn); border-color: ${alpha(p.warn, 0.5)}; flex: none; }

.file { margin-bottom: var(--s6); }
.file-head { display: flex; align-items: center; gap: var(--s3); padding: 0 0 var(--s2); }
.file-head .path { font: 12.5px var(--code); color: var(--soft); overflow-wrap: anywhere; }
.file-head .path b { color: var(--text); font-weight: 500; }
.file-head .status { font-size: 11px; color: var(--dim); }
.file-head .status.added { color: var(--ok); }
.file-head .status.deleted { color: var(--danger); }
.file-head .note { color: var(--dim); font-size: 12px; }
.file-head .spacer { flex: 1; }
.file-head button { font-size: 11.5px; color: var(--dim); }

.code { font: 12.5px/1.65 var(--code); font-variant-ligatures: contextual; border-top: 1px solid var(--edge); border-bottom: 1px solid var(--edge); }
.row { display: grid; grid-template-columns: 44px 44px 18px minmax(0, 1fr) auto; position: relative; cursor: default; }
.row:hover { background: var(--hover); }
.row .no { color: var(--dim); text-align: right; padding-right: 10px; user-select: none; font-size: 11.5px; font-variant-numeric: tabular-nums; opacity: .75; }
.row .sign { user-select: none; text-align: center; color: var(--dim); }
.row .src { white-space: pre-wrap; overflow-wrap: anywhere; padding-right: var(--s4); tab-size: 4; padding-left: 6ch; text-indent: -6ch; }
.row .own { color: var(--dim); font-size: 10.5px; padding: 0 var(--s3); user-select: none; align-self: center; }
.row.add { background: var(--add-row); }
.row.add .sign { color: var(--ok); box-shadow: inset 2px 0 0 var(--ok); }
.row.add .no { color: var(--ok); }
.row.del { background: var(--del-row); }
.row.del .sign { color: var(--danger); box-shadow: inset 2px 0 0 var(--danger); }
.row.del .no { color: var(--danger); }
.row.other { opacity: .38; }
.row.other:hover { opacity: .7; }
.row.cursor { background: var(--cursor); }
.row.cursor .no { color: var(--accent); opacity: 1; }
.row .dot { position: absolute; left: 6px; top: 50%; width: 6px; height: 6px; margin-top: -3px; border-radius: 50%; background: var(--accent); }
.row .dot.concern { background: var(--warn); }
.row.add .w { background: var(--add-word); border-radius: 2px; }
.row.del .w { background: var(--del-word); border-radius: 2px; }
.gap { display: flex; align-items: center; gap: var(--s2); width: 100%; border: 0; border-radius: 0; padding: 3px 0 3px 88px; background: ${alpha(p.panel, 0.6)};
  color: var(--dim); font: 11px var(--chrome); justify-content: flex-start; }
.gap:hover:not(:disabled) { color: var(--accent); background: var(--panel); }

/* side by side: the old file on the left, the new one on the right */
.code.split .row.both { grid-template-columns: 44px 18px minmax(0, 1fr) 44px 18px minmax(0, 1fr); }
.code.split .row.both::after { content: ''; position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: var(--edge); }
.pair > :last-child { border-left: 1px solid var(--edge); }
.pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.code.split .row.half { grid-template-columns: 44px 18px minmax(0, 1fr) auto; }
.pair .empty { background: repeating-linear-gradient(135deg, transparent 0 6px, ${alpha(p.edge, 0.55)} 6px 7px); }
.code.split .gap { padding-left: 62px; }

.head-actions { display: flex; align-items: center; gap: var(--s3); flex: none; }
.layout { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--edge); border-radius: var(--radius); }
.layout button { border: 0; padding: 3px 8px; border-radius: 4px; color: var(--dim); }
.layout button:hover:not(:disabled) { background: var(--hover); }
.layout button.on { background: var(--edge); color: var(--text); }

.fold { margin-bottom: var(--s6); }
.fold > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: var(--s2); color: var(--soft); padding: var(--s2) 0; }
.fold > summary::-webkit-details-marker { display: none; }
.fold > summary svg { transition: transform .2s var(--ease); }
.fold[open] > summary svg { transform: rotate(90deg); }
.fold > summary .count { color: var(--dim); }
.fold > .file:first-of-type { margin-top: var(--s3); }

/* syntax, from the panel's roles */
.k { color: var(--branch); }
.s { color: var(--warn); }
.m { color: var(--warn); }
.f { color: var(--accent); }
.y { color: var(--ok); }
.c { color: var(--dim); font-style: italic; }
.p { color: var(--soft); }

/* building / error */
.wait { padding: var(--s6); max-width: 760px; }
.wait h1 { font: 600 20px/1.3 var(--code); margin: 0 0 var(--s2); }
.wait p { font: 14px/1.6 var(--prose); color: var(--soft); margin: 0 0 var(--s5); max-width: 62ch; }
.clock { font: 500 13px var(--code); color: var(--accent); font-variant-numeric: tabular-nums; }
.skeleton { display: grid; gap: 9px; margin-top: var(--s5); }
.skeleton span { height: 10px; border-radius: 3px; background: linear-gradient(90deg, var(--panel) 0%, var(--edge) 50%, var(--panel) 100%); background-size: 200% 100%; animation: shimmer 1.6s linear infinite; }
@keyframes shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.failure { font: 12.5px/1.6 var(--code); color: var(--danger); background: var(--danger-soft); border-radius: var(--radius); padding: var(--s4); white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 var(--s4); }

/* ── inspector ── */
.inspector { background: var(--panel); border-left: 1px solid var(--edge); display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.inspector-scroll { overflow-y: auto; flex: 1; }
.pane { padding: var(--s5) var(--s5) var(--s4); border-bottom: 1px solid var(--edge); }
.pane:last-child { border-bottom: 0; }
.pane h2 { font: 600 11.5px var(--chrome); color: var(--soft); margin: 0 0 var(--s3); display: flex; align-items: center; justify-content: space-between; gap: var(--s2); letter-spacing: .02em; }
.pane h2 .where { font-weight: 400; color: var(--soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.summary { font: 14px/1.6 var(--prose); color: var(--text); margin: 0; }
.muted { color: var(--dim); font: 13px/1.5 var(--prose); margin: 0; }
.pane h2 .count { font-weight: 400; color: var(--soft); font-variant-numeric: tabular-nums; }
/* the unchanged code a section leans on: folded, each a note and where it lives */
.ctx-list { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s1); }
.ctx > .head { display: grid; grid-template-columns: 14px minmax(0, 1fr) auto; align-items: start; gap: var(--s2); padding: var(--s2); margin: 0 calc(-1 * var(--s2)); border-radius: var(--radius); }
.ctx > summary { list-style: none; cursor: pointer; }
.ctx > summary::-webkit-details-marker { display: none; }
.ctx > summary:hover { background: var(--hover); }
/* centred on the note's first line: (13px × 1.45 − 14px) / 2 */
.ctx > .head > svg { margin-top: calc((13px * 1.45 - 14px) / 2); color: var(--dim); transition: transform .2s var(--ease); }
.ctx[open] > summary > svg { transform: rotate(90deg); }
.ctx .what { font: 13px/1.45 var(--prose); color: var(--text); overflow-wrap: anywhere; }
.ctx .what.code { font: 12.5px/1.5 var(--code); }
.ctx .at { display: block; font: 11.5px/1.5 var(--code); color: var(--soft); margin-top: 2px; overflow-wrap: anywhere; }
.ctx .gone { display: block; font-size: 11px; color: var(--warn); margin-top: 2px; }
.ctx .copy { padding: 3px; color: var(--dim); opacity: 0; transition: opacity .15s, color .15s; }
.ctx > summary:hover .copy, .ctx .copy:focus-visible { opacity: 1; }
.ctx .copy:hover:not(:disabled) { color: var(--text); }
/* too narrow to wrap code readably: it scrolls in its own box, numbers pinned, capped so the thread below stays in reach */
.snippet { font: 12px/1.6 var(--code); background: var(--bg); border-radius: var(--radius); padding: var(--s2) 0; margin: var(--s1) 0 var(--s2); max-height: 24em; overflow: auto; }
.snippet div { display: grid; grid-template-columns: 6ch max-content; }
.snippet .src { white-space: pre; padding-right: var(--s3); }
.snippet .no { position: sticky; left: 0; background: var(--bg); color: var(--dim); text-align: right; padding-right: 1ch; user-select: none; font-variant-numeric: tabular-nums; }
.ctx-more { margin-top: var(--s1); color: var(--dim); }

.thread { display: grid; gap: var(--s3); }
.thread.swap { animation: swap .18s var(--ease); }
@keyframes swap { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.comment { display: grid; gap: var(--s1); }
.comment .who { display: flex; align-items: center; gap: var(--s2); font-size: 11.5px; }
.comment .kind { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
.comment.question .kind { color: var(--accent); }
.comment.concern .kind { color: var(--warn); }
.comment .who .sent { color: var(--dim); display: inline-flex; align-items: center; gap: 4px; }
.comment .who .spacer { flex: 1; }
.comment .who button { font-size: 11px; color: var(--dim); }
.comment .body { font: 13.5px/1.55 var(--prose); white-space: pre-wrap; overflow-wrap: anywhere; }
.comment .quote { font: 11.5px/1.5 var(--code); color: var(--soft); background: var(--bg); border-radius: 4px; padding: 2px var(--s2); white-space: pre-wrap; overflow-wrap: anywhere; }
.answer { font: 13.5px/1.6 var(--prose); color: var(--soft); background: var(--bg); border-radius: var(--radius); padding: var(--s3); white-space: pre-wrap; overflow-wrap: anywhere; }
.answer.pending { display: flex; align-items: center; gap: var(--s2); color: var(--dim); }
.pulse { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .25; } }

.composer { display: grid; gap: var(--s2); margin-top: var(--s2); }
.kinds { display: grid; grid-template-columns: 1fr 1fr; background: var(--bg); border-radius: var(--radius); padding: 3px; gap: 3px; }
.kinds button { border: 0; justify-content: center; padding: 5px; border-radius: 4px; color: var(--dim); }
.kinds button.on.question { background: var(--accent-soft); color: var(--accent); }
.kinds button.on.concern { background: var(--warn-soft); color: var(--warn); }
.hint { font: 12px/1.45 var(--prose); color: var(--dim); }
textarea { font: 13.5px/1.55 var(--prose); width: 100%; min-height: 84px; background: var(--bg); color: var(--text); border: 1px solid var(--edge); border-radius: var(--radius);
  padding: var(--s2) var(--s3); resize: vertical; caret-color: var(--accent); transition: border-color .15s; }
textarea:focus { outline: none; border-color: var(--accent); }
textarea::placeholder { color: var(--dim); }
.composer .actions { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--s3); }
.composer .hint { flex: 1; min-width: 0; padding-top: 2px; }

.queue { border-top: 1px solid var(--edge); padding: var(--s4) var(--s5) var(--s5); display: grid; gap: var(--s3); background: var(--panel); }
.queue h2 { font: 600 11.5px var(--chrome); color: var(--soft); margin: 0; display: flex; justify-content: space-between; letter-spacing: .02em; }
.queue h2 b { color: var(--warn); font-weight: 600; }
.queue ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; max-height: 140px; overflow-y: auto; }
.queue li { display: grid; grid-template-columns: 1fr; padding: 5px var(--s2); margin: 0 calc(-1 * var(--s2)); border-radius: 4px; cursor: pointer; }
.queue li:hover { background: var(--hover); }
.queue li .loc { font: 11px var(--code); color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queue li .txt { font: 12.5px/1.4 var(--prose); color: var(--soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.toast { position: fixed; left: 50%; bottom: var(--s5); transform: translate(-50%, 12px); opacity: 0; pointer-events: none; background: var(--edge); color: var(--text);
  border-radius: var(--radius); padding: var(--s2) var(--s4); box-shadow: 0 8px 24px ${alpha('#000000', 0.35)}; transition: opacity .2s, transform .2s var(--ease); }
.toast.on { opacity: 1; transform: translate(-50%, 0); }

@media (max-width: 1280px) { .app { grid-template-columns: 224px minmax(0, 1fr) 320px; } .stage-head, .stage-body { padding-left: var(--s5); padding-right: var(--s5); } }
@media (max-width: 960px) {
  .app { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 1fr auto; height: auto; min-height: 100vh; }
  .stage-head { position: static; flex-wrap: wrap; }
  .row { grid-template-columns: 34px 34px 16px minmax(0, 1fr) auto; }
  .gap { padding-left: 68px; }
  .layout { display: none; }
  .rail { border-right: 0; border-bottom: 1px solid var(--edge); }
  .sections { display: flex; overflow-x: auto; }
  .sections li { min-width: 200px; }
  .legend { display: none; }
  .inspector { border-left: 0; border-top: 1px solid var(--edge); }
  .stage { overflow: visible; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;
}

const PAGE_SCRIPT = String.raw`
var base = location.pathname.replace(/\/$/, '');
var data = null;
var current = 0;
var cursor = null;        // { path, row } of the line under the cursor
var draftKind = 'question';
var draft = '';
var unfolded = {};        // path -> whole file shown
var opened = {};          // "path:a:b" -> gap expanded
var ctxOpen = {};         // "section:path:start" -> context ref unfolded
var ctxAll = {};          // section -> every context ref listed, not just the first few
var stale = false;
var lastThreadKey = '';
var layout = 'inline';    // 'inline' or 'split', remembered per browser
try { if (localStorage.getItem('fw-review-layout') === 'split') layout = 'split'; } catch (e) {}
// Side by side needs room; a narrow window always reads inline.
var narrow = matchMedia('(max-width: 960px)');
narrow.addEventListener('change', function () { if (data && data.sections) renderStage(); });
var TEST = /(_test\.go|\.test\.[jt]sx?|\.spec\.[jt]sx?|(^|\/)tests?\/|_test\.py|(^|\/)test_[^/]*\.py)$/;

/* ── dom ── */
function h(tag, attrs) {
  var el = document.createElement(tag);
  for (var k in attrs || {}) {
    var v = attrs[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k === 'class') el.className = v;
    else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
  return el;
}
function add(el, c) {
  if (c == null || c === false) return;
  if (Array.isArray(c)) c.forEach(function (x) { add(el, x); });
  else el.append(c);
}

var ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  done: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  todo: '<circle cx="12" cy="12" r="9"/>',
  now: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  expand: '<path d="M12 5v14M5 12h14"/>',
  branch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4-6 3-11 5.5"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><path d="M12 17h.01"/>',
  concern: '<path d="M4 21V4h11l-1.5 4L15 12H4"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7-7-1Z"/>',
  sent: '<path d="M20 6 9 17l-5-5"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  raise: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  inline: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 12h8M8 15h5"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/>'
};
function icon(name) {
  var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'i');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name];
  return s;
}

function api(method, path, body) {
  return fetch(base + '/' + path, {
    method: method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(function (r) { return r.json(); });
}

var toastTimer;
function toast(text) {
  var el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove('on'); }, 3600);
}

/* ── syntax ── */
var KW = {
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota',
  ts: 'abstract as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface keyof let new null of private protected public readonly return set static super switch this throw true try type typeof undefined var void while with yield',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self',
  proto: 'syntax package import option message enum service rpc returns repeated optional oneof map reserved stream true false',
  sql: 'select from where and or not insert into values update set delete create table alter add drop index on join left right inner outer group by order having limit offset as null is in exists primary key references default unique constraint begin commit returning case when then else end',
  sh: 'if then else elif fi for while do done case esac in function return export local echo exit',
  yaml: 'true false null yes no'
};
var KWSET = {};
for (var lang in KW) { KWSET[lang] = {}; KW[lang].split(' ').forEach(function (w) { KWSET[lang][w.toLowerCase()] = true; }); }

function langOf(path) {
  var ext = (path.split('.').pop() || '').toLowerCase();
  if (ext === 'go') return 'go';
  if (/^(ts|tsx|js|jsx|mjs|cjs|json)$/.test(ext)) return 'ts';
  if (ext === 'py') return 'py';
  if (ext === 'proto') return 'proto';
  if (ext === 'sql') return 'sql';
  if (/^(sh|bash|zsh)$/.test(ext)) return 'sh';
  if (/^(ya?ml|toml)$/.test(ext)) return 'yaml';
  return null;
}

var BQ = '\x60';
var TOKEN = new RegExp([
  '(\\/\\/.*$|\\/\\*.*?(?:\\*\\/|$)|--\\s.*$)',          // 1 comment (line or same-line block, SQL)
  '(#.*$)',                                               // 2 hash comment
  '("(?:[^"\\\\]|\\\\.)*"?|\'(?:[^\'\\\\]|\\\\.)*\'?|' + BQ + '[^' + BQ + ']*' + BQ + '?)', // 3 string
  '(\\b\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?\\b|\\b0x[0-9a-f]+\\b)', // 4 number
  '([A-Za-z_$][\\w$]*)',                                  // 5 identifier
  '([{}()\\[\\];,.:=<>!&|+\\-*/%^?]+)'                     // 6 punctuation
].join('|'), 'gi');

function tokens(text, lang) {
  if (!lang) return [{ t: text, c: '' }];
  var out = [];
  var last = 0;
  var hash = lang === 'py' || lang === 'sh' || lang === 'yaml';
  TOKEN.lastIndex = 0;
  var m;
  while ((m = TOKEN.exec(text))) {
    if (m.index > last) out.push({ t: text.slice(last, m.index), c: '' });
    // '#' and '-- ' only open a comment in the languages that have them;
    // elsewhere the mark is punctuation and the rest of the line is code.
    var stray = (m[2] && !hash) || (m[1] && m[1].slice(0, 2) === '--' && lang !== 'sql');
    if (stray) {
      var mark = m[2] ? '#' : '--';
      out.push({ t: mark, c: 'p' });
      TOKEN.lastIndex = m.index + mark.length;
      last = TOKEN.lastIndex;
      continue;
    }
    var c = '';
    if (m[1] || m[2]) c = 'c';
    else if (m[3]) c = 's';
    else if (m[4]) c = 'm';
    else if (m[5]) {
      var w = m[5];
      var next = /^\s*\(/.test(text.slice(TOKEN.lastIndex));
      if (KWSET[lang][lang === 'sql' ? w.toLowerCase() : w]) c = 'k';
      else if (next) c = 'f';
      else if (/^[A-Z]/.test(w) && lang !== 'sql') c = 'y';
    } else if (m[6]) c = 'p';
    out.push({ t: m[0], c: c });
    last = TOKEN.lastIndex;
    if (m[0].length === 0) TOKEN.lastIndex++;
  }
  if (last < text.length) out.push({ t: text.slice(last), c: '' });
  return out;
}

/** Paint a line: syntax tokens, with [a, b) marked as the changed words. */
function paint(text, lang, a, b) {
  var frag = document.createDocumentFragment();
  var pos = 0;
  tokens(text, lang).forEach(function (tok) {
    var start = pos, end = pos + tok.t.length;
    pos = end;
    var cuts = [start, end];
    if (a != null && a > start && a < end) cuts.push(a);
    if (b != null && b > start && b < end) cuts.push(b);
    cuts.sort(function (x, y) { return x - y; });
    for (var i = 0; i < cuts.length - 1; i++) {
      var s = cuts[i], e = cuts[i + 1];
      if (e <= s) continue;
      var piece = tok.t.slice(s - start, e - start);
      var cls = tok.c;
      if (a != null && s >= a && e <= b) cls = (cls ? cls + ' ' : '') + 'w';
      frag.append(cls ? h('span', { class: cls, text: piece }) : document.createTextNode(piece));
    }
  });
  return frag;
}

/**
 * Word-level change for a removed line and the added line that replaces it:
 * what lies between their common prefix and suffix. Only when that is a part
 * of the line — a rewritten line marks nothing rather than everything.
 */
var wordCache = {};
function wordDiff(path) {
  if (wordCache[path]) return wordCache[path];
  var rows = data.files[path].rows;
  var marks = {};
  var i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== '-') { i++; continue; }
    var d0 = i; while (i < rows.length && rows[i].kind === '-') i++;
    var a0 = i; while (i < rows.length && rows[i].kind === '+') i++;
    var dels = a0 - d0, adds = i - a0;
    // Paired line by line only when the block was replaced one for one;
    // otherwise index pairing marks lines that have nothing to do with each other.
    if (dels !== adds) continue;
    for (var k = 0; k < dels; k++) {
      var x = rows[d0 + k].text, y = rows[a0 + k].text;
      var p = 0; while (p < x.length && p < y.length && x[p] === y[p]) p++;
      var s = 0; while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
      var shared = p + s;
      if (shared < Math.max(x.length, y.length) * 0.4) continue;
      // A change that is only whitespace (a realigned column) marks nothing.
      if (!x.slice(p, x.length - s).trim() && !y.slice(p, y.length - s).trim()) continue;
      if (x.length - shared > 0) marks[d0 + k] = [p, x.length - s];
      if (y.length - shared > 0) marks[a0 + k] = [p, y.length - s];
    }
  }
  return (wordCache[path] = marks);
}

/* ── data ── */
function load(first) {
  return api('GET', 'data').then(function (d) {
    wordCache = {};
    // Tabs as four spaces, once: the hanging indent on wrapped lines moves tab
    // stops, and the word marks have to index the same text that is drawn.
    for (var path in d.files || {}) d.files[path].rows.forEach(function (r) { r.text = r.text.replace(/\t/g, '    '); });
    (d.sections || []).forEach(function (s) { s.refs.forEach(function (r) { r.lines = r.lines.map(function (l) { return l.replace(/\t/g, '    '); }); }); });
    data = d;
    document.title = 'Review · ' + (d.repo || '');
    if (first && d.sections) {
      // A §n in the address wins, so a reload stays put; else the first not yet reviewed.
      var asked = Number((location.hash.match(/^#(\d+)$/) || [])[1]) - 1;
      var open = d.sections.findIndex(function (_, i) { return d.checked.indexOf(i) < 0; });
      current = asked >= 0 && asked < d.sections.length ? asked : open < 0 ? 0 : open;
    }
    render();
    var busy = d.status === 'building' || (d.comments || []).some(function (c) { return c.asking; });
    if (busy) setTimeout(load, 2000);
  }).catch(function () { setTimeout(load, 4000); });
}

function checkStale() {
  if (!data || data.status !== 'ready') return;
  api('GET', 'stale').then(function (r) { if (r.stale !== stale) { stale = r.stale; renderStage(); } });
}

function regenerate() {
  api('POST', 'regenerate').then(function (r) { if (r.key) location.href = base.replace(/[^/]+$/, r.key); });
}

function section() { return data.sections[current]; }
function owner(path, row) { return data.files[path].owners[row]; }
function threadFor(path, row) {
  return data.comments.filter(function (c) {
    return c.section === current && (path ? c.path === path && c.row === row : !c.path);
  });
}
function rowLabel(path, row) {
  var r = data.files[path].rows[row];
  return path.split('/').pop() + ':' + (r.new != null ? r.new : r.old);
}

/* ── rail ── */
function renderRail() {
  var rail = document.getElementById('rail');
  rail.replaceChildren();
  rail.append(h('div', { class: 'rail-head' },
    h('div', { class: 'repo', text: data.repo || data.title }),
    h('div', { class: 'base' }, icon('branch'), h('span', {}, 'against '), h('span', { class: 'ref', text: data.base || '' }))));
  if (!data.sections) return;
  var done = data.checked.length, total = data.sections.length;
  rail.append(h('div', { class: 'progress' },
    h('div', { class: 'segments', 'aria-hidden': 'true' }, data.sections.map(function (_, i) {
      return h('span', { class: data.checked.indexOf(i) >= 0 ? 'done' : i === current ? 'current' : '' });
    })),
    h('div', { class: 'progress-label' }, h('b', { text: String(done) }), ' of ' + total + ' sections reviewed')));
  rail.append(h('ol', { class: 'sections' }, data.sections.map(function (s, i) {
    var isDone = data.checked.indexOf(i) >= 0;
    var tag = s.uncovered ? 'not placed by the recap' : s.mechanical ? 'mechanical' : null;
    return h('li', {
      class: [i === current ? 'current' : '', isDone ? 'done' : '', s.uncovered ? 'uncovered' : ''].join(' '),
      onclick: function () { go(i); },
      'aria-current': i === current ? 'step' : null,
    },
      h('span', { class: 'mark' }, icon(isDone ? 'done' : i === current ? 'now' : 'todo')),
      h('span', { class: 'n', text: '§' + (i + 1) }),
      h('span', {}, h('span', { class: 't', text: s.title }), tag ? h('span', { class: 'tag', text: tag }) : null));
  })));
  rail.append(h('div', { class: 'legend' },
    h('span', {}, h('kbd', { text: 'j' }), ' ', h('kbd', { text: 'k' })), h('span', { text: 'line' }),
    h('span', {}, h('kbd', { text: 'n' }), ' ', h('kbd', { text: 'p' })), h('span', { text: 'section' }),
    h('span', {}, h('kbd', { text: 'c' })), h('span', { text: 'comment on the line' }),
    h('span', {}, h('kbd', { text: 'x' })), h('span', { text: 'mark reviewed, go on' }),
    h('span', {}, h('kbd', { text: 's' })), h('span', { text: 'inline or side by side' })));
}

/* ── stage ── */
function renderStage() {
  var stage = document.getElementById('stage');
  var top = stage.scrollTop;
  stage.replaceChildren();
  if (data.status === 'building') return renderBuilding(stage);
  if (data.status === 'error') {
    stage.append(h('div', { class: 'wait' },
      h('h1', { text: 'The recap did not come through' }),
      h('p', { text: 'The agent that cuts the change into sections failed. Nothing is lost: your checkoffs and comments are kept with this snapshot. Run it again; if it keeps failing, the message below says why.' }),
      h('pre', { class: 'failure', text: data.error || 'unknown error' }),
      h('button', { class: 'primary', onclick: regenerate }, icon('refresh'), 'Run the recap again')));
    return;
  }
  var s = section();
  var isDone = data.checked.indexOf(current) >= 0;
  stage.append(h('header', { class: 'stage-head' },
    h('h1', {}, h('span', { class: 'n', text: '§' + (current + 1) }), h('span', { text: s.title }),
      s.mechanical ? h('span', { class: 'kind', text: 'mechanical' }) : null),
    h('div', { class: 'head-actions' },
      h('div', { class: 'layout', role: 'radiogroup', 'aria-label': 'Diff layout' }, [['inline', 'Inline'], ['split', 'Side by side']].map(function (o) {
        return h('button', {
          class: layout === o[0] ? 'on' : '', role: 'radio', 'aria-checked': layout === o[0] ? 'true' : 'false',
          title: o[1] + ' (s)', onclick: function () { setLayout(o[0]); },
        }, icon(o[0]), o[0] === 'split' ? 'Split' : 'Inline');
      })),
      h('button', { class: isDone ? 'done' : 'primary', onclick: toggleChecked },
        icon(isDone ? 'check' : 'done'), isDone ? 'Reviewed' : 'Mark reviewed', h('kbd', { text: 'x' })))));
  if (stale) {
    stage.append(h('div', { class: 'banner' },
      h('span', { text: 'The worktree has moved since this review was pinned. What you see is the earlier state.' }),
      h('button', { onclick: regenerate }, icon('refresh'), 'Review the new state')));
  }
  var body = h('div', { class: 'stage-body' });
  var code = s.files.filter(function (f) { return !TEST.test(f.path); });
  var tests = s.files.filter(function (f) { return TEST.test(f.path); });
  code.forEach(function (f) { body.append(fileEl(f)); });
  if (tests.length) {
    body.append(h('details', { class: 'fold' },
      h('summary', {}, icon('chevron'), 'Tests', h('span', { class: 'count', text: tests.length + ' file' + (tests.length > 1 ? 's' : '') })),
      tests.map(fileEl)));
  }
  stage.append(body);
  stage.scrollTop = top;
}

var clockTimer;
function renderBuilding(stage) {
  var clock = h('span', { class: 'clock' });
  var offset = (data.now || Date.now()) - Date.now();
  function tick() {
    var ms = Math.max(0, Date.now() + offset - (data.startedAt || Date.now()));
    var sec = Math.floor(ms / 1000);
    clock.textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  tick();
  clearInterval(clockTimer);
  clockTimer = setInterval(function () { if (!clock.isConnected) return clearInterval(clockTimer); tick(); }, 1000);
  var widths = [62, 48, 71, 35, 80, 54, 66, 41, 74, 58, 30, 69];
  stage.append(h('div', { class: 'wait' },
    h('h1', {}, 'Reading the change ', clock),
    h('p', { text: 'An agent is cutting the diff into sections that follow its logic. It usually takes one to three minutes; this page fills in on its own.' }),
    h('div', { class: 'skeleton', 'aria-hidden': 'true' }, widths.map(function (w) { return h('span', { style: 'width:' + w + '%' }); }))));
}

function fileEl(sf) {
  var file = data.files[sf.path];
  var rows = file.rows;
  var lang = langOf(sf.path);
  var marks = rows.length ? wordDiff(sf.path) : {};
  var whole = unfolded[sf.path];
  var windows = whole ? [[0, rows.length - 1]] : sf.windows;
  // An added or deleted file has only one side; split would leave half the page blank.
  var split = layout === 'split' && !narrow.matches && (file.status === 'modified' || file.status === 'renamed');
  var box = h('div', { class: split ? 'code split' : 'code' });
  var last = -1;
  function gap(from, to) {
    var key = sf.path + ':' + from + ':' + to;
    if (opened[key]) { span(from, to); return; }
    box.append(h('button', { class: 'gap', onclick: function () { opened[key] = true; renderStage(); } },
      icon('expand'), (to - from + 1) + ' unchanged line' + (to > from ? 's' : '')));
  }
  /** Row i; side draws only its old or new half, for side by side. */
  function rowEl(i, side) {
    var r = rows[i];
    var own = owner(sf.path, i);
    var cls = 'row' + (r.kind === '+' ? ' add' : r.kind === '-' ? ' del' : '');
    var foreign = r.kind !== ' ' && own !== current && own >= 0;
    if (foreign) cls += ' other';
    if (cursor && cursor.path === sf.path && cursor.row === i) cls += ' cursor';
    var thread = data.comments.filter(function (c) { return c.path === sf.path && c.row === i; });
    var m = marks[i];
    var sign = h('span', { class: 'sign', text: r.kind === ' ' ? '' : r.kind === '+' ? '+' : '−' });
    var src = h('span', { class: 'src' }, paint(r.text, lang, m ? m[0] : null, m ? m[1] : null));
    var cells;
    if (!split) cells = [h('span', { class: 'no', text: r.old == null ? '' : r.old }), h('span', { class: 'no', text: r.new == null ? '' : r.new }), sign, src];
    else if (side) cells = [h('span', { class: 'no', text: side === 'old' ? r.old : r.new }), sign, src];
    // A kept line is the same text on both sides, so one row holds both.
    else cells = [h('span', { class: 'no', text: r.old }), h('span', { class: 'sign' }), src,
      h('span', { class: 'no', text: r.new }), h('span', { class: 'sign' }), h('span', { class: 'src' }, paint(r.text, lang))];
    if (split) cls += side ? ' half' : ' both';
    return h('div', { class: cls, 'data-path': sf.path, 'data-row': i, onclick: function () { setCursor(sf.path, i, false); } },
      thread.length ? h('span', { class: 'dot' + (thread.some(function (c) { return c.kind === 'concern'; }) ? ' concern' : '') }) : null,
      cells,
      split && !side ? null : foreign ? h('span', { class: 'own', text: '§' + (own + 1) }) : h('span'));
  }
  /** Rows a..b. Side by side, each run of removed lines faces the added run after it, line for line. */
  function span(a, b) {
    if (!split) { for (var i = a; i <= b; i++) box.append(rowEl(i)); return; }
    var j = a;
    while (j <= b) {
      if (rows[j].kind === ' ') { box.append(rowEl(j++)); continue; }
      var dels = [], adds = [];
      while (j <= b && rows[j].kind === '-') dels.push(j++);
      while (j <= b && rows[j].kind === '+') adds.push(j++);
      for (var k = 0; k < Math.max(dels.length, adds.length); k++) {
        box.append(h('div', { class: 'pair' },
          k < dels.length ? rowEl(dels[k], 'old') : h('div', { class: 'empty', 'aria-hidden': 'true' }),
          k < adds.length ? rowEl(adds[k], 'new') : h('div', { class: 'empty', 'aria-hidden': 'true' })));
      }
    }
  }
  windows.forEach(function (w) {
    if (w[0] > last + 1) gap(last + 1, w[0] - 1);
    span(w[0], w[1]);
    last = w[1];
  });
  if (rows.length && last < rows.length - 1) gap(last + 1, rows.length - 1);

  var parts = sf.path.split('/');
  var name = parts.pop();
  var dir = parts.length ? parts.join('/') + '/' : '';
  var renamed = file.oldPath && file.oldPath !== sf.path;
  return h('section', { class: 'file' },
    h('div', { class: 'file-head' },
      h('span', { class: 'path' }, renamed ? file.oldPath + ' → ' : '', dir, h('b', { text: name })),
      file.status !== 'modified' ? h('span', { class: 'status ' + file.status, text: file.status }) : null,
      sf.note ? h('span', { class: 'note', text: sf.note }) : null,
      h('span', { class: 'spacer' }),
      rows.length ? h('button', { class: 'ghost', onclick: function () { unfolded[sf.path] = !whole; renderStage(); } }, whole ? 'Only this section' : 'Whole file') : null),
    rows.length ? box : null);
}

/* ── inspector ── */
function renderInspector() {
  var insp = document.getElementById('inspector');
  insp.replaceChildren();
  if (data.status !== 'ready') {
    insp.append(h('div', { class: 'inspector-scroll' }, h('div', { class: 'pane' },
      h('h2', { text: 'Inspector' }),
      h('p', { class: 'muted', text: 'The section summary, the code it leans on and your comments will show here.' }))));
    return;
  }
  var s = section();
  var scroll = h('div', { class: 'inspector-scroll' });

  scroll.append(h('div', { class: 'pane' }, h('h2', { text: 'What this section does' }),
    s.summary ? h('p', { class: 'summary', text: s.summary }) : h('p', { class: 'muted', text: 'No summary for this section.' })));

  if (s.refs.length) {
    // A long list would push the thread, which follows the cursor, out of sight.
    var shown = ctxAll[current] || s.refs.length <= CTX_SHOWN + 1 ? s.refs : s.refs.slice(0, CTX_SHOWN);
    scroll.append(h('div', { class: 'pane' }, h('h2', {}, 'Context it leans on', h('span', { class: 'count', text: String(s.refs.length) })),
      h('div', { class: 'ctx-list' }, shown.map(ctxEl)),
      shown.length < s.refs.length ? h('button', { class: 'ghost ctx-more', onclick: function () { ctxAll[current] = true; renderInspector(); } },
        icon('expand'), (s.refs.length - shown.length) + ' more') : null));
  }

  scroll.append(threadPane());
  insp.append(scroll);
  insp.append(queueEl());
}

/** The line under the cursor and its thread: the one pane a cursor move redraws. */
function threadPane() {
  var focused = document.activeElement && document.activeElement.tagName === 'TEXTAREA';
  var on = cursor && data.files[cursor.path] ? cursor : null;
  var thread = on ? threadFor(on.path, on.row) : threadFor(null);
  var key = on ? on.path + ':' + on.row : 'section:' + current;
  var list = h('div', { class: 'thread' + (key !== lastThreadKey ? ' swap' : '') }, thread.map(commentEl));
  lastThreadKey = key;
  var quote = on ? data.files[on.path].rows[on.row] : null;
  return h('div', { class: 'pane', id: 'thread-pane' },
    h('h2', {}, on ? 'On this line' : 'On this section', on ? h('span', { class: 'where', text: rowLabel(on.path, on.row) }) : null),
    quote && !thread.length ? h('div', { class: 'comment' }, h('div', { class: 'quote', text: quote.text.trim() || ' ' })) : null,
    list,
    composerEl(on, focused));
}

var CTX_SHOWN = 5;
function ctxEl(ref) {
  var lang = langOf(ref.path);
  var key = current + ':' + ref.path + ':' + ref.start;
  var gone = !ref.lines.length;
  // The range the snapshot has: a ref past the end of its file comes back short.
  var at = ref.path + ':' + ref.start + (gone ? '' : '-' + (ref.start + ref.lines.length - 1));
  var copy = h('button', {
    class: 'ghost copy', title: 'Copy ' + ref.path + ':' + ref.start, 'aria-label': 'Copy ' + ref.path + ':' + ref.start,
    onclick: function (e) {
      // Inside the summary: copying must not fold or unfold the ref.
      e.preventDefault(); e.stopPropagation();
      navigator.clipboard.writeText(ref.path + ':' + ref.start).then(function () { toast('Copied ' + ref.path + ':' + ref.start); }, function () {});
    },
  }, icon('copy'));
  var label = h('span', {},
    // A bare name ("transferDestination", "Order.Total()") is code, and set as code.
    h('span', { class: /^[\w$.]+(\(\))?$/.test(ref.note) ? 'what code' : 'what', text: ref.note }),
    h('span', { class: 'at', text: at }),
    gone ? h('span', { class: 'gone', text: 'not in this snapshot' }) : null);
  // Nothing to unfold: a plain row, not a fold that opens onto nothing.
  if (gone) return h('div', { class: 'ctx' }, h('div', { class: 'head' }, h('span'), label));
  return h('details', { class: 'ctx', open: !!ctxOpen[key], ontoggle: function (e) { ctxOpen[key] = e.target.open; } },
    h('summary', { class: 'head' }, icon('chevron'), label, copy),
    h('div', { class: 'snippet' }, ref.lines.map(function (text, i) {
      return h('div', {}, h('span', { class: 'no', text: ref.start + i }), h('span', { class: 'src' }, paint(text, lang)));
    })));
}

function commentEl(c) {
  var answer = null;
  if (c.kind === 'question') {
    answer = c.asking
      ? h('div', { class: 'answer pending' }, h('span', { class: 'pulse' }), 'Reading the code to answer…')
      : c.answer ? h('div', { class: 'answer', text: c.answer }) : null;
  }
  return h('div', { class: 'comment ' + c.kind },
    h('div', { class: 'who' },
      h('span', { class: 'kind' }, icon(c.kind), c.kind === 'question' ? 'Question' : 'Concern'),
      c.sent ? h('span', { class: 'sent' }, icon('sent'), 'sent') : null,
      h('span', { class: 'spacer' }),
      c.kind === 'question' && !c.asking ? h('button', { class: 'ghost', title: 'Still unsure: make it a concern for the author', onclick: function () { api('POST', 'comments/' + c.id).then(function () { load(); }); } }, icon('raise'), 'Raise as concern') : null,
      h('button', { class: 'ghost', 'aria-label': 'Delete', title: 'Delete', onclick: function () { api('DELETE', 'comments/' + c.id).then(function () { load(); }); } }, icon('trash'))),
    h('div', { class: 'body', text: c.body }),
    answer);
}

function composerEl(on, refocus) {
  var area = h('textarea', {
    id: 'composer',
    'aria-label': draftKind === 'question' ? 'Question' : 'Concern',
    placeholder: draftKind === 'question' ? 'What do you want to understand?' : 'What should change?',
  });
  area.value = draft;
  area.addEventListener('input', function () { draft = area.value; });
  function submit() {
    var text = area.value.trim();
    if (!text) return;
    var body = { section: current, kind: draftKind, body: text };
    if (on) { body.path = on.path; body.row = on.row; }
    draft = '';
    api('POST', 'comments', body).then(function () { load(); });
  }
  area.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { area.blur(); }
    e.stopPropagation();
  });
  if (refocus) setTimeout(function () { area.focus(); area.setSelectionRange(area.value.length, area.value.length); });
  var kinds = h('div', { class: 'kinds', role: 'radiogroup', 'aria-label': 'Kind' }, ['question', 'concern'].map(function (k) {
    return h('button', {
      class: k + (draftKind === k ? ' on' : ''), role: 'radio', 'aria-checked': draftKind === k ? 'true' : 'false',
      onclick: function () { draftKind = k; renderInspector(); var a = document.getElementById('composer'); if (a) a.focus(); },
    }, icon(k), k === 'question' ? 'Question' : 'Concern');
  }));
  var hint = draftKind === 'question'
    ? 'Answered here by the agent, citing the code. Never sent to the author.'
    : 'Something to fix. Queued below and sent to the author together.';
  return h('div', { class: 'composer' }, kinds, area,
    h('div', { class: 'actions' }, h('span', { class: 'hint', text: hint }),
      h('button', { class: 'primary', onclick: submit }, draftKind === 'question' ? 'Ask' : 'Add', h('kbd', { text: '⌘↵' }))));
}

function queueEl() {
  var pending = data.comments.filter(function (c) { return c.kind === 'concern' && !c.sent; });
  var box = h('div', { class: 'queue' },
    h('h2', {}, h('span', { text: 'Concerns to send' }), h('b', { text: String(pending.length) })));
  if (pending.length) {
    box.append(h('ol', {}, pending.map(function (c) {
      var where = c.path ? rowLabel(c.path, c.row) : '§' + (c.section + 1);
      return h('li', { onclick: function () { if (c.section !== current) go(c.section); if (c.path) setCursor(c.path, c.row, true); } },
        h('span', { class: 'loc', text: '§' + (c.section + 1) + ' · ' + where }),
        h('span', { class: 'txt', text: c.body }));
    })));
  }
  box.append(h('button', { class: 'send', disabled: !pending.length, onclick: send }, icon('send'),
    pending.length ? 'Send ' + pending.length + ' concern' + (pending.length > 1 ? 's' : '') + ' to the author' : 'Nothing to send yet'));
  return box;
}

/* ── behaviour ── */
function render() {
  if (!data) return;
  renderRail();
  renderStage();
  renderInspector();
}

/** Rows in reading order: side by side puts a removed run's lines before the added ones, though they sit level. */
function visibleRows() {
  var out = [];
  document.querySelectorAll('#stage .code').forEach(function (box) {
    if (!box.offsetParent) return;
    out = out.concat(Array.prototype.slice.call(box.querySelectorAll('.row')).sort(function (a, b) { return a.dataset.row - b.dataset.row; }));
  });
  return out;
}

function setLayout(next) {
  if (next === layout) return;
  layout = next;
  try { localStorage.setItem('fw-review-layout', layout); } catch (e) {}
  renderStage();
  var el = document.querySelector('#stage .row.cursor');
  if (el) el.scrollIntoView({ block: 'center' });
}

function setCursor(path, row, scroll) {
  cursor = { path: path, row: row };
  document.querySelectorAll('#stage .row.cursor').forEach(function (el) { el.classList.remove('cursor'); });
  var el = document.querySelector('#stage .row[data-path="' + CSS.escape(path) + '"][data-row="' + row + '"]');
  if (el) {
    el.classList.add('cursor');
    if (scroll) el.scrollIntoView({ block: 'nearest' });
  }
  // Only the thread follows the cursor: redrawing the rest would fold the
  // context refs and drop the focus the reader left there.
  var pane = document.getElementById('thread-pane');
  if (pane) pane.replaceWith(threadPane());
  else renderInspector();
}

function moveCursor(step) {
  var rows = visibleRows();
  if (!rows.length) return;
  var at = cursor ? rows.findIndex(function (el) { return el.dataset.path === cursor.path && Number(el.dataset.row) === cursor.row; }) : -1;
  var next;
  if (at < 0) next = step > 0 ? 0 : rows.length - 1;
  else next = Math.max(0, Math.min(rows.length - 1, at + step));
  setCursor(rows[next].dataset.path, Number(rows[next].dataset.row), true);
}

function go(i) {
  if (!data.sections || i < 0 || i >= data.sections.length) return;
  current = i; cursor = null;
  history.replaceState(null, '', '#' + (i + 1));
  render();
  document.getElementById('stage').scrollTop = 0;
}

function toggleChecked() {
  var on = data.checked.indexOf(current) < 0;
  api('POST', 'check', { section: current, checked: on }).then(function (r) {
    data.checked = r.checked;
    if (on) {
      var next = data.sections.findIndex(function (_, i) { return i > current && data.checked.indexOf(i) < 0; });
      if (next < 0) next = data.sections.findIndex(function (_, i) { return data.checked.indexOf(i) < 0; });
      if (next >= 0) { toast('§' + (current + 1) + ' reviewed'); return go(next); }
      toast('Every section reviewed');
    }
    render();
  });
}

function send() {
  api('POST', 'send').then(function (r) {
    if (r.clipboard) navigator.clipboard.writeText(r.clipboard).catch(function () {});
    toast(r.detail);
    load();
  });
}

document.addEventListener('keydown', function (e) {
  if (!data || !data.sections || e.metaKey || e.ctrlKey || e.altKey) return;
  var tag = e.target.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT') return;
  if (e.key === 'j') moveCursor(1);
  else if (e.key === 'k') moveCursor(-1);
  else if (e.key === 'n') go(current + 1);
  else if (e.key === 'p') go(current - 1);
  else if (e.key === 'x') toggleChecked();
  else if (e.key === 's') setLayout(layout === 'split' ? 'inline' : 'split');
  else if (e.key === 'c') { var a = document.getElementById('composer'); if (a) a.focus(); }
  else if (e.key === 'Escape') { cursor = null; render(); }
  else return;
  e.preventDefault();
});

load(true);
setInterval(checkStale, 30000);
`;
