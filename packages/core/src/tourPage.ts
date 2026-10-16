import type { Palette } from './theme.ts';
import { PLAIN } from './tourSyntax.ts';

/** GitHub Dark default (Primer): the review reads like a pull request on github.com, whatever the panel's theme. */
const GITHUB_DARK: Palette = {
  bg: '#0d1117', panel: '#151b23', edge: '#3d444d', dim: '#9198a1', soft: '#9198a1', text: '#f0f6fc',
  danger: '#f85149', warn: '#d29922', ok: '#3fb950', accent: '#4493f8', branch: '#ab7df8',
};

const alpha = (hex: string, a: number): string =>
  `${hex}${Math.round(a * 255)
    .toString(16)
    .padStart(2, '0')}`;

/**
 * The review page: one HTML document, its script and style inline.
 *
 * Code first. A slim § strip on the left says where you are and what is left,
 * and opens onto the full list (l); the centre is the section — its summary
 * and the unchanged code it leans on, then its code at the full width; the
 * thread drawer on the right opens only when there is a conversation to have
 * (c, a line with a thread, t) and follows the cursor while it is open.
 *
 * It reads everything from `./data` and writes through the routes beside it
 * (see `tour.ts`), so there is no build step and nothing to serve but this.
 * The script is plain ES with no template literals, so it sits in this one
 * without escaping.
 */
export function tourPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review</title>
<style>
${pageCss(GITHUB_DARK)}
</style>
</head>
<body>
<div class="app">
  <nav class="rail" id="rail" aria-label="Sections"></nav>
  <main class="stage" id="stage"></main>
  <aside class="drawer" id="drawer" aria-label="Thread"></aside>
  <div class="grip" id="grip" role="separator" aria-orientation="vertical" aria-controls="drawer" aria-label="Thread drawer width" tabindex="0" title="Drag to resize · double-click to reset · w to widen"></div>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<div class="tip" id="tip" aria-hidden="true"></div>
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
  /* GitHub dark's diff tints; the number cell and word marks sit on the line's tint */
  --add-row: ${alpha('#3fb950', 0.15)}; --add-num: ${alpha('#3fb950', 0.25)}; --add-word: ${alpha('#2ea043', 0.4)};
  --del-row: ${alpha('#f85149', 0.15)}; --del-num: ${alpha('#f85149', 0.25)}; --del-word: ${alpha('#f85149', 0.4)};
  --hunk-row: ${alpha('#388bfd', 0.1)}; --hunk-num: #0c2d6b;
  --cursor: ${alpha('#bb8009', 0.15)}; --hover: ${alpha(p.text, 0.035)};
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
button.send { color: var(--bg); background: var(--warn); border-color: var(--warn); font-weight: 600; }
button.send:hover:not(:disabled) { color: var(--bg); background: ${alpha(p.warn, 0.88)}; }
button.send:disabled { background: transparent; border-color: var(--edge); color: var(--soft); opacity: 1; font-weight: 400; }
kbd { font: 11px var(--chrome); color: var(--dim); border: 1px solid var(--edge); border-bottom-width: 2px; border-radius: 4px; padding: 0 5px; min-width: 18px; text-align: center; display: inline-block; }
button kbd { border-color: currentColor; opacity: .7; color: inherit; }

/* the code takes every pixel the strip leaves; the drawer takes its share only while it is open */
.app { --strip-w: 56px; --drawer-w: 400px; position: relative; overflow-x: clip; display: grid; grid-template-columns: var(--strip-w) minmax(0, 1fr); height: 100vh; }
.app.drawer-open { grid-template-columns: var(--strip-w) minmax(0, 1fr) var(--drawer-w); }
.app:not(.drawer-open) .drawer, .app:not(.drawer-open) .grip { display: none; }

/* ── rail: a strip of §s, and the full list over the code ── */
.rail { position: relative; z-index: 10; background: var(--panel); border-right: 1px solid var(--edge); min-height: 0; min-width: 0; }
.strip { display: flex; flex-direction: column; align-items: center; height: 100%; padding: var(--s3) 0; gap: var(--s2); }
.strip ol { list-style: none; margin: 0; padding: 0 var(--s1); display: grid; gap: 2px; overflow-y: auto; flex: 1; align-content: start; width: 100%; scrollbar-width: none; }
.strip ol::-webkit-scrollbar { display: none; }
.strip ol button { width: 100%; height: 30px; justify-content: center; gap: 3px; padding: 0; border: 0; color: var(--dim); font-variant-numeric: tabular-nums; font-size: 11.5px; }
.strip ol button:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.strip ol button.done, .strip ol button.added { color: var(--ok); }
.strip ol button.deleted { color: var(--danger); }
.strip ol button.current { background: var(--accent-soft); color: var(--accent); }
.strip ol button svg.i { width: 12px; height: 12px; }
.strip .toggle { padding: 6px; color: var(--soft); }
.strip .count { font-size: 11px; color: var(--dim); font-variant-numeric: tabular-nums; }
.strip .count b { color: var(--text); font-weight: 600; }
.tip { position: fixed; z-index: 20; max-width: 340px; padding: 5px var(--s2); border-radius: var(--radius); background: var(--edge); color: var(--text); font: 12px/1.4 var(--chrome);
  box-shadow: 0 6px 18px ${alpha('#000000', 0.35)}; pointer-events: none; opacity: 0; transform: translate(-4px, -50%); transition: opacity .12s, transform .12s var(--ease); }
.tip.on { opacity: 1; transform: translate(0, -50%); }
.rail-panel { position: absolute; top: 0; bottom: 0; left: 0; width: 320px; background: var(--panel); border-right: 1px solid var(--edge); display: flex; flex-direction: column;
  box-shadow: 12px 0 32px ${alpha('#000000', 0.4)}; visibility: hidden; opacity: 0; transform: translateX(-12px); transition: opacity .16s, transform .22s var(--ease), visibility 0s .22s; }
.rail.open .rail-panel { visibility: visible; opacity: 1; transform: none; transition: opacity .16s, transform .22s var(--ease); }
/* pinned: the list docks beside the code instead of the strip, as GitHub's file tree does */
@media (min-width: 961px) {
  .app.pinned { --strip-w: 300px; }
  .app.pinned .strip { display: none; }
  .app.pinned .rail, .app.pinned .rail-panel { background: var(--bg); }
  .app.pinned .rail-panel { position: static; height: 100%; width: auto; border-right: 0; box-shadow: none; transition: none; }
}
.rail-head { position: relative; padding: var(--s5) var(--s6) var(--s4) var(--s4); }
.rail-head .pin { position: absolute; top: var(--s4); right: var(--s3); color: var(--soft); }
.rail-head .pin[aria-pressed="true"] { color: var(--accent); }
.tree-filter { position: relative; margin: var(--s3) var(--s3) var(--s1); }
.tree-filter svg.i { position: absolute; left: 9px; top: 50%; margin-top: -8px; width: 16px; height: 16px; color: var(--soft); }
.tree-filter input { width: 100%; height: 32px; font: 14px var(--prose); color: var(--text); background: var(--bg); border: 1px solid var(--edge); border-radius: var(--radius); padding: 0 8px 0 32px; }
.tree-filter input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
.tree { list-style: none; margin: 0; padding: var(--s1) var(--s2) var(--s4); overflow-y: auto; flex: 1; font: 14px/20px var(--prose); -webkit-font-smoothing: auto; }
.tree svg.i { width: 16px; height: 16px; }
.tree ul { list-style: none; margin: 0; padding: 0; }
.tree .node { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px var(--s2) 6px calc(var(--s2) + var(--depth) * 8px); border: 0; border-radius: var(--radius);
  color: var(--text); text-align: left; white-space: nowrap; }
.tree .node:hover:not(:disabled) { background: var(--hover); border-color: transparent; }
.tree .node.current { background: var(--accent-soft); }
.tree .node .name { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.tree .node .chev, .tree .node .fi, .tree .node .dir { display: inline-flex; flex: none; }
.tree .node .chev { width: 16px; height: 16px; justify-content: center; }
.tree .node .chev { color: var(--soft); transition: transform .15s var(--ease); }
.tree .node[aria-expanded="true"] .chev { transform: rotate(90deg); }
.tree .node .dir { color: var(--soft); }
.tree .node .dir svg.i { fill: currentColor; stroke: none; }
.tree .node .fi { color: var(--soft); }
.tree .node.added .fi { color: var(--ok); }
.tree .node.deleted .fi { color: var(--danger); }
.tree .node.renamed .fi { color: var(--warn); }
.tree .node .talk { display: inline-flex; align-items: center; gap: 3px; color: var(--soft); font-size: 12px; }
.tree .none { color: var(--soft); padding: var(--s2) var(--s3); }
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
.sections li { display: grid; grid-template-columns: 16px 22px minmax(0, 1fr); gap: 6px; align-items: start; padding: 7px var(--s2); border-radius: var(--radius); cursor: pointer; color: var(--soft); transition: background .15s; }
.sections li:hover { background: var(--hover); }
.sections li.current { background: var(--accent-soft); color: var(--text); }
.sections li .mark { color: var(--dim); margin-top: 2px; }
.sections li.done .mark { color: var(--ok); }
.sections li.current .mark { color: var(--accent); }
.sections li .n { color: var(--dim); font-variant-numeric: tabular-nums; }
.sections li.current .n { color: var(--accent); }
.sections li .t { line-height: 1.45; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.sections li.done:not(.current) .t { color: var(--dim); }
.sections li .tag { display: block; color: var(--dim); font-size: 11px; margin-top: 1px; }
.sections li.uncovered .tag { color: var(--warn); }
.sections li.added .n { color: var(--ok); }
.sections li.deleted .n { color: var(--danger); }
.scope { margin-top: var(--s3); }
.scope + .scope { margin-top: var(--s2); }
.legend { border-top: 1px solid var(--edge); padding: var(--s3) var(--s4); color: var(--dim); font-size: 11.5px; display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; }

/* ── stage ── */
.stage { overflow-y: auto; min-width: 0; scroll-padding-top: 96px; }
.stage-head { position: sticky; top: 0; z-index: 3; background: ${alpha(p.bg, 0.92)}; backdrop-filter: blur(8px);
  display: flex; align-items: center; justify-content: space-between; gap: var(--s5); padding: var(--s5) var(--s6) var(--s4); border-bottom: 1px solid var(--edge); }
.stage-head h1 { margin: 0; font: 600 20px/1.3 var(--code); letter-spacing: -0.01em; text-wrap: balance; display: flex; gap: var(--s3); align-items: baseline; }
.stage-head h1 .n { color: var(--accent); font-weight: 500; font-variant-numeric: tabular-nums; }
.stage-head h1 .kind { font: 400 12px var(--chrome); color: var(--dim); white-space: nowrap; }
.stage-body { padding: var(--s5) var(--s6) 160px; }
/* what the section does, read once before its code */
.lede { display: grid; gap: var(--s3); justify-items: start; margin: 0 0 var(--s6); }
.lede .summary { max-width: 110ch; font-size: 16px; line-height: 1.6; }
.overview-total { display: flex; align-items: center; gap: var(--s3); color: var(--soft); margin: 0 0 var(--s4); }
.areas { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s4); max-width: 110ch; }
.area { border: 1px solid var(--edge); border-radius: var(--radius); padding: var(--s4); }
.area h2 { margin: 0 0 var(--s2); font: 600 14px/1.4 var(--prose); }
.area-files { list-style: none; margin: var(--s3) 0 0; padding: 0; display: grid; gap: 2px; }
.area-files button { display: flex; align-items: center; gap: var(--s3); width: 100%; text-align: left; padding: 3px 6px; margin-left: -6px; }
.area-files .path { font: 12px var(--code); color: var(--text); overflow-wrap: anywhere; flex: 1; min-width: 0; }
.area-files .own { color: var(--accent); font-variant-numeric: tabular-nums; }
.lede-tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2) var(--s4); }
.leans { width: 100%; }
.leans > summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: var(--s2); color: var(--soft); padding: 3px 6px; margin-left: -6px; border-radius: var(--radius); }
.leans > summary:hover { background: var(--hover); color: var(--text); }
.leans > summary::-webkit-details-marker { display: none; }
.leans > summary svg { transition: transform .2s var(--ease); }
.leans[open] > summary svg { transform: rotate(90deg); }
.leans > summary .count { color: var(--dim); }
.leans .ctx-list { margin-top: var(--s2); max-width: 1100px; }
.lede-tools button { color: var(--soft); }
.queued { color: var(--warn); border-color: ${alpha(p.warn, 0.4)}; }
.queued:hover:not(:disabled) { color: var(--warn); border-color: var(--warn); }
.banner { display: flex; align-items: center; justify-content: space-between; gap: var(--s4); margin: var(--s4) var(--s6) 0; padding: var(--s3) var(--s4);
  border-radius: var(--radius); background: var(--warn-soft); color: var(--warn); }
.banner button { color: var(--warn); border-color: ${alpha(p.warn, 0.5)}; flex: none; }

/* GitHub's diff: its file card, mono stack, 12px/20px and 50px gutters */
.file { margin-bottom: var(--s5); border: 1px solid var(--edge); border-radius: var(--radius); overflow: clip; }
.file-head { position: sticky; top: var(--head-h, 0); z-index: 2; display: flex; align-items: center; gap: var(--s2); padding: 4px var(--s2); background: var(--panel); min-height: 40px; }
.file-head svg.i { width: 16px; height: 16px; }
.file-head:not(:last-child) { border-bottom: 1px solid var(--edge); }
.file-head .fold-toggle svg { transition: transform .15s var(--ease); }
.file-head .fold-toggle[aria-expanded="true"] svg { transform: rotate(90deg); }
.stats { display: inline-flex; align-items: center; gap: 4px; font: 600 12px var(--chrome); }
.stats .plus { color: var(--ok); }
.stats .minus { color: var(--danger); }
.stats .boxes { display: inline-flex; gap: 1px; margin-left: 2px; }
.stats .boxes i { width: 8px; height: 8px; border-radius: 2px; background: var(--edge); }
.stats .boxes i.a { background: var(--ok); }
.stats .boxes i.d { background: var(--danger); }
.viewed { display: inline-flex; align-items: center; gap: 6px; font: 500 12px var(--prose); color: var(--text); background: #212830; border: 1px solid var(--edge);
  border-radius: var(--radius); padding: 3px 8px; cursor: pointer; user-select: none; }
.viewed:hover { background: #262c36; }
.viewed.on { background: var(--accent-soft); border-color: rgba(56, 139, 253, 0.4); }
.viewed input { margin: 0; accent-color: var(--accent); }
.viewed-count { font: 12px var(--prose); color: var(--soft); white-space: nowrap; }
.viewed-count b { color: var(--text); font-weight: 600; }
.file-head .path { font: 12px var(--chrome); color: var(--text); overflow-wrap: anywhere; }
.file-head .path b { font-weight: 400; }
.file-head .status { font-size: 11px; color: var(--dim); }
.file-head .status.added { color: var(--ok); }
.file-head .status.deleted { color: var(--danger); }
.file-head .note { color: var(--dim); font-size: 12px; }
.file-head .spacer { flex: 1; }
.file-head button { font-size: 11.5px; color: var(--dim); }

.code { font: 12px/20px var(--chrome); -webkit-font-smoothing: auto; }
.row { display: grid; grid-template-columns: 44px 44px 18px minmax(0, 1fr) auto; position: relative; cursor: default; }
.row:hover { background: var(--hover); }
.row .no { color: var(--dim); text-align: center; padding: 0 8px; user-select: none; font-variant-numeric: tabular-nums; }
.row .sign { user-select: none; padding-left: 6px; color: var(--text); }
.row .src { white-space: pre-wrap; overflow-wrap: anywhere; padding-right: 10px; tab-size: 4; }
.row .own { color: var(--dim); font-size: 10.5px; padding: 0 var(--s3); user-select: none; align-self: center; }
.row.add { background: var(--add-row); }
.row.add .no { background: var(--add-num); color: var(--text); }
.row.del { background: var(--del-row); }
.row.del .no { background: var(--del-num); color: var(--text); }
.row.other { opacity: .38; }
.row.other:hover { opacity: .7; }
.row.cursor { background: var(--cursor); }
.row.cursor .no { color: var(--accent); opacity: 1; }
.row .dot { position: absolute; left: 6px; top: 50%; width: 6px; height: 6px; margin-top: -3px; border-radius: 50%; background: var(--accent); }
.row .dot.concern { background: var(--warn); }
.row.add .w { background: var(--add-word); border-radius: 2px; }
.row.del .w { background: var(--del-word); border-radius: 2px; }
.gap { display: flex; align-items: stretch; gap: 0; width: 100%; border: 0; border-radius: 0; padding: 0; background: var(--hunk-row);
  color: var(--dim); font: 12px/20px var(--chrome); text-align: left; }
.gap .gx { flex: none; width: 88px; display: flex; align-items: center; justify-content: center; background: var(--hunk-num); }
.gap .hd:empty { padding: 1px 0; }
.gap .hd { padding: 4px 10px 4px 18px; white-space: pre-wrap; overflow-wrap: anywhere; }
button.gap:hover:not(:disabled) { color: var(--text); background: var(--hunk-row); }
button.gap:hover .gx { background: #1f6feb; color: #ffffff; }

/* side by side: the old file on the left, the new one on the right */
.code.split .row.both { grid-template-columns: 44px 18px minmax(0, 1fr) 44px 18px minmax(0, 1fr); }
.pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.code.split .row.half { grid-template-columns: 44px 18px minmax(0, 1fr) auto; }
.pair .empty { background: var(--panel); }
.code.split .gap .gx { width: 44px; }
.gap .gx svg.i { width: 16px; height: 16px; }

.head-actions { display: flex; align-items: center; gap: var(--s3); flex: none; }
.segmented { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--edge); border-radius: var(--radius); }
.segmented button { border: 0; padding: 3px 8px; border-radius: 4px; color: var(--dim); }
.segmented button:hover:not(:disabled) { background: var(--hover); }
.segmented button.on { background: var(--edge); color: var(--text); }

.fold { margin-bottom: var(--s6); }
.fold > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: var(--s2); color: var(--soft); padding: var(--s2) 0; }
.fold > summary::-webkit-details-marker { display: none; }
.fold > summary svg { transition: transform .2s var(--ease); }
.fold[open] > summary svg { transform: rotate(90deg); }
.fold > summary .count { color: var(--dim); }
.fold > .file:first-of-type { margin-top: var(--s3); }

/* syntax: Shiki's GitHub Dark default colours each token inline; this is its plain text */
.code, .snippet { color: ${PLAIN}; }

/* building / error */
.wait { padding: var(--s6); max-width: 760px; }
.wait h1 { font: 600 20px/1.3 var(--code); margin: 0 0 var(--s2); }
.wait p { font: 14px/1.6 var(--prose); color: var(--soft); margin: 0 0 var(--s5); max-width: 62ch; }
.stage-head .clock { font-size: 12px; }
.clock { font: 500 13px var(--code); color: var(--accent); font-variant-numeric: tabular-nums; }
.failure { font: 12.5px/1.6 var(--code); color: var(--danger); background: var(--danger-soft); border-radius: var(--radius); padding: var(--s4); white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 var(--s4); }

/* ── drawer ── */
/* the drawer's left edge drags; the width it is left at is remembered per browser */
.grip { position: absolute; top: 0; bottom: 0; right: var(--drawer-w); width: 9px; margin-right: -5px; z-index: 4; cursor: col-resize; touch-action: none; }
.grip::after { content: ''; position: absolute; top: 0; bottom: 0; left: 4px; width: 1px; background: transparent; transition: background .15s, box-shadow .15s; }
.grip:hover::after, .grip:focus-visible::after, .grip.dragging::after { background: var(--accent); box-shadow: 0 0 0 1px var(--accent-soft); }
.grip:focus-visible { outline: none; }
body.resizing { cursor: col-resize; user-select: none; }
body.resizing iframe, body.resizing .stage, body.resizing .drawer { pointer-events: none; }
.drawer { background: var(--panel); border-left: 1px solid var(--edge); display: flex; flex-direction: column; min-height: 0; min-width: 0; animation: drawer-in .22s var(--ease); }
@keyframes drawer-in { from { opacity: 0; transform: translateX(16px); } }
.pane h2 .close { margin-left: auto; padding: 2px; color: var(--dim); }
.pane h2 .close:hover:not(:disabled) { color: var(--text); }
.drawer-scroll { overflow-y: auto; flex: 1; }
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
.snippet { font: 12px/20px var(--chrome); background: var(--bg); border-radius: var(--radius); padding: var(--s2) 0; margin: var(--s1) 0 var(--s2); max-height: max(24em, 45vh); overflow: auto; }
.snippet div { display: grid; grid-template-columns: 6ch max-content; }
.snippet .src { white-space: pre; padding-right: var(--s3); }
.snippet .no { position: sticky; left: 0; background: var(--bg); color: var(--dim); text-align: right; padding-right: 1ch; user-select: none; font-variant-numeric: tabular-nums; }
.ctx-more { margin-top: var(--s1); color: var(--dim); }

.line-quote { font: 11.5px/1.5 var(--code); color: var(--soft); background: var(--bg); border-radius: 4px; padding: 3px var(--s2); white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 var(--s4); }
.thread { display: grid; gap: var(--s4); }
.thread:empty { display: none; }
.thread.swap { animation: swap .18s var(--ease); }
@keyframes swap { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* a turn: what you asked, small, then the agent's answer as the text to read */
.turn { position: relative; display: grid; gap: var(--s2); }
.turn + .turn { border-top: 1px solid var(--edge); padding-top: var(--s4); }
.ask { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: var(--s2); font: 13px/1.5 var(--prose); color: var(--soft); white-space: pre-wrap; overflow-wrap: anywhere; }
.ask svg { margin-top: 3px; color: var(--accent); }
.turn.concern .ask { color: var(--text); }
.turn.concern .ask svg { color: var(--warn); }
.ask .sent { color: var(--soft); font: 11.5px var(--chrome); white-space: nowrap; }
.reply { padding-left: 22px; font: 14px/1.6 var(--prose); color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; }
.turn.concern .reply { font-size: 13px; color: var(--soft); }
.reply code, .reply .cite { font: 12px/1.4 var(--code); border-radius: 3px; padding: 0 2px; white-space: normal; }
.reply code { background: var(--bg); color: var(--text); }
.reply .cite { color: var(--accent); background: var(--accent-soft); text-decoration: none; cursor: pointer; }
.reply .cite:hover { color: var(--accent); background: ${alpha(p.accent, 0.26)}; }
.reply p, .reply ul { margin: 0 0 var(--s2); }
.reply ul { padding-left: 1.2em; white-space: normal; }
.reply li + li { margin-top: 2px; }
.reply > :last-child { margin-bottom: 0; }
.reply.pending { display: flex; align-items: center; gap: var(--s2); font-size: 13px; color: var(--soft); }
.reply.pending .ask-clock { font: 12px var(--code); color: var(--accent); font-variant-numeric: tabular-nums; }
.reply.failed { margin-left: 22px; padding: var(--s2) var(--s3); display: grid; gap: var(--s2); justify-items: start; font-size: 13px; color: var(--danger); background: var(--danger-soft); border-radius: var(--radius); }
.reply.failed button { color: var(--danger); border-color: ${alpha(p.danger, 0.5)}; }
.tools { position: absolute; top: -3px; right: 0; display: flex; gap: 2px; padding-left: var(--s5); background: linear-gradient(90deg, transparent, var(--panel) var(--s4)); opacity: 0; transition: opacity .15s; }
.turn + .turn .tools { top: calc(var(--s4) - 3px); }
.turn:hover .tools, .turn:focus-within .tools { opacity: 1; }
.tools button { font-size: 11.5px; color: var(--soft); }
.tools button.armed { color: var(--danger); opacity: 1; }
.row .dot.pending { background: transparent; box-shadow: inset 0 0 0 1.5px var(--accent); }
.row .dot.failed { background: var(--danger); }
.row .dot.draft { background: transparent; box-shadow: inset 0 0 0 1.5px var(--soft); }
.row.flash { animation: flash 1.4s var(--ease); }
@keyframes flash { from { background: var(--accent-soft); } }

/* the composer stays at the foot of the drawer however long the thread */
.composer { position: sticky; bottom: 0; z-index: 1; display: grid; gap: var(--s2); margin: var(--s3) calc(-1 * var(--s5)) calc(-1 * var(--s4)); padding: var(--s3) var(--s5) var(--s4); background: var(--panel); }
.thread:not(:empty) + .composer { border-top: 1px solid var(--edge); }
.kinds { display: grid; grid-template-columns: 1fr 1fr; background: var(--bg); border-radius: var(--radius); padding: 3px; gap: 3px; }
.kinds button { border: 0; justify-content: center; padding: 4px; border-radius: 4px; color: var(--soft); }
.kinds button.on.question { background: var(--accent-soft); color: var(--accent); }
.kinds button.on.concern { background: var(--warn-soft); color: var(--warn); }
.hint { font: 12px/1.45 var(--prose); color: var(--soft); }
.raising { font: 12px/1.45 var(--prose); color: var(--warn); margin: 0; }
textarea { font: 13.5px/1.55 var(--prose); width: 100%; min-height: 38px; max-height: 240px; background: var(--bg); color: var(--text); border: 1px solid var(--edge); border-radius: var(--radius);
  padding: var(--s2) var(--s3); resize: none; overflow-y: auto; caret-color: var(--accent); transition: border-color .15s; }
textarea:focus { outline: none; border-color: var(--accent); }
textarea::placeholder { color: var(--soft); opacity: .8; }
.composer .actions { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--s3); }
.composer .hint { flex: 1; min-width: 0; padding-top: 2px; }
.composer button.primary kbd { opacity: .85; }

/* concerns: one line until you reach for it */
.queue { border-top: 1px solid var(--edge); padding: var(--s3) var(--s5); display: grid; gap: var(--s2); background: var(--panel); }
.queue-bar { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); }
.queue-bar .count { font: 600 11.5px var(--chrome); color: var(--soft); letter-spacing: .02em; }
.queue-bar .count b { color: var(--warn); }
.queue ol { list-style: none; margin: 0; padding: 0; display: none; gap: 2px; max-height: 180px; overflow-y: auto; order: -1; }
.queue:hover ol, .queue:focus-within ol { display: grid; }
.queue li button { width: 100%; display: grid; gap: 1px; justify-items: start; text-align: left; white-space: normal; border: 0; padding: 5px var(--s2); margin: 0 calc(-1 * var(--s2)); width: calc(100% + 2 * var(--s2)); }
.queue li button:hover:not(:disabled) { background: var(--hover); }
.queue li .loc { font: 11px var(--code); color: var(--soft); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queue li .txt { font: 12.5px/1.4 var(--prose); color: var(--text); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.toast { position: fixed; left: 50%; bottom: var(--s5); transform: translate(-50%, 12px); opacity: 0; pointer-events: none; background: var(--edge); color: var(--text);
  border-radius: var(--radius); padding: var(--s2) var(--s4); box-shadow: 0 8px 24px ${alpha('#000000', 0.35)}; transition: opacity .2s, transform .2s var(--ease); }
.toast.on { opacity: 1; transform: translate(-50%, 0); }

@media (min-width: 1600px) { .app { --drawer-w: 440px; } }
@media (max-width: 1280px) { .app { --drawer-w: 340px; } .stage-head, .stage-body { padding-left: var(--s5); padding-right: var(--s5); } }
@media (max-width: 960px) {
  .app, .app.drawer-open { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 1fr auto; height: auto; min-height: 100vh; }
  .stage-head { position: static; flex-wrap: wrap; }
  .row { grid-template-columns: 40px 40px 22px minmax(0, 1fr) auto; }
  .gap .gx { width: 80px; }
  .diff-layout { display: none; }
  .rail { border-right: 0; border-bottom: 1px solid var(--edge); }
  .strip { flex-direction: row; padding: var(--s2) var(--s3); }
  .strip ol { display: flex; overflow-x: auto; padding: 0; }
  .strip li { flex: none; min-width: 40px; }
  .rail-panel { bottom: auto; max-height: 80vh; width: min(360px, 100vw); }
  .legend { display: none; }
  .drawer { border-left: 0; border-top: 1px solid var(--edge); }
  .grip { display: none; }
  .stage { overflow: visible; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;
}

const PAGE_SCRIPT = String.raw`
var base = location.pathname.replace(/\/$/, '');
var data = null;
var current = 0;
var numFrom = 1;          // the number section 0 goes by: 0 when it is the overview
var cursor = null;        // { path, row } of the line under the cursor
var drafts = {};          // thread key -> unsent text, per line so a draft never moves
var kinds = {};           // thread key -> 'question' or 'concern'
var raising = {};         // thread key -> id of the question being raised
var sending = false;
var landed = null;        // the last answer that came in on a line you are not on
var clockOffset = 0;      // server clock minus ours
var pollTimer;
var announced = {};       // "id@askedAt" -> its landing was already said
var unfolded = {};        // path -> whole file shown
var viewed = {};          // viewKey -> marked viewed, which folds it as GitHub does; per browser
try { viewed = JSON.parse(localStorage.getItem('fw-review-viewed:' + base) || '{}') || {}; } catch (e) {}
var folded = {};          // viewKey -> folded or unfolded by hand, over what viewed says
var opened = {};          // "path:a:b" -> gap expanded
var diffOpen = {};        // path -> diff shown in a mechanical section, where it starts hidden
var ctxOpen = {};         // "section:path:start" -> context ref unfolded
var ctxAll = {};          // section -> every context ref listed, not just the first few
var leansOpen = {};       // section -> its context refs unfolded under the summary
var railOpen = false;     // the full § list is open over the code
var pinned = true;        // the list docked beside the code, kept open; per browser
try { pinned = localStorage.getItem('fw-review-pinned') !== '0'; } catch (e) {}
var treeShut = {};        // folder -> folded in the file tree
var treeFilter = '';      // what the file tree is filtered on
var treeAt = null;        // the file last picked in the tree
var drawerOpen = false;   // the thread drawer is open beside the code
var stale = false;
var lastThreadKey = '';
var layout = 'inline';    // 'inline' or 'split', remembered per browser
try { if (localStorage.getItem('fw-review-layout') === 'split') layout = 'split'; } catch (e) {}
var view = 'plain';       // what is on screen: 'plain' or 'sections'
var opensOn = 'sections'; // where a review that has its sections opens, remembered per browser
try { if (localStorage.getItem('fw-review-view') === 'plain') opensOn = 'plain'; } catch (e) {}
// Side by side needs room; a narrow window always reads inline.
var narrow = matchMedia('(max-width: 960px)');
narrow.addEventListener('change', function () { if (data) renderStage(); });
try { drafts = JSON.parse(localStorage.getItem('fw-review-drafts:' + base) || '{}') || {}; } catch (e) {}
function saveDrafts() { try { localStorage.setItem('fw-review-drafts:' + base, JSON.stringify(drafts)); } catch (e) {} }
function mmss(ms) { var sec = Math.floor(Math.max(0, ms) / 1000); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }
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
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  list: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  undock: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>',
  dock: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/>',
  folder: '<path d="M2.5 6A1.5 1.5 0 0 1 4 4.5h5.2l2 2.5H20A1.5 1.5 0 0 1 21.5 8.5v10A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5Z"/>',
  filediff: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M12 7v6M9 10h6M9 16.5h6"/>',
  fileadded: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M12 8.5v7M8.5 12h7"/>',
  fileremoved: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8.5 12h7"/>',
  filemoved: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 12h8M13 9l3 3-3 3"/>',
  foldup: '<path d="M12 15V5M8 9l4-4 4 4"/><path d="M5 19h2M11 19h2M17 19h2"/>',
  folddown: '<path d="M12 9v10M8 15l4 4 4-4"/><path d="M5 5h2M11 5h2M17 5h2"/>',
  unfold: '<path d="M12 3v6M9 6l3-3 3 3M12 21v-6M9 18l3 3 3-3"/><path d="M5 12h2M11 12h2M17 12h2"/>',
  fold: '<path d="M12 3v6M9 6l3 3 3-3M12 21v-6M9 18l3-3 3 3"/><path d="M5 12h2M11 12h2M17 12h2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  talk: '<path d="M4 5h16v11H9l-5 4Z"/>'
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
var BQ = '\x60';

/**
 * Paint a line: its tokens, [text, colour] as Shiki gave them in GitHub Dark
 * default, with [a, b) marked as the changed words.
 */
function paint(toks, a, b) {
  var frag = document.createDocumentFragment();
  var pos = 0;
  toks.forEach(function (tok) {
    var t = tok[0], color = tok[1];
    var start = pos, end = pos + t.length;
    pos = end;
    var cuts = [start, end];
    if (a != null && a > start && a < end) cuts.push(a);
    if (b != null && b > start && b < end) cuts.push(b);
    cuts.sort(function (x, y) { return x - y; });
    for (var i = 0; i < cuts.length - 1; i++) {
      var s = cuts[i], e = cuts[i + 1];
      if (e <= s) continue;
      var piece = t.slice(s - start, e - start);
      var changed = a != null && s >= a && e <= b;
      if (!changed && !color) { frag.append(document.createTextNode(piece)); continue; }
      frag.append(h('span', { class: changed ? 'w' : null, style: color ? 'color:' + color : null, text: piece }));
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
    // Paired line by line as GitHub pairs them, even when the counts differ;
    // the shared-text test below keeps lines that have nothing in common unmarked.
    for (var k = 0; k < Math.min(dels, adds); k++) {
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
    // Tabs as four spaces, once: the word marks have to index the same text that is drawn.
    for (var path in d.files || {}) d.files[path].rows.forEach(function (r) { r.text = r.text.replace(/\t/g, '    '); });
    (d.sections || []).forEach(function (s) { s.refs.forEach(function (r) { r.lines = r.lines.map(function (l) { return l.replace(/\t/g, '    '); }); }); });
    var before = data;
    data = d;
    clockOffset = (d.now || Date.now()) - Date.now();
    document.title = 'Review · ' + (d.repo || '');
    // Until the sections come there is only the plain diff, and arriving
    // sections never take the page from under you: you stay on it.
    if (first) view = d.sections ? opensOn : 'plain';
    var arrived = d.sections && before && !before.sections;
    if ((first || arrived) && d.sections) {
      numFrom = d.sections[0] && d.sections[0].areas ? 0 : 1;
      // A §n in the address wins, so a reload stays put; else the first not yet reviewed.
      var asked = Number((location.hash.match(/^#(\d+)$/) || [])[1]) - numFrom;
      var open = d.sections.findIndex(function (_, i) { return d.checked.indexOf(i) < 0; });
      current = asked >= 0 && asked < d.sections.length ? asked : open < 0 ? 0 : open;
    }
    if (first || !before || before.status !== d.status) render();
    else VIEWS[view].poll();
    if (arrived) toast('Sections ready · v to switch');
    announce(before, d);
    var busy = d.status === 'building' || (d.comments || []).some(function (c) { return c.asking; });
    clearTimeout(pollTimer);
    if (busy) pollTimer = setTimeout(load, 2000);
  }).catch(function () { clearTimeout(pollTimer); pollTimer = setTimeout(load, 4000); });
}

/** Say when an answer lands; one on another line can be reached with g. */
function announce(before, d) {
  if (!before || !before.comments || !d.comments) return;
  var was = {};
  before.comments.forEach(function (c) { if (c.asking) was[c.id] = true; });
  d.comments.forEach(function (c) {
    if (!was[c.id] || c.asking || announced[c.id + '@' + c.askedAt]) return;
    announced[c.id + '@' + c.askedAt] = true;
    var where = c.path ? rowLabel(c.path, c.row) : sec(c.section);
    var on = cursorOn();
    var here = c.section === current && (on ? c.path === on.path && c.row === on.row : !c.path);
    if (here) return toast((c.failed ? 'No answer on ' : 'Answered on ') + where);
    landed = c;
    toast((c.failed ? 'No answer on ' : 'Answer on ') + where + ' · g to go there');
  });
}

function goTo(c) {
  if (c.section !== current) go(c.section);
  if (c.path) setCursor(c.path, c.row, true);
  else { cursor = null; render(); }
  setDrawer(true);
}

function checkStale() {
  if (!data || data.status !== 'ready') return;
  api('GET', 'stale').then(function (r) { if (r.stale !== stale) { stale = r.stale; renderStage(); } });
}

function regenerate() {
  api('POST', 'regenerate').then(function (r) { if (r.key) location.href = base.replace(/[^/]+$/, r.key); });
}

function section() { return data.sections[current]; }
/** A section's number, in its heading and the address alike: the overview is §0, the sections count from §1. */
function num(i) { return i + numFrom; }
function sec(i) { return '§' + num(i); }
function owner(path, row) { return data.files[path].owners[row]; }
function threadFor(path, row) {
  return path ? lineComments(path, row) : data.comments.filter(function (c) { return c.section === current && !c.path; });
}
/**
 * The comments on a line this view shows: in the sections, only the current
 * one's. A line's dot, a click on it and ] all go by these, so a dot always opens a thread.
 */
function lineComments(path, row) {
  return data.comments.filter(function (c) { return c.path === path && c.row === row && (view !== 'sections' || c.section === current); });
}
function rowLabel(path, row) {
  var r = data.files[path].rows[row];
  return path.split('/').pop() + ':' + (r.new != null ? r.new : r.old);
}

/* ── rail ── */
function renderRail() {
  var steps = VIEWS[view].steps();
  var panel = h('div', { class: 'rail-panel', id: 'rail-panel' }, h('div', { class: 'rail-head' },
    h('button', { class: 'ghost pin', title: pinned ? 'Let the list close (L)' : 'Keep the list open (L)', 'aria-label': 'Keep the list open',
      'aria-pressed': String(pinned), onclick: togglePin }, icon(pinned ? 'undock' : 'dock')),
    h('div', { class: 'repo', text: data.repo || data.title }),
    h('div', { class: 'base' }, icon('branch'), h('span', {}, data.unstaged ? 'unstaged, against ' : 'against '), h('span', { class: 'ref', text: data.against || '' })),
    segmented('What to review', 'scope', !!data.unstaged, [
      { value: false, label: 'Branch', title: 'Everything since ' + (data.base || 'the trunk') },
      { value: true, label: 'Unstaged', title: 'Only what is not staged: the latest edits' },
    ], setScope),
    // A switch only once there are sections to switch to.
    data.sections ? segmented('View', 'scope', view, [
      { value: 'plain', label: 'Plain diff', title: 'Plain diff (v)' },
      { value: 'sections', label: 'Sections', title: 'Sections (v)' },
    ], setView) : null));
  VIEWS[view].rail(panel, steps);
  document.getElementById('rail').replaceChildren(stripEl(steps), panel);
  syncRail();
}

/**
 * What a view walks through: a § per section, or a file per changed file.
 * The strip and the full list both draw these, so they never disagree.
 */
function sectionSteps() {
  return data.sections.map(function (s, i) {
    var state = i === current ? 'current' : data.checked.indexOf(i) >= 0 ? 'done' : 'todo';
    return {
      state: state, mark: { current: 'now', done: 'done', todo: 'todo' }[state], short: String(num(i)), n: sec(i),
      title: s.title, tip: sec(i) + '  ' + s.title, warn: !!s.uncovered,
      tag: s.uncovered ? 'not placed by the recap' : s.mechanical ? 'mechanical' : s.areas ? 'the change at a glance' : null,
      pick: function () { go(i); },
    };
  });
}

function fileSteps() {
  return data.plain.map(function (sf) {
    var status = data.files[sf.path].status;
    var parts = sf.path.split('/');
    var letter = { added: 'A', deleted: 'D', renamed: 'R' }[status] || 'M';
    return {
      state: status, mark: null, short: letter, n: letter,
      title: parts.pop(), tip: sf.path, warn: false, tag: parts.join('/') || null,
      pick: function () { showFile(sf.path); },
    };
  });
}

/** The strip that stays: a step each, its state at a glance, its title on hover or focus. */
function stripEl(steps) {
  var tally = VIEWS[view].tally();
  return h('div', { class: 'strip' },
    h('button', { class: 'ghost toggle', title: 'Sections, scope and keys (l)', 'aria-label': 'The full list', 'aria-controls': 'rail-panel',
      onclick: function () { setRail(!railOpen); } }, icon('list')),
    tally ? h('span', { class: 'count', title: tally[0] + ' of ' + tally[1] + ' reviewed' }, h('b', { text: String(tally[0]) }), '/' + tally[1]) : null,
    h('ol', { 'aria-label': VIEWS[view].label }, steps.map(function (st) {
      return h('li', {}, h('button', { class: st.state, 'data-tip': st.tip, 'aria-label': st.tip, 'aria-current': st.state === 'current' ? 'step' : null, onclick: st.pick },
        st.mark ? icon(st.mark) : null, st.short));
    })));
}

/** The full list's steps; picking one closes the list. */
function stepList(steps) {
  return h('ol', { class: 'sections' }, steps.map(function (st) {
    return h('li', { class: st.state + (st.warn ? ' uncovered' : ''), 'aria-current': st.state === 'current' ? 'step' : null,
      onclick: function () { setRail(false); st.pick(); } },
      h('span', { class: 'mark' }, st.mark ? icon(st.mark) : null),
      h('span', { class: 'n', text: st.n }),
      h('span', {}, h('span', { class: 't', text: st.title }), st.tag ? h('span', { class: 'tag', text: st.tag }) : null));
  }));
}

/** Open or close the full list. A toggle, not a redraw, so it slides. */
function setRail(open) {
  railOpen = open;
  syncRail();
}
function togglePin() {
  pinned = !pinned;
  railOpen = false;
  try { localStorage.setItem('fw-review-pinned', pinned ? '1' : '0'); } catch (e) {}
  renderRail();
}
function syncRail() {
  var rail = document.getElementById('rail');
  var docked = pinned && !narrow.matches;
  document.querySelector('.app').classList.toggle('pinned', docked);
  rail.classList.toggle('open', railOpen || docked);
  document.getElementById('rail-panel').inert = !(railOpen || docked);
  rail.querySelector('.strip .toggle').setAttribute('aria-expanded', String(railOpen));
}

function showFile(path) {
  var el = document.querySelector('#stage [data-file="' + CSS.escape(path) + '"]');
  if (el) el.scrollIntoView({ block: 'start' });
}

// One tooltip for the strip, fixed so the strip's scroll does not clip it.
(function () {
  var tip = document.getElementById('tip');
  var rail = document.getElementById('rail');
  function show(e) {
    var b = e.target.closest('.strip [data-tip]');
    if (!b) return hide();
    var r = b.getBoundingClientRect();
    tip.textContent = b.dataset.tip;
    tip.style.left = (r.right + 8) + 'px';
    tip.style.top = (r.top + r.height / 2) + 'px';
    tip.classList.add('on');
  }
  function hide() { tip.classList.remove('on'); }
  rail.addEventListener('mouseover', show);
  rail.addEventListener('focusin', show);
  rail.addEventListener('mouseleave', hide);
  rail.addEventListener('focusout', hide);
})();

// A click outside the open list closes it.
document.addEventListener('pointerdown', function (e) {
  if (railOpen && !document.getElementById('rail').contains(e.target)) setRail(false);
});

/** The sections' list: progress, the §s, and the keys. */
function sectionsRail(panel, steps) {
  panel.append(h('div', { class: 'progress' },
    h('div', { class: 'segments', 'aria-hidden': 'true' }, steps.map(function (st) { return h('span', { class: st.state }); })),
    h('div', { class: 'progress-label' }, h('b', { text: String(data.checked.length) }), ' of ' + steps.length + ' sections reviewed')));
  panel.append(stepList(steps));
  panel.append(h('div', { class: 'legend' },
    h('span', {}, h('kbd', { text: 'j' }), ' ', h('kbd', { text: 'k' })), h('span', { text: 'line' }),
    h('span', {}, h('kbd', { text: 'n' }), ' ', h('kbd', { text: 'p' })), h('span', { text: 'section' }),
    h('span', {}, h('kbd', { text: '[' }), ' ', h('kbd', { text: ']' })), h('span', { text: 'line with a thread' }),
    h('span', {}, h('kbd', { text: 'c' }), ' ', h('kbd', { text: 'C' })), h('span', { text: 'ask, or raise a concern' }),
    h('span', {}, h('kbd', { text: 'x' })), h('span', { text: 'mark reviewed, go on' }),
    h('span', {}, h('kbd', { text: 's' })), h('span', { text: 'inline or side by side' }),
    h('span', {}, h('kbd', { text: 'v' })), h('span', { text: 'plain diff or sections' }),
    h('span', {}, h('kbd', { text: 't' }), ' ', h('kbd', { text: 'w' })), h('span', { text: 'thread drawer, widen it' }),
    h('span', {}, h('kbd', { text: 'l' }), ' ', h('kbd', { text: 'L' })), h('span', { text: 'this list, keep it open' })));
}

/** The plain diff's list: the changed files as GitHub's tree, each a jump to its diff. */
function plainRail(panel, steps) {
  var n = steps.length;
  var list = h('ul', { class: 'tree', role: 'tree', 'aria-label': 'Changed files' });
  function fill() { list.replaceChildren.apply(list, treeRows()); }
  panel.append(h('div', { class: 'progress' },
    h('div', { class: 'progress-label' }, h('b', { text: String(n) }), ' file' + (n > 1 ? 's' : '') + ' changed')));
  panel.append(h('label', { class: 'tree-filter' }, icon('search'),
    h('input', { type: 'search', placeholder: 'Filter files…', 'aria-label': 'Filter files', value: treeFilter,
      oninput: function (e) { treeFilter = e.target.value; fill(); } })));
  panel.append(list);
  fill();
}

/**
 * The changed files as folders and files, folders first, a folder with one
 * folder and no files merged into it ("orders/components"), as GitHub draws it.
 */
function treeRows() {
  var q = treeFilter.trim().toLowerCase();
  var root = { dirs: {}, files: [] };
  data.plain.forEach(function (sf) {
    if (q && sf.path.toLowerCase().indexOf(q) < 0) return;
    var parts = sf.path.split('/'), node = root;
    for (var i = 0; i < parts.length - 1; i++) node = node.dirs[parts[i]] || (node.dirs[parts[i]] = { dirs: {}, files: [] });
    node.files.push(sf.path);
  });
  function rows(node, prefix, depth) {
    var out = [];
    Object.keys(node.dirs).sort().forEach(function (name) {
      var d = node.dirs[name], label = name;
      while (!d.files.length && Object.keys(d.dirs).length === 1) { var only = Object.keys(d.dirs)[0]; label += '/' + only; d = d.dirs[only]; }
      var key = prefix + label;
      // A filter shows every match, whatever was folded.
      var shut = !q && treeShut[key];
      out.push(h('li', { role: 'treeitem', 'aria-expanded': String(!shut) },
        h('button', { class: 'ghost node', style: '--depth:' + depth, 'aria-expanded': String(!shut), onclick: function () { treeShut[key] = !shut; renderRail(); } },
          h('span', { class: 'chev' }, icon('chevron')), h('span', { class: 'dir' }, icon('folder')), h('span', { class: 'name', text: label })),
        shut ? null : h('ul', { role: 'group' }, rows(d, key + '/', depth + 1))));
    });
    node.files.sort().forEach(function (path) {
      var status = data.files[path].status;
      var talk = data.comments.filter(function (c) { return c.path === path; }).length;
      out.push(h('li', { role: 'treeitem' },
        h('button', { class: 'ghost node ' + status + (treeAt === path ? ' current' : ''), style: '--depth:' + depth, title: path,
          onclick: function () { treeAt = path; setRail(false); renderRail(); showFile(path); } },
          h('span', { class: 'chev' }), h('span', { class: 'fi' }, icon({ added: 'fileadded', deleted: 'fileremoved', renamed: 'filemoved' }[status] || 'filediff')), h('span', { class: 'name', text: path.split('/').pop() }),
          talk ? h('span', { class: 'talk', title: talk + ' comment' + (talk > 1 ? 's' : '') }, icon('talk'), String(talk)) : null)));
    });
    return out;
  }
  var out = rows(root, '', 0);
  return out.length ? out : [h('li', { class: 'none', text: 'No file matches' })];
}

function setScope(unstaged) {
  api('POST', 'scope', { unstaged: unstaged }).then(function (r) {
    if (r.key) location.href = base.replace(/[^/]+$/, r.key);
    else toast(r.error || 'Could not switch');
  });
}

/* ── stage ── */
// File heads stick under the stage head, whatever height it wraps to as the window or the list changes.
var headSize = new ResizeObserver(function (es) {
  var head = es[0].target;
  document.getElementById('stage').style.setProperty('--head-h', getComputedStyle(head).position === 'sticky' ? head.offsetHeight + 'px' : '0px');
});
function renderStage() {
  var stage = document.getElementById('stage');
  var top = stage.scrollTop;
  stage.replaceChildren();
  VIEWS[view].stage(stage);
  headSize.disconnect();
  var head = stage.querySelector('.stage-head');
  if (head) headSize.observe(head);
  stage.scrollTop = top;
}

function sectionStage(stage) {
  var s = section();
  var isDone = data.checked.indexOf(current) >= 0;
  stage.append(h('header', { class: 'stage-head' },
    h('h1', {}, h('span', { class: 'n', text: sec(current) }), h('span', { text: s.title }),
      s.mechanical ? h('span', { class: 'kind', text: 'mechanical' }) : null),
    h('div', { class: 'head-actions' },
      queuedEl(),
      s.areas ? null : viewedCount(s.files),
      s.areas ? null : layoutEl(),
      h('button', { class: isDone ? 'done' : 'primary', onclick: toggleChecked },
        icon(isDone ? 'check' : 'done'), isDone ? 'Reviewed' : 'Mark reviewed', h('kbd', { text: 'x' })))));
  if (stale) {
    stage.append(h('div', { class: 'banner' },
      h('span', { text: 'The worktree has moved since this review was pinned. What you see is the earlier state.' }),
      h('button', { onclick: regenerate }, icon('refresh'), 'Review the new state')));
  }
  var body = s.areas ? overviewEl(s) : filesEl(s.files, current);
  body.prepend(ledeEl(s));
  stage.append(body);
}

/**
 * §0, under its summary: the parts of the code the change touches, as a pull
 * request's description lists them, each file a jump to the section that shows it.
 */
function overviewEl(s) {
  var t = [0, 0];
  for (var path in data.files) { var f = tally(data.files[path].rows); t[0] += f[0]; t[1] += f[1]; }
  var n = data.plain.length;
  return h('div', { class: 'stage-body' },
    h('div', { class: 'overview-total' }, n + ' file' + (n === 1 ? '' : 's') + ' changed', statsEl(t[0], t[1])),
    h('ol', { class: 'areas' }, s.areas.map(function (a) {
      return h('li', { class: 'area' },
        h('h2', { text: a.title }),
        h('p', { class: 'summary', text: a.summary }),
        a.paths.length ? h('ul', { class: 'area-files' }, a.paths.map(areaFileEl)) : null);
    })));
}

/** A file of an area, a jump to the section that owns its change; a rowless file's is the one that lists it. */
function areaFileEl(path) {
  var file = data.files[path];
  var t = tally(file.rows);
  var at = file.owners.find(function (o) { return o >= 0; });
  if (at == null) at = data.sections.findIndex(function (x) { return x.files.some(function (f) { return f.path === path; }); });
  var to = data.sections[at];
  return h('li', {}, h('button', { class: 'ghost', disabled: !to, title: to ? 'Go to ' + sec(at) + '  ' + to.title : null, onclick: function () { go(at); } },
    h('span', { class: 'path', text: path }), statsEl(t[0], t[1]), to ? h('span', { class: 'own', text: sec(at) }) : null));
}

/** What the section does and the code it leans on: read once, above its code. */
function ledeEl(s) {
  var said = threadFor(null).length;
  var refs = null;
  if (s.refs.length) {
    // A long list, unfolded, would push the code below the fold.
    var shown = ctxAll[current] || s.refs.length <= CTX_SHOWN + 1 ? s.refs : s.refs.slice(0, CTX_SHOWN);
    refs = h('details', { class: 'leans', open: !!leansOpen[current], ontoggle: function (e) { leansOpen[current] = e.target.open; } },
      h('summary', {}, icon('chevron'), 'Context it leans on', h('span', { class: 'count', text: String(s.refs.length) })),
      h('div', { class: 'ctx-list' }, shown.map(ctxEl)),
      shown.length < s.refs.length ? h('button', { class: 'ghost ctx-more', onclick: function () { ctxAll[current] = true; renderStage(); } },
        icon('expand'), (s.refs.length - shown.length) + ' more') : null);
  }
  return h('div', { class: 'lede' },
    s.summary ? h('p', { class: 'summary', text: s.summary }) : h('p', { class: 'muted', text: 'No summary for this section.' }),
    refs || said ? h('div', { class: 'lede-tools' }, refs,
      said ? h('button', { class: 'ghost', onclick: function () { goTo({ section: current }); } }, icon('question'),
        said + ' on this section') : null) : null);
}

/** Concerns waiting to go to the author: one button to the queue in the drawer. */
function queuedEl() {
  var n = pendingConcerns().length;
  if (!n) return null;
  return h('button', { class: 'queued', title: 'Concerns to send (t)', onclick: function () { setDrawer(true); } }, icon('concern'), n + ' to send');
}

/** Every file, each change with the code around it: to read before the sections come, or instead of them. */
function plainStage(stage) {
  stage.append(h('header', { class: 'stage-head' },
    h('h1', {}, h('span', { text: 'Plain diff' }), recapClock()),
    h('div', { class: 'head-actions' }, viewedCount(data.plain), layoutEl())));
  stage.append(recapFailure() || '', filesEl(data.plain, null));
}

/** How long the recap has been building, ticking in place; nothing once it is done. */
var clockTimer;
function recapClock() {
  if (data.status !== 'building') return null;
  var clock = h('span', { class: 'clock' });
  var offset = (data.now || Date.now()) - Date.now();
  function tick() { clock.textContent = mmss(Date.now() + offset - (data.startedAt || Date.now())); }
  tick();
  clearInterval(clockTimer);
  clockTimer = setInterval(function () { if (!clock.isConnected) return clearInterval(clockTimer); tick(); }, 1000);
  return h('span', { class: 'kind' }, 'an agent is cutting it into sections · ', clock);
}

/** Why the recap failed, and the way to run it again; nothing unless it did. */
function recapFailure() {
  if (data.status !== 'error') return null;
  return h('div', { class: 'wait' },
    h('h1', { text: 'The recap did not come through' }),
    h('p', { text: 'The agent that cuts the change into sections failed. Nothing is lost: your checkoffs and comments are kept with this snapshot. Run it again; if it keeps failing, the message below says why. The plain diff is below.' }),
    h('pre', { class: 'failure', text: data.error || 'unknown error' }),
    h('button', { class: 'primary', onclick: regenerate }, icon('refresh'), 'Run the recap again'));
}

/** A row of buttons with one on; pick gets the value of another one clicked. */
function segmented(label, cls, value, options, pick) {
  return h('div', { class: 'segmented' + (cls ? ' ' + cls : ''), role: 'radiogroup', 'aria-label': label }, options.map(function (o) {
    var on = o.value === value;
    return h('button', {
      class: on ? 'on' : '', role: 'radio', 'aria-checked': on ? 'true' : 'false', title: o.title,
      onclick: function () { if (!on) pick(o.value); },
    }, o.icon ? icon(o.icon) : null, o.label);
  }));
}

function layoutEl() {
  return segmented('Diff layout', 'diff-layout', layout, [
    { value: 'inline', label: 'Inline', title: 'Inline (s)', icon: 'inline' },
    { value: 'split', label: 'Split', title: 'Side by side (s)', icon: 'split' },
  ], setLayout);
}

/**
 * The code files in order, the tests folded under them. A changed line that
 * belongs to a section other than at is dimmed; with at null, none is.
 */
function filesEl(files, at) {
  var body = h('div', { class: 'stage-body' });
  var code = files.filter(function (f) { return !TEST.test(f.path); });
  var tests = files.filter(function (f) { return TEST.test(f.path); });
  code.forEach(function (f) { body.append(fileEl(f, at)); });
  if (tests.length) {
    body.append(h('details', { class: 'fold' },
      h('summary', {}, icon('chevron'), 'Tests', h('span', { class: 'count', text: tests.length + ' file' + (tests.length > 1 ? 's' : '') })),
      tests.map(function (f) { return fileEl(f, at); })));
  }
  return body;
}

/** A file's place in the viewed marks: per section, as the same file shows other code in another. */
function viewKey(path) { return (view === 'plain' ? 'plain' : current) + ':' + path; }

function setViewed(path, on) {
  var k = viewKey(path);
  if (on) viewed[k] = true; else delete viewed[k];
  delete folded[k];
  try { localStorage.setItem('fw-review-viewed:' + base, JSON.stringify(viewed)); } catch (e) {}
  renderStage();
  // Folding a file read halfway down leaves you below it: bring its head back, as GitHub does.
  var el = document.querySelector('#stage [data-file="' + CSS.escape(path) + '"]');
  if (el && on) el.scrollIntoView({ block: 'nearest' });
}

function viewedCount(files) {
  var n = files.filter(function (f) { return viewed[viewKey(f.path)]; }).length;
  return h('span', { class: 'viewed-count' }, h('b', { text: n + ' / ' + files.length }), ' viewed');
}

/** [added, removed] rows of a file within its windows; the whole file when none are given. */
function tally(rows, windows) {
  var t = [0, 0];
  (windows || [[0, rows.length - 1]]).forEach(function (w) {
    for (var i = w[0]; i <= w[1]; i++) { if (rows[i].kind === '+') t[0]++; else if (rows[i].kind === '-') t[1]++; }
  });
  return t;
}

/** GitHub's +a -d and its five squares, green for the share added. */
function statsEl(adds, dels) {
  var total = adds + dels, n = Math.min(5, total), g = total ? Math.round(adds / total * n) : 0;
  var boxes = [];
  for (var i = 0; i < 5; i++) boxes.push(h('i', { class: i < g ? 'a' : i < n ? 'd' : null }));
  return h('span', { class: 'stats', title: adds + ' addition' + (adds === 1 ? '' : 's') + ', ' + dels + ' deletion' + (dels === 1 ? '' : 's') },
    adds ? h('span', { class: 'plus', text: '+' + adds }) : null,
    dels ? h('span', { class: 'minus', text: '-' + dels }) : null,
    h('span', { class: 'boxes', 'aria-hidden': 'true' }, boxes));
}

function fileEl(sf, at) {
  var file = data.files[sf.path];
  var rows = file.rows;
  var toks = file.tokens;
  var whole = unfolded[sf.path];
  // Generated code can run to thousands of rows: drawn only when asked, or the page hangs.
  var hidden = at != null && data.sections[at].mechanical && !diffOpen[sf.path] && !whole;
  var vkey = viewKey(sf.path);
  var shut = vkey in folded ? folded[vkey] : !!viewed[vkey];
  var t = tally(rows, sf.windows);
  var marks = rows.length && !hidden ? wordDiff(sf.path) : {};
  var windows = whole ? [[0, rows.length - 1]] : sf.windows;
  // An added or deleted file has only one side; split would leave half the page blank.
  var split = layout === 'split' && !narrow.matches && (file.status === 'modified' || file.status === 'renamed');
  var box = h('div', { class: split ? 'code split' : 'code' });
  var last = -1;
  /**
   * GitHub's @@ -old,count +new,count @@ for rows a..b, then git's default
   * function context: the last old-side line above that starts at column 0
   * with a letter, _ or $ ("func (s *X) build(…)"), cut at 80 as git cuts it.
   */
  function hunk(a, b) {
    var o = 0, oc = 0, n = 0, nc = 0, fn = '';
    for (var i = a; i <= b; i++) {
      if (rows[i].old != null) { o = o || rows[i].old; oc++; }
      if (rows[i].new != null) { n = n || rows[i].new; nc++; }
    }
    for (var j = a - 1; j >= 0 && !fn; j--) if (rows[j].old != null && /^[A-Za-z_$]/.test(rows[j].text)) fn = ' ' + rows[j].text.trimEnd().slice(0, 80);
    return '@@ -' + o + ',' + oc + ' +' + n + ',' + nc + ' @@' + fn;
  }
  /** Hidden rows from..to, folded into the header of window w (none past the last one). */
  function gap(from, to, w) {
    var key = sf.path + ':' + from + ':' + to;
    if (opened[key]) { span(from, to); return; }
    var hidden = (to - from + 1) + ' unchanged line' + (to > from ? 's' : '');
    box.append(h('button', { class: 'gap', title: 'Show ' + hidden, 'aria-label': 'Show ' + hidden, onclick: function () { opened[key] = true; renderStage(); } },
      // GitHub's arrows: up at the top of the file, down past the last hunk, both ways between two.
      h('span', { class: 'gx' }, icon(!w ? 'folddown' : from === 0 ? 'foldup' : 'unfold')), h('span', { class: 'hd', text: w ? hunk(w[0], w[1]) : '' })));
  }
  /** Row i; side draws only its old or new half, for side by side. */
  function rowEl(i, side) {
    var r = rows[i];
    var own = owner(sf.path, i);
    var cls = 'row' + (r.kind === '+' ? ' add' : r.kind === '-' ? ' del' : '');
    var foreign = at != null && r.kind !== ' ' && own !== at && own >= 0;
    if (foreign) cls += ' other';
    if (cursor && cursor.path === sf.path && cursor.row === i) cls += ' cursor';
    var m = marks[i];
    var sign = h('span', { class: 'sign', text: r.kind === ' ' ? '' : r.kind === '+' ? '+' : '−' });
    var src = h('span', { class: 'src' }, paint(toks[i], m ? m[0] : null, m ? m[1] : null));
    var cells;
    if (!split) cells = [h('span', { class: 'no', text: r.old == null ? '' : r.old }), h('span', { class: 'no', text: r.new == null ? '' : r.new }), sign, src];
    else if (side) cells = [h('span', { class: 'no', text: side === 'old' ? r.old : r.new }), sign, src];
    // A kept line is the same text on both sides, so one row holds both.
    else cells = [h('span', { class: 'no', text: r.old }), h('span', { class: 'sign' }), src,
      h('span', { class: 'no', text: r.new }), h('span', { class: 'sign' }), h('span', { class: 'src' }, paint(toks[i]))];
    if (split) cls += side ? ' half' : ' both';
    return h('div', { class: cls, 'data-path': sf.path, 'data-row': i, onclick: function () { setCursor(sf.path, i, false); if (lineComments(sf.path, i).length) setDrawer(true); } },
      dotFor(sf.path, i),
      cells,
      split && !side ? null : foreign ? h('span', { class: 'own', text: sec(own) }) : h('span'));
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
  if (!hidden && !shut) {
    windows.forEach(function (w) {
      if (w[0] > last + 1) gap(last + 1, w[0] - 1, w);
      else if (!whole) box.append(h('div', { class: 'gap' }, h('span', { class: 'gx' }), h('span', { class: 'hd', text: hunk(w[0], w[1]) })));
      span(w[0], w[1]);
      last = w[1];
    });
    if (rows.length && last < rows.length - 1) gap(last + 1, rows.length - 1);
  }

  var parts = sf.path.split('/');
  var name = parts.pop();
  var dir = parts.length ? parts.join('/') + '/' : '';
  var renamed = file.oldPath && file.oldPath !== sf.path;
  return h('section', { class: 'file', 'data-file': sf.path },
    h('div', { class: 'file-head' },
      h('button', { class: 'ghost fold-toggle', 'aria-expanded': String(!shut), 'aria-label': (shut ? 'Unfold ' : 'Fold ') + sf.path,
        onclick: function () { folded[vkey] = !shut; renderStage(); } }, icon('chevron')),
      h('span', { class: 'path' }, renamed ? file.oldPath + ' → ' : '', dir, h('b', { text: name })),
      h('button', { class: 'ghost', title: 'Copy path', 'aria-label': 'Copy ' + sf.path,
        onclick: function () { navigator.clipboard.writeText(sf.path).then(function () { toast('Copied ' + sf.path); }, function () {}); } }, icon('copy')),
      rows.length && !shut && !hidden ? h('button', { class: 'ghost', title: whole ? 'Only this section' : 'Whole file', 'aria-label': whole ? 'Only this section' : 'Whole file',
        onclick: function () { unfolded[sf.path] = !whole; renderStage(); } }, icon(whole ? 'fold' : 'unfold')) : null,
      file.status !== 'modified' ? h('span', { class: 'status ' + file.status, text: file.status }) : null,
      sf.note ? h('span', { class: 'note', text: sf.note }) : null,
      h('span', { class: 'spacer' }),
      hidden ? h('button', { class: 'ghost', onclick: function () { diffOpen[sf.path] = true; renderStage(); } }, icon('expand'),
        'Show diff · ' + rows.filter(function (r) { return r.kind !== ' '; }).length + ' changed lines')
      : null,
      t[0] + t[1] ? statsEl(t[0], t[1]) : null,
      h('label', { class: 'viewed' + (viewed[vkey] ? ' on' : '') },
        h('input', { type: 'checkbox', checked: !!viewed[vkey], onchange: function (e) { setViewed(sf.path, e.target.checked); } }), 'Viewed')),
    rows.length && !hidden && !shut ? box : null);
}

/* ── drawer ── */
function threadKey(on) { return on ? on.path + ':' + on.row : 'section:' + current; }
function cursorOn() { return cursor && data.files[cursor.path] ? cursor : null; }

function renderDrawer() {
  var el = document.getElementById('drawer');
  if (VIEWS[view].drawer) VIEWS[view].drawer(el); else el.replaceChildren();
}

function sectionDrawer(insp) {
  var on = cursorOn();
  var key = threadKey(on);
  var prev = insp.querySelector('.drawer-scroll');
  var keepTop = prev && key === lastThreadKey ? prev.scrollTop : 0;
  var scroll = h('div', { class: 'drawer-scroll' });

  scroll.append(threadPane());
  insp.replaceChildren(scroll, queueEl());
  scroll.scrollTop = keepTop;
}

/** The line under the cursor and its thread: the one pane a cursor move redraws. */
function threadPane() {
  var on = cursorOn();
  var key = threadKey(on);
  var list = h('div', { class: 'thread' + (key !== lastThreadKey ? ' swap' : ''), id: 'thread' });
  fillThread(list);
  lastThreadKey = key;
  var quote = on ? data.files[on.path].rows[on.row] : null;
  return h('div', { class: 'pane', id: 'thread-pane' },
    h('h2', {}, on ? 'On this line' : 'On this section', on ? h('span', { class: 'where', text: rowLabel(on.path, on.row) }) : null,
      h('button', { class: 'ghost close', title: 'Close (Esc)', 'aria-label': 'Close the thread', onclick: function () { setDrawer(false); } }, icon('close'))),
    quote ? h('div', { class: 'line-quote', text: quote.text.trim() || ' ' }) : null,
    list,
    composerEl(on));
}

/**
 * What a poll changes: the thread and the queue. The composer, its caret and
 * the open folds are left alone, so an answer arriving never touches what you type.
 */
function refreshThread() {
  var list = document.getElementById('thread');
  if (!list) return renderDrawer();
  list.classList.remove('swap');
  list.replaceChildren();
  fillThread(list);
  var q = document.getElementById('queue');
  if (q) q.replaceWith(queueEl());
}

function fillThread(list) {
  var on = cursorOn();
  (on ? threadFor(on.path, on.row) : threadFor(null)).forEach(function (c) { list.append(turnEl(c)); });
}

var CTX_SHOWN = 5;
function ctxEl(ref) {
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
    h('div', { class: 'snippet' }, ref.tokens.map(function (toks, i) {
      return h('div', {}, h('span', { class: 'no', text: ref.start + i }), h('span', { class: 'src' }, paint(toks)));
    })));
}

function turnEl(c) {
  var reply = null;
  if (c.asking) {
    reply = h('div', { class: 'reply pending' }, 'Reading the code to answer',
      c.askedAt ? h('span', { class: 'ask-clock', 'data-since': c.askedAt, text: mmss(Date.now() + clockOffset - c.askedAt) }) : null);
  } else if (c.failed) {
    reply = h('div', { class: 'reply failed' }, h('span', { text: c.answer }),
      h('button', { onclick: function () { api('POST', 'comments/' + c.id, { retry: true }).then(function () { load(); }); } }, icon('refresh'), 'Ask again'));
  } else if (c.answer) {
    reply = h('div', { class: 'reply' }, h('span', { class: 'sr', text: 'The agent answered: ' }), prose(c.answer));
  }
  var real = c.id !== 'pending';
  var tools = real ? h('div', { class: 'tools' },
    c.kind === 'question' && !c.asking ? h('button', { class: 'ghost', title: 'Still unsure: make it a concern for the author', onclick: function () { raise(c); } }, icon('raise'), 'Raise') : null,
    deleteEl(c)) : null;
  return h('div', { class: 'turn ' + c.kind },
    h('div', { class: 'ask' }, icon(c.kind),
      h('span', {}, h('span', { class: 'sr', text: c.kind === 'question' ? 'You asked: ' : 'Concern: ' }), c.body,
        c.sent ? h('span', { class: 'sent', text: ' · sent' }) : null,
        c.kind === 'concern' && c.asked ? h('span', { class: 'sent', text: ' · raised from a question' }) : null)),
    reply,
    tools);
}

/** Delete asks once more in place: no dialog, and no way to lose a thread to a stray click. */
function deleteEl(c) {
  var label = h('span', { class: 'sr' });
  var b = h('button', { class: 'ghost', title: 'Delete', 'aria-label': 'Delete ' + c.kind + ': ' + c.body.slice(0, 80) }, icon('trash'), label);
  var timer;
  b.addEventListener('click', function () {
    if (!b.classList.contains('armed')) {
      b.classList.add('armed');
      label.className = '';
      label.textContent = 'Delete?';
      timer = setTimeout(function () { b.classList.remove('armed'); label.className = 'sr'; label.textContent = ''; }, 3000);
      return;
    }
    clearTimeout(timer);
    api('DELETE', 'comments/' + c.id).then(function () { return load(); }).then(focusComposer);
  });
  return b;
}

/** Raise a question: the composer turns to a concern, seeded with it, for you to say what should change. */
function raise(c) {
  var key = threadKey(cursorOn());
  kinds[key] = 'concern';
  raising[key] = c.id;
  drafts[key] = c.body;
  saveDrafts();
  renderDrawer();
  focusComposer();
}

/** Answer text: backticks as code, file:line as a link to that line when the review shows it. */
var CITE = new RegExp(BQ + '([^' + BQ + '\\n]+)' + BQ + '|((?:[\\w.-]+/)*[\\w.-]+\\.[A-Za-z]{1,5}):(\\d+)(?:[-–]\\d+)?', 'g');
var CITE_IN = /^((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]{1,5}):(\d+)/;
/** An answer's light markdown: paragraphs, - bullets and **bold**, around the cited code. */
function prose(text) {
  var frag = document.createDocumentFragment();
  text.trim().split(/\n\s*\n/).forEach(function (block) {
    var list = null, para = null;
    block.split('\n').forEach(function (line) {
      var item = /^\s*[-*]\s+(.*)$/.exec(line);
      if (item) {
        para = null;
        if (!list) frag.append(list = h('ul'));
        list.append(h('li', null, bold(item[1])));
      } else {
        list = null;
        if (para) add(para, ['\n', bold(line)]);
        else frag.append(para = h('p', null, bold(line)));
      }
    });
  });
  return frag;
}

function bold(text) {
  return text.split(/\*\*(.+?)\*\*/).map(function (part, i) { return i % 2 ? h('strong', null, cites(part)) : cites(part); });
}

function cites(text) {
  var frag = document.createDocumentFragment();
  var last = 0, m;
  CITE.lastIndex = 0;
  while ((m = CITE.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1] != null) {
      var inner = CITE_IN.exec(m[1]);
      frag.append((inner && citeEl(m[1], inner[1], Number(inner[2]))) || h('code', { text: m[1] }));
    } else {
      frag.append(citeEl(m[0], m[2], Number(m[3])) || h('code', { text: m[0] }));
    }
    last = CITE.lastIndex;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

/** Where a cited line is drawn: its path, row, and the section to show it in. */
function resolveCite(file, line) {
  var path = Object.keys(data.files).find(function (p) { return p === file || p.slice(-file.length - 1) === '/' + file; });
  if (!path) return null;
  var rows = data.files[path].rows;
  var row = rows.findIndex(function (r) { return r.new === line; });
  if (row < 0) row = rows.findIndex(function (r) { return r.old === line; });
  if (row < 0) return null;
  var shows = function (i) { return data.sections[i].files.some(function (f) { return f.path === path && f.windows.some(function (w) { return row >= w[0] && row <= w[1]; }); }); };
  var has = function (i) { return data.sections[i].files.some(function (f) { return f.path === path; }); };
  var at = shows(current) ? current : owner(path, row) >= 0 ? owner(path, row) : data.sections.findIndex(function (_, i) { return shows(i); });
  if (at < 0 && has(current)) at = current;
  return at < 0 ? null : { path: path, row: row, section: at };
}

function citeEl(label, file, line) {
  var at = resolveCite(file, line);
  if (!at) return null;
  // a link, not a button: a button wraps as one block, so a long cite would stand alone on its lines
  return h('a', { class: 'cite', href: '#', title: 'Show ' + label + ' in the code', onclick: function (e) { e.preventDefault(); jump(at); } }, label);
}

/** Show a cited line. In this section the thread stays put and the line flashes; elsewhere the cursor goes there. */
function jump(at) {
  if (at.section !== current) { go(at.section); setCursor(at.path, at.row, true); return; }
  function found() { return document.querySelector('#stage .row[data-path="' + CSS.escape(at.path) + '"][data-row="' + at.row + '"]'); }
  if (!found()) { folded[viewKey(at.path)] = false; renderStage(); }
  if (!found()) { unfolded[at.path] = true; renderStage(); }
  document.querySelectorAll('#stage .row[data-path="' + CSS.escape(at.path) + '"][data-row="' + at.row + '"]').forEach(function (el, i) {
    if (i === 0) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  });
}

function composerEl(on) {
  var key = threadKey(on);
  var kind = kinds[key] || 'question';
  var raised = raising[key];
  var area = h('textarea', {
    id: 'composer', rows: 1,
    'aria-label': kind === 'question' ? 'Question' : 'Concern',
    placeholder: kind === 'question' ? 'What do you want to understand?' : 'What should change?',
  });
  area.value = drafts[key] || '';
  function grow() { area.style.height = 'auto'; area.style.height = Math.min(area.scrollHeight + 2, 240) + 'px'; }
  requestAnimationFrame(grow);
  area.addEventListener('input', function () {
    if (area.value) drafts[key] = area.value; else delete drafts[key];
    saveDrafts();
    grow();
  });
  var send = h('button', { class: 'primary', onclick: submit }, kind === 'question' ? 'Ask' : raised ? 'Raise' : 'Add', h('kbd', { text: '⌘↵', 'aria-hidden': 'true' }));
  function submit() {
    var text = area.value.trim();
    if (!text || sending) return;
    // Cleared before the request, so a second ⌘↵ has nothing to send.
    sending = true;
    send.disabled = true;
    area.value = '';
    delete drafts[key];
    saveDrafts();
    grow();
    var req;
    if (raised) {
      delete raising[key];
      kinds[key] = 'question';
      req = api('POST', 'comments/' + raised, { body: text });
    } else {
      var body = { section: current, kind: kind, body: text };
      if (on) { body.path = on.path; body.row = on.row; }
      // The turn shows at once; the next load replaces it with the stored one.
      data.comments.push(Object.assign({ id: 'pending', asking: kind === 'question', askedAt: Date.now() + clockOffset }, body));
      refreshThread();
      req = api('POST', 'comments', body);
    }
    req.then(function () { return load(); }).finally(function () {
      sending = false;
      if (raised) renderDrawer(); else send.disabled = false;
      focusComposer();
    });
  }
  area.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { area.blur(); }
    e.stopPropagation();
  });
  function pick(k) {
    kinds[key] = k;
    if (k === 'question') delete raising[key];
    renderDrawer();
    var radio = document.querySelector('.kinds [aria-checked="true"]');
    if (radio) radio.focus();
  }
  var kindsEl = h('div', { class: 'kinds', role: 'radiogroup', 'aria-label': 'Kind' }, ['question', 'concern'].map(function (k) {
    return h('button', {
      class: k + (kind === k ? ' on' : ''), role: 'radio', 'aria-checked': kind === k ? 'true' : 'false', tabindex: kind === k ? '0' : '-1',
      onclick: function () { pick(k); area.focus(); },
    }, icon(k), k === 'question' ? 'Question' : 'Concern');
  }));
  kindsEl.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation();
      pick(kind === 'question' ? 'concern' : 'question');
    }
  });
  var hint = raised
    ? 'Say what should change. Your question and the agent’s answer go with it.'
    : kind === 'question'
      ? 'Answered here by the agent, citing the code. Never sent to the author.'
      : 'Something to fix. Queued below and sent to the author together.';
  return h('div', { class: 'composer' }, kindsEl, area,
    h('div', { class: 'actions' }, h('span', { class: raised ? 'raising' : 'hint', text: hint }), send));
}

function focusComposer() {
  if (!drawerOpen) setDrawer(true);
  var a = document.getElementById('composer');
  if (!a) return;
  a.focus();
  a.setSelectionRange(a.value.length, a.value.length);
}

function pendingConcerns() { return data.comments.filter(function (c) { return c.kind === 'concern' && !c.sent; }); }

function queueEl() {
  var pending = pendingConcerns();
  var box = h('div', { class: 'queue', id: 'queue' },
    h('div', { class: 'queue-bar' },
      h('span', { class: 'count' }, pending.length ? h('b', { text: String(pending.length) }) : null,
        pending.length ? ' concern' + (pending.length > 1 ? 's' : '') + ' to send' : 'No concerns to send'),
      h('button', { class: 'send', disabled: !pending.length, onclick: send }, icon('send'), 'Send to the author')));
  if (pending.length) {
    box.append(h('ol', { 'aria-label': 'Concerns to send' }, pending.map(function (c) {
      var where = c.path ? rowLabel(c.path, c.row) : sec(c.section);
      return h('li', {}, h('button', { onclick: function () { goTo(c); } },
        h('span', { class: 'loc', text: sec(c.section) + ' · ' + where }),
        h('span', { class: 'txt', text: c.body })));
    })));
  }
  return box;
}

/* ── behaviour ── */
/**
 * The two ways to read the change. Each says what it walks (its steps), draws
 * the list below the rail's head, the stage and the drawer (the plain diff has
 * none), and says what a poll redraws: the sections redraw
 * the code and the thread, never the composer, so an answer arriving does not
 * move the caret, the selection or an open fold; the plain diff stands still.
 */
var VIEWS = {
  plain: { label: 'Files', steps: fileSteps, tally: function () { return null; }, rail: plainRail, stage: plainStage, drawer: null, poll: function () {} },
  sections: {
    label: 'Sections', steps: sectionSteps, tally: function () { return [data.checked.length, data.sections.length]; },
    rail: sectionsRail, stage: sectionStage, drawer: sectionDrawer,
    poll: function () { if (document.getElementById('thread')) { renderStage(); refreshThread(); } else render(); },
  },
};

function render() {
  if (!data) return;
  renderRail();
  renderStage();
  renderDrawer();
  syncDrawer();
}

/** Open or close the thread drawer. The code reflows to the new width, so the cursor line is kept in view. */
function setDrawer(open) {
  if (open && !VIEWS[view].drawer) return;
  drawerOpen = open;
  syncDrawer();
  var el = document.querySelector('#stage .row.cursor');
  if (el) el.scrollIntoView({ block: 'nearest' });
}
// A view without a drawer (the plain diff) never shows one.
function syncDrawer() { app.classList.toggle('drawer-open', drawerOpen && !!VIEWS[view].drawer); }

/** Rows in reading order: side by side puts a removed run's lines before the added ones, though they sit level. */
function visibleRows() {
  var out = [];
  document.querySelectorAll('#stage .code').forEach(function (box) {
    if (!box.offsetParent) return;
    out = out.concat(Array.prototype.slice.call(box.querySelectorAll('.row')).sort(function (a, b) { return a.dataset.row - b.dataset.row; }));
  });
  return out;
}

/* ── drawer width ── */
// Null means the breakpoint's default; a drag or w pins a width, kept per browser.
var app = document.querySelector('.app');
var grip = document.getElementById('grip');
var drawerW = null;
var WIDE = 0.55;          // w opens the drawer to this share of the window
try { drawerW = Number(localStorage.getItem('fw-review-inspector')) || null; } catch (e) {}
// The code keeps room to read, the drawer room for its own head.
var CODE_MIN = 480;
function clampW(w) {
  var strip = parseFloat(getComputedStyle(app).getPropertyValue('--strip-w')) || 0;
  return Math.round(Math.max(280, Math.min(w, innerWidth - strip - CODE_MIN)));
}
function currentW() { return document.getElementById('drawer').getBoundingClientRect().width; }
function setDrawerW(w, keep) {
  drawerW = w == null ? null : clampW(w);
  if (drawerW == null) app.style.removeProperty('--drawer-w');
  else app.style.setProperty('--drawer-w', drawerW + 'px');
  grip.setAttribute('aria-valuenow', String(Math.round(currentW())));
  grip.setAttribute('aria-valuemax', String(clampW(Infinity)));
  if (keep === false) return;
  try {
    if (drawerW == null) localStorage.removeItem('fw-review-inspector');
    else localStorage.setItem('fw-review-inspector', String(drawerW));
  } catch (e) {}
}
function toggleWide() {
  var wide = clampW(innerWidth * WIDE);
  setDrawerW(currentW() >= wide - 8 ? null : wide);
}
setDrawerW(drawerW, false);
grip.setAttribute('aria-valuemin', '280');
addEventListener('resize', function () { if (drawerW != null) setDrawerW(drawerW, false); });
grip.addEventListener('pointerdown', function (e) {
  if (e.button !== 0) return;
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  grip.classList.add('dragging');
  document.body.classList.add('resizing');
  var startX = e.clientX, startW = currentW();
  function move(ev) { setDrawerW(startW + startX - ev.clientX, false); }
  function up() {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    grip.classList.remove('dragging');
    document.body.classList.remove('resizing');
    setDrawerW(drawerW);
  }
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
});
grip.addEventListener('dblclick', function () { setDrawerW(null); });
grip.addEventListener('keydown', function (e) {
  var step = e.shiftKey ? 80 : 20;
  if (e.key === 'ArrowLeft') setDrawerW(currentW() + step);
  else if (e.key === 'ArrowRight') setDrawerW(currentW() - step);
  else if (e.key === 'Home') setDrawerW(null);
  else return;
  e.preventDefault();
  e.stopPropagation();
});

function setLayout(next) {
  if (next === layout) return;
  layout = next;
  try { localStorage.setItem('fw-review-layout', layout); } catch (e) {}
  renderStage();
  var el = document.querySelector('#stage .row.cursor');
  if (el) el.scrollIntoView({ block: 'center' });
}

/** A line's gutter mark: a draft, a question being read, a failed answer, a concern, or a thread. */
function dotFor(path, row) {
  var thread = lineComments(path, row);
  var cls = thread.some(function (c) { return c.failed; }) ? ' failed'
    : thread.some(function (c) { return c.asking; }) ? ' pending'
    : thread.some(function (c) { return c.kind === 'concern'; }) ? ' concern'
    : thread.length ? '' : drafts[path + ':' + row] ? ' draft' : null;
  return cls === null ? null : h('span', { class: 'dot' + cls });
}

function refreshDot(path, row) {
  document.querySelectorAll('#stage .row[data-path="' + CSS.escape(path) + '"][data-row="' + row + '"]').forEach(function (el) {
    var old = el.querySelector('.dot');
    var dot = dotFor(path, row);
    if (old) old.remove();
    if (dot) el.prepend(dot);
  });
}

/** The next line with a thread, after (or before) the cursor. */
function nextThread(step) {
  var rows = visibleRows();
  var at = cursor ? rows.findIndex(function (el) { return el.dataset.path === cursor.path && Number(el.dataset.row) === cursor.row; }) : -1;
  for (var i = at < 0 && step < 0 ? rows.length - 1 : at + step; i >= 0 && i < rows.length; i += step) {
    if (rows[i].querySelector('.dot:not(.draft)')) { setCursor(rows[i].dataset.path, Number(rows[i].dataset.row), true); return setDrawer(true); }
  }
  toast(step > 0 ? 'No thread below in this section' : 'No thread above in this section');
}

function setCursor(path, row, scroll) {
  var was = cursor;
  cursor = { path: path, row: row };
  if (was) refreshDot(was.path, was.row);
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
  else renderDrawer();
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

/**
 * Switch between the plain diff and the sections, keeping the line you are on:
 * into the sections, to the one that owns it.
 */
function setView(next) {
  if (next === view || !data.sections) return;
  view = opensOn = next;
  try { localStorage.setItem('fw-review-view', next); } catch (e) {}
  var own = cursor ? owner(cursor.path, cursor.row) : -1;
  if (view === 'sections' && own >= 0 && own !== current) { current = own; history.replaceState(null, '', '#' + num(own)); }
  render();
  document.getElementById('stage').scrollTop = 0;
  if (cursor) setCursor(cursor.path, cursor.row, true);
}

function go(i) {
  if (view !== 'sections' || i < 0 || i >= data.sections.length) return;
  current = i; cursor = null;
  history.replaceState(null, '', '#' + num(i));
  render();
  document.getElementById('stage').scrollTop = 0;
}

function toggleChecked() {
  if (view !== 'sections') return;
  var on = data.checked.indexOf(current) < 0;
  api('POST', 'check', { section: current, checked: on }).then(function (r) {
    data.checked = r.checked;
    if (on) {
      var next = data.sections.findIndex(function (_, i) { return i > current && data.checked.indexOf(i) < 0; });
      if (next < 0) next = data.sections.findIndex(function (_, i) { return data.checked.indexOf(i) < 0; });
      if (next >= 0) { toast(sec(current) + ' reviewed'); return go(next); }
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
  if (!data || e.metaKey || e.ctrlKey || e.altKey) return;
  var tag = e.target.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT') return;
  if (e.key === 'j') moveCursor(1);
  else if (e.key === 'k') moveCursor(-1);
  else if (e.key === 'n') go(current + 1);
  else if (e.key === 'p') go(current - 1);
  else if (e.key === 'x') toggleChecked();
  else if (e.key === 's') setLayout(layout === 'split' ? 'inline' : 'split');
  else if (e.key === 'v') setView(view === 'plain' ? 'sections' : 'plain');
  else if (e.key === 't') setDrawer(!drawerOpen);
  else if (e.key === 'w') { if (drawerOpen) toggleWide(); else setDrawer(true); }
  else if (e.key === 'l') { if (pinned && !narrow.matches) togglePin(); else setRail(!railOpen); }
  else if (e.key === 'L') togglePin();
  else if (e.key === 'c') focusComposer();
  else if (e.key === 'C') { kinds[threadKey(cursorOn())] = 'concern'; renderDrawer(); focusComposer(); }
  else if (e.key === ']') nextThread(1);
  else if (e.key === '[') nextThread(-1);
  else if (e.key === 'g' && landed) { var c = landed; landed = null; goTo(c); }
  else if (e.key === 'Escape') { if (railOpen) setRail(false); else if (drawerOpen) setDrawer(false); else { cursor = null; render(); } }
  else return;
  e.preventDefault();
});

load(true);
setInterval(checkStale, 30000);
// How long each question has been with the agent, ticking in place.
setInterval(function () {
  document.querySelectorAll('.ask-clock').forEach(function (el) { el.textContent = mmss(Date.now() + clockOffset - Number(el.dataset.since)); });
}, 1000);
`;
