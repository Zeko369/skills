# Design: train

`assets/themes/train.html`, rendered as `train.html`. A light, Swiss-style merge train built around the PR stack. It answers "what blocks merging this PR?". It is most useful for stacked PRs. A single PR or other single target has no train: the page opens on the findings, and a rail dossier shows that PR's metadata, readiness, and how readiness is derived.

## Layout

- **Header:** status tile, verdict, and a slim metrics row. An `incomplete` review adds a visible warning that a clear signal is not clearance.
- **The train:** the stack drawn as a subway map from trunk (left) to the top of the stack, with forks in their own lane. Every station shows its own vs inherited finding counts and a **readiness signal**:
  - **Blocked**: a P0/P1 finding that is confirmed or needs validation belongs to this PR or any PR below it.
  - **Attention**: not blocked, but a disputed finding, or a P2 that is confirmed or needs validation, applies.
  - **Clear**: neither condition applies. Rejected findings never count.
  - With zero findings, the station says "No findings recorded" rather than clear.

  Readiness uses every finding the user has not ignored and disregards other filters. It is labelled as derived from findings, not a merge decision.
- **Filter strip** (sticky): search, presets, **Copy answers**, and the Your answer, severity, disposition, and reviewer facets; More holds confidence, tags, grouping, bulk answers, and section toggles.
- **Station switcher:** a row of PR buttons above the findings, with a **Merge plan** toggle at its right.
- **Whole stack** (no station selected): all findings in groups across the full width. The numbered, bottom-up **merge plan** with a checklist per PR ("Fix F-002 before merging #412") is hidden by default; the toggle shows it as a left rail.
- **Station selected** (click; shift-click adds more): a dossier rail with PR metadata and readiness, and findings split into **Introduced in #N** and **Inherited from lower PRs**. Presets and Clear filters keep the selected station; **Whole stack** or the trunk leaves it.
- **Drawer:** rows open a detail drawer with the finding's merge impact and evidence. Drag its left edge to widen it (double-click resets). A docked **Your answer** bar at its foot holds Fix / Ignore and a comment box, and stays visible while the evidence scrolls. Ignoring a finding takes it out of readiness.
- **Bottom:** reviewer team, target, checks, gaps, next steps, notes, and sources.

## What the report needs

- A complete `stack`, listed bottom-up, with correct `parent` links, `branch`, `base`, `head`, `status`, and, when known, `url`, `additions`, `deletions`, and `changed_files`.
- Each finding attributed with `pr` to the PR that **introduces** the root cause. Use `prs` only for defects that exist because PRs combine. Readiness inheritance relies on this attribution. A finding without a PR does not affect any station; it is listed in a merge-plan footnote.
- Severity and disposition set carefully, because they decide Blocked, Attention, or Clear.

## Inspect before delivering

1. Each station's readiness and its reasons match the findings: spot-check the bottom PR and the top of every fork.
2. Selecting a station splits introduced and inherited findings correctly; with the merge plan shown, it lists PRs in merge order. With it hidden, the findings span the full width.
3. The page loads with no console errors, and the train scrolls inside its own container at 390px without page-level horizontal overflow.

## Limits

- `j`/`k` follow the dossier's drawn order (introduced, then inherited) through a theme-level override.
- Readiness is a heuristic summary of review findings. It does not replace CI, approvals, or the coordinator's verdict.
