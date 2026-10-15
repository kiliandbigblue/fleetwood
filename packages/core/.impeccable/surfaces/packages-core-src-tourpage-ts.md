---
version: 1
slug: "packages-core-src-tourpage-ts"
primary_target: "packages/core/src/tourPage.ts"
related_targets: []
---

# Review page

Scope: the fleetwood review page (`packages/core/src/tourPage.ts`), served by `tour.ts`. Visitor mode: Operate.

Audience and job: Kilian reading one change section by section, on a big browser window, often interrupted. Success: never loses his place, reads code in context, leaves Questions/Concerns without leaving the code.

Constraints: single inline HTML/CSS/vanilla JS, no template literals in the script, no network; GitHub Dark default (Primer) throughout, whatever the panel's theme. The diff reads like a GitHub pull request: file cards with a fold chevron, copy, +/- squares and Viewed, system mono at 12px/20px, 50px number gutters, @@ hunk rows, GitHub dark's diff tints and syntax colours on the theme's ground; never decorated.

## Direction contract

THESIS: Code first. The code gets the window: a slim § strip on the left, the section's summary and context above its code, and the conversation in a drawer that opens only when there is one to have. Refuses GitHub's file stack with comment cards wedged between lines, and refuses permanent side columns that squeeze split view below ~90 chars a side.

OWN-WORLD: GitHub Dark default's roles (canvas #0d1117, muted #151b23, borders #3d444d), `panel` for strip, list and drawer, `edge` hairlines, accent only for where you are. Fira Code for section titles, the system mono (GitHub's stack) for code and chrome, a sans only for prose. Diff rows tinted in GitHub dark's green, red and hunk blue, the number cell stronger than the line, word-level highlights, syntax in GitHub dark's colours (red keywords, light-blue strings, purple functions, orange types, grey comments).

STORY: The page opens on the first section not yet reviewed. He reads the summary once, then the code top to bottom with j/k. `c`, `]`/`[`, a click on a line with a thread, or `t` opens the thread drawer beside the code; it follows the cursor while open and Esc closes it. `x` marks the section reviewed and moves on; concerns pile up ("N to send" in the header) and go in one send from the drawer's foot.

FIRST VIEWPORT: Left strip (56px): the list toggle, "0/8", then one § number per section with its state icon, the current one lit, its title on hover. `l` opens the full list over the code (repo vs base, scope, plain/sections, progress bar, § titles, keys). Centre (fluid): section title in Fira Code ~20px with "N to send", Inline/Split and "Mark reviewed x"; the summary at ≤75ch, "Context it leans on" folded; then the file blocks. Right drawer (~400px, resizable, w widens), only when open: the line's thread, composer, and at the foot the concern queue and Send.

FORM: Code-first workbench. Signature interaction: lines with threads carry a gutter dot; reaching one with ] opens the drawer on its thread.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
