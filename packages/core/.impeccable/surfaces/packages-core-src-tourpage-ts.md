---
version: 1
slug: "packages-core-src-tourpage-ts"
primary_target: "packages/core/src/tourPage.ts"
related_targets: []
---

# Review page

Scope: the fleetwood review page (`packages/core/src/tourPage.ts`), served by `tour.ts`. Visitor mode: Operate.

Audience and job: Kilian reading one change section by section, on a big browser window, often interrupted. Success: never loses his place, reads code in context, leaves Questions/Concerns without leaving the code.

Constraints: single inline HTML/CSS/vanilla JS, no template literals in the script, no network; colour only from fleetwood's palette roles; all themes dark. Diff must be elegant (difit-grade), never GitHub/difit grey chrome, never decorated.

## Direction contract

THESIS: A workbench, not a stack of file cards: the centre column is clean code read in order, and everything about the code (summary, context, conversation) lives in an inspector that follows the cursor. Refuses GitHub's file stack with comment cards wedged between lines.

OWN-WORLD: Fleetwood's world: Rosé Pine roles on a dark ground, `panel` for rail and inspector, `edge` hairlines, accent only for where you are. Fira Code for code and section titles, the system mono for chrome, a sans only for prose. Diff rows tinted at low alpha with a 2px sign bar, word-level highlights, syntax coloured from the roles (branch keywords, warn strings, accent functions, ok types, dim comments).

STORY: The page opens on the first section not yet reviewed. He reads it top to bottom with j/k; the inspector shows the section summary, its context refs and the thread of the line under the cursor. `c` writes a Question or Concern there; questions get answered in place. `x` marks the section reviewed and moves to the next one; concerns pile up in a queue he sends in one go.

FIRST VIEWPORT: Left rail (~248px): repo vs base, a segmented progress bar, the § list with check marks, the current one lit. Centre (fluid): "§3 of 6" kicker, section title in Fira Code ~20px, then the file blocks: a slim path line, then code. Right inspector (~380px): summary, folded context refs, the cursor line's thread with composer, and at the foot the concern queue and Send. The primary action, "Mark reviewed x", sits in the centre header.

FORM: Three-pane workbench; third on my ranked list of seven; seed key a8a27e88. Signature interaction: the inspector follows the cursor, so lines with threads carry a gutter dot and j/k swaps the thread in about 150ms.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
