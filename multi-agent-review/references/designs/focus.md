# Design: focus

`assets/themes/focus.html`, rendered as `focus.html`. A keyboard-first review queue that shows one finding at a time, so the user can work through every finding. Every finding starts as Fix (coordinator-rejected ones as Ignore); the user ignores what they do not want fixed, comments where needed, and copies the answers as JSON. Answers, comments, and pins stay in the browser and are shared with the other designs of the same report; the report itself is unchanged.

## Layout

- **Top:** a progress band ("5/13 reviewed", a bar where solid means reviewed and hatched means still on its default), review filter chips (All, To review, Reviewed, stored in the URL as `view=`), the shared Fix/Ignore facet, the answer summary, and **Copy answers JSON** as the primary action.
- **Left:** a queue of the visible findings in group order. Each row has Ignore and Pin buttons, an Ignored or comment marker, and a ✓/✕ marker that is filled once the user has reviewed the finding. Drag the queue's right edge to resize it; the finding column widens to match.
- **Center:** one finding with a large title, the impact as the lead, the **Your answer** block (Fix / Ignore and a comment box), then the trigger, evidence, correction, coordinator decision, and validation limits. A side column shows reviewer agreement ("2 of 3 reviewers"), confidence, tags, and a mini stack graph that highlights the finding's PR(s).
- **Full screen** (`f` or the strip button): hides the header, queue, and side column and centres the finding in a readable column, so `j`/`k` page through findings.
- **Overview** (shown on landing, also via `g`): verdict, status, metrics, the stack graph with reviewed/total per PR, reviewer cards, target, checks, gaps, next steps, notes, and sources. **Start review** opens the first finding not yet reviewed.
- **Mobile:** the queue is a slide-out panel, and a sticky bar keeps the answer controls and Next in reach.

A finding counts as reviewed once the user answers it, comments on it, or leaves it after having it open for a moment. Quickly holding `j` does not mark everything.

## Keys

The shared keys (`?` cheatsheet, `j`/`k`, `f` full screen, `a` fix, `i`/`r` ignore, `x` toggle, `c` comment, `p` pin, `/`, `o`, `Esc`) plus `n` next not reviewed, `z` undo the last answer (including bulk answers), and `g` overview. Answering never auto-advances; the user moves with `j`/`k`. Typing in the comment box never triggers shortcuts.

## Export

**Copy answers JSON** is the shared `multi-agent-review/answers@1` export (see `references/report.md`). The Export menu also offers **Copy answers as Markdown**, grouped into Fix and Ignore, with comments and "default, not reviewed" markers, and a reset of review progress. Earlier accept / won't-fix / defer decisions saved by older versions of this page are migrated once: accept → Fix, won't fix → Ignore, notes → comments.

## What the report needs

- Each finding's `impact`, written as a single-sentence lead: it is the largest text after the title.
- Finding `id`s that stay stable between reruns of the same review, so saved answers still match.
- Accurate `reviewers` per finding, which drive the agreement indicator.

## Inspect before delivering

1. The overview shows the verdict and status first, and an `incomplete` status uses the alarm styling.
2. Start review opens the first finding in queue order with complete evidence, and the queue count equals the visible finding count.
3. Full screen and the `?` cheatsheet open and close, and the page has no console errors and no horizontal overflow at 390px.

## Limits

- The shared count label and Copy Markdown button in the filter panel ignore the To review / Reviewed filter.
- Answers are local to one browser; they reach the agent only through Copy answers.
