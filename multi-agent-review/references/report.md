# HTML report contract

The coordinator assembles `report.json` from the actual reviewer outputs and its own validation. Keep raw provider files next to it when useful. This is a lightweight rendering format, not a claim that all harnesses return this JSON natively.

Required top-level fields:

- `title`, `verdict`, `summary`, `generated_at`: plain strings.
- `status`: `complete`, `incomplete`, or `setup`. Complete means every requested reviewer finished against the same verified target snapshot, not that the change is defect-free. Missing, failed, stale, or mismatched coverage requires incomplete. Setup is only for configuration walkthroughs.
- `snapshot_id` (nonempty string) and `snapshot_verified` (boolean): required for complete reports. Use the manifest/content hash, and set verification true only after checking the actual inputs before synthesis. Omit or leave unverified in setup/incomplete reports when unavailable.
- `target`: object of human-readable labels to strings, including repository/workspace, exact SHA/hash, comparison, scope, and snapshot/drift verification where relevant.
- `reviewers`: one entry per requested reviewer, with `name`, `model`, `effort`, `transport`, `status`, `provenance`. States: `completed`, `failed`, `timed_out`, `unavailable`, `not_run`, `cancelled`, `running`, `stale`. Each requires matching `snapshot_id` and `snapshot_verified: true` for a complete report; these attest to start/end verification, not merely the requested hash. Put requested vs actual model settings in provenance. Optional `run_id`, `round`, `limitations`, `output` (plain text), `provider_status` (actual terminal state). Summarize valid coverage across rounds in that reviewer entry and preserve earlier outputs in separate round directories.
- `findings`: array, empty when no supported candidates exist. Each finding requires `id`, `title`, `severity` (`P0`-`P3`), `disposition` (`confirmed`, `disputed`, `rejected`, `needs validation`), `location`, `trigger`, `impact`, `evidence`, `recommendation`, `confidence`, `reviewers` (array of names), and `decision`. Optional `validation` records limitations. Preserve rejected candidates when they explain a material disagreement.
- `checks`, `gaps`, `next_steps`: arrays of plain strings. Distinguish static inspection, local tests, CI, deployed checks, and manual/device testing.

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

Use `assets/example-report.json` as a structural starting point, replacing all setup content with actual review evidence. Generate the page:

```sh
python3 /path/to/multi-agent-review/scripts/render_report.py report.json --output review.html
```

The file works offline and can be served locally for T3 preview. Inspect the rendered page, including narrow layout, search/disposition filters, empty results, expandable evidence, and visible incomplete states. A short final message links to the HTML; do not substitute a Markdown report for the page.
