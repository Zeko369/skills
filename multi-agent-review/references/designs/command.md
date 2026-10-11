# Design: command

`assets/themes/command.html`, rendered as `command.html`. A dark three-pane console that combines the triage list with board and matrix views. Use it to work through every finding of any review: single PR, branch, stack, plan, or document.

## Layout

- **Top bar:** title, status, search, presets (Actionable, Blocking, Disagreements, Everything), and **Copy answers JSON** with a live fix/ignore count. Copy Markdown and Print sit in the list toolbar.
- **Left sidebar:** a **Your answers** block (the Fix/Ignore facet, bulk Fix/Ignore for every shown finding, Pinned only, Clear pins), the PR stack as a git graph with per-PR severity counts (only when `stack` is present), then severity, disposition, reviewer, confidence, and tag facets, section toggles, and the keyboard legend.
- **Center:** a **List | Board | Matrix** switcher, stored in the URL as `view=` (`''`, `board`, `matrix`). The `v` key cycles views.
  - **List:** dense rows grouped by PR, severity, or disposition.
  - **Board:** disposition columns × swimlanes, PR swimlanes by default for stacks. Columns and lanes fold, and the fold state is saved per report.
  - **Matrix:** a PR × severity heat grid (click a cell to filter to it; click a row header for that PR only) and a "who found what" findings × reviewers table that highlights findings every reviewer raised.
- **Right pane:** Finding/Report tabs. The finding shows the **Your answer** block (Fix / Ignore and a comment) before the evidence. Drag the pane's left edge to widen it; `f` or the header button makes it full screen, with the answer in a side rail. Below 1180px it becomes an overlay sheet in the board and matrix views, and list rows carry their own answer block when expanded.
- **Answers everywhere:** ignored findings are muted with an Ignored tag, and commented ones get a Comment tag, in list rows, board cards, and the who-found-what table. Heat-grid cells count their ignored findings.

## What the report needs

- A short, scannable `title` for every finding; board cards truncate long titles.
- `reviewers` on each finding that use the exact reviewer `name`s, so the matrix and reviewer facet line up.
- A `pr` on each stacked finding; otherwise matrix rows and swimlanes fall into "No PR".
- `tags`, when available, to add a useful facet.

## Inspect before delivering

1. The page loads with no console errors, and an `incomplete` status shows the hazard styling.
2. All three views render, the stack graph matches the real parent/fork structure, and the heat grid totals equal the finding count.
3. Ignoring a finding and commenting on it updates the counts and the copied JSON, the drawer resizes and goes full screen, and `?` opens the cheatsheet.
4. Selecting a finding shows its full evidence in the detail pane, and the page has no horizontal overflow at 390px.

## Limits

- Between about 1180 and 1270px the board scrolls inside its own container.
- Printing from the board or matrix view switches to the list only when the browser fires `beforeprint` (normal Print does; some headless PDF exports do not).
- The "Spans several PRs" matrix row filters to the union of those PRs, so the list also shows those PRs' single-PR findings.
