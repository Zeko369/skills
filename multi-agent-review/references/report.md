# HTML report contract

The coordinator assembles `report.json` from the actual reviewer outputs and its own validation. Keep raw provider files next to it when useful. This is a lightweight rendering format, not a claim that all harnesses return this JSON natively.

Required top-level fields:

- `title`, `verdict`, `summary`, `generated_at`: plain strings.
- `status`: `complete`, `incomplete`, or `setup`. Complete means every requested reviewer finished against the same verified target snapshot, not that the change is defect-free. Missing, failed, stale, or mismatched coverage requires incomplete. Setup is only for configuration walkthroughs.
- `snapshot_id` (nonempty string) and `snapshot_verified` (boolean): required for complete reports. Use the manifest/content hash, and set verification true only after checking the actual inputs before synthesis. Omit or leave unverified in setup/incomplete reports when unavailable.
- `target`: object of human-readable labels to strings, including repository/workspace, exact SHA/hash, comparison, scope, and snapshot/drift verification where relevant.
- `reviewers`: one entry per requested reviewer, with `name`, `model`, `effort`, `transport`, `status`, `provenance`. States: `completed`, `failed`, `timed_out`, `unavailable`, `not_run`, `cancelled`, `running`, `stale`. Each requires matching `snapshot_id` and `snapshot_verified: true` for a complete report; these attest to start/end verification, not merely the requested hash. Put requested vs actual model settings in provenance. Optional `run_id`, `round`, `limitations`, `output` (plain text), `provider_status` (actual terminal state). Summarize valid coverage across rounds in that reviewer entry and preserve earlier outputs in separate round directories.
- `findings`: array, empty when no supported candidates exist. Each finding requires `id`, `title`, `severity` (`P0`-`P3`), `disposition` (`confirmed`, `disputed`, `rejected`, `needs validation`), `location`, `trigger`, `impact`, `evidence`, `recommendation`, `confidence`, `reviewers` (array of names), and `decision`. Optional `validation` records limitations, `pr` (one stack id) or `prs` (several stack ids) attributes the finding to stacked PRs, and `tags` (array of short strings such as `security` or `api-contract`) adds a filter facet. Preserve rejected candidates when they explain a material disagreement.
- `checks`, `gaps`, `next_steps`: arrays of plain strings. Distinguish static inspection, local tests, CI, deployed checks, and manual/device testing.

## Stacked pull requests

When the target is a stack of PRs, add an optional top-level `stack` array, listed from the bottom of the stack upward. Each entry requires `id` (stable string such as `pr-412`) and `title`; optional fields are `number`, `url` (HTTP(S)), `branch`, `base` (the branch it targets), `parent` (another entry's `id`, or `null` for a PR on trunk), `head` (reviewed SHA), `status` (`open`, `draft`, …), `additions`, `deletions`, and `changed_files`. Parents must exist and must not form a cycle; branching stacks (two PRs on the same parent) are allowed. A single PR may be given as a one-entry `stack` to record its number, branch, and head. The pages then treat it as the review target instead of a stack: no stack views, PR filter, or PR grouping. The renderer adds its number, title, branch, and head to Target, and its `url` to Sources.

Attribute each finding to the PR that introduces the root cause with `pr`. Use `prs` only when the defect exists solely because several PRs combine, and explain that in `decision`. A finding without `pr`/`prs` in a stacked report appears under "Not tied to a PR". Review each PR against its parent branch, record every PR's head SHA in `stack` and `target`, and keep the snapshot rules above for the whole stack.

The page shows the hierarchy, per-PR severity counts, and a PR filter. "Include lower PRs" adds findings from every ancestor of the selected PR, answering "what affects this PR if I merge it?".

## Optional context

Optional `notes` is an array of `{ "title": "...", "body": "..." }`; optional `sources` is an array of `{ "title": "...", "url": "https://..." }`. Source links accept HTTP(S) only. Put local paths/line references in `location` or evidence text; use immutable GitHub blob links in sources when available. The renderer escapes all content and renders snippets as text, not raw HTML or Markdown.

For findings affected by source drift, use `needs validation` and explain the original/observed hashes in `decision` and `validation`; do not count them as confirmed on a newer target. A historical review can remain complete for its preserved original snapshot, provided the page clearly names that snapshot and makes no claim about later edits.

Example finding:

```json
{
  "id": "F-001",
  "title": "Concurrent updates can overwrite the newer value",
  "severity": "P1",
  "disposition": "needs validation",
  "location": "src/cache.ts:42-49 at <reviewed SHA>",
  "trigger": "Two requests update the same key before either write finishes.",
  "impact": "The older result may replace the newer value.",
  "evidence": "Both calls read the version before awaiting the write; include the actual source excerpt here.",
  "recommendation": "Make the version check and write atomic.",
  "confidence": "medium",
  "reviewers": ["Claude"],
  "decision": "Plausible from inspection; a concurrency reproduction is still required.",
  "validation": "No executable reproduction yet. This is an illustrative example."
}
```

## Render

Use `assets/example-report.json` (single target, no findings) or `assets/example-stack-report.json` (stacked PRs with findings) as a structural starting point, replacing all illustrative content with actual review evidence. Render every trial design plus an `index.html` chooser:

```sh
python3 /path/to/multi-agent-review/scripts/render_report.py report.json --output-dir review/            # command, train, focus
python3 /path/to/multi-agent-review/scripts/render_report.py report.json --output-dir review/ --themes train,command
python3 /path/to/multi-agent-review/scripts/render_report.py report.json --output review.html --theme focus
```

Trial designs, each documented in `references/designs/`:

- [`command`](designs/command.md): dark console with list, board, and matrix views.
- [`train`](designs/train.md): stack-first merge readiness, a merge plan, and per-PR dossiers.
- [`focus`](designs/focus.md): a one-finding-at-a-time review queue for answering every finding.

Older designs, available by name: `triage` (default for `--output`; dark three-pane console) and `board` (Swiss-style board with disposition columns and per-PR swimlanes).

Every design supports client-side filtering:

- Search, plus severity, disposition, reviewer, PR, confidence, tag, and answer facets with live counts. Shift-click shows only one value; for PR controls, a click shows only that PR and shift-click adds it.
- Presets: Actionable, Blocking, and Disagreements.
- Grouping and sorting.
- **Answers:** every finding starts as Fix, except coordinator-rejected findings, which start as Ignore. The user flips findings to Ignore (or back), one at a time or for every shown finding, and can leave a comment on any finding.
- Pins, answers, and comments are stored only in that browser's localStorage, keyed by report, so every design rendered from one `report.json` shares them.
- A detail drawer the user can drag wider (the width is remembered) or make full screen with `f`.
- Show or hide page sections, and expand or collapse findings.
- **Copy answers** copies the answers JSON described below. Copy Markdown copies the filtered findings.
- The filter state is stored in the URL hash, so a link reopens the same view.

Keyboard (press `?` for the cheatsheet): `j`/`k` move, `f` full-screen the open finding, `/` search, `o` expand inline details. While a finding's drawer is open, `a` sets Fix, `i` or `r` set Ignore, `x` toggles, `c` comments, and `p` pins. `Esc` leaves a text field, then full screen, then closes the finding. Designs add their own keys, documented in their notes and in the cheatsheet.

### Answers JSON

`format` is `multi-agent-review/answers@1`. `instructions` tells the fixing agent what to do, and `report` identifies the review: title, verdict, status, `generated_at`, `snapshot_id`, `key`, and `target`. `stack` lists PRs bottom-up with their branch and head. `counts` gives totals. `fix` lists approved findings in stack order with the full finding fields, plus the user's `comment` when present. `ignore` lists the rest, each with `decided_by` (`you`, or the default for rejected findings) and any comment. See "Apply review answers" in `SKILL.md` for how to act on it.

The files are self-contained and work offline; they can be served locally for T3 preview. Report data is embedded as inert JSON and rendered with text nodes only. Inspect each rendered page against its design checklist: narrow layout, filters and empty results, expandable evidence, the stack hierarchy when present, and visible incomplete states. A short final message links to the pages; do not substitute a Markdown report for them.
