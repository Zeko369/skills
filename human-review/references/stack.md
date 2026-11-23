# Reviewing a stack

A stack of pull requests is rendered once, into one HTML file that holds every PR. The **Stack**
button opens a sidebar that links all of them, so switching PRs works like switching files. The switch
happens in place, with no page load. Each PR is still planned, introduced and read on its own,
against its parent branch. The stack only adds navigation.

## Build one plan and one introduction per PR

Plan each PR against its own base, not trunk. `gh` already compares a PR against its base
branch. For ranges, use the parent branch:

```sh
for n in 411 412 413 414; do
  python3 /path/to/human-review/scripts/plan_reading.py --pr "$n" --repo-path ~/work/app \
    -o "run/pr-$n.json"
done
# without PRs: one range per layer, parent...child
python3 /path/to/human-review/scripts/plan_reading.py --range feat/audit-log...feat/api-keys \
  --repo-path . -o run/pr-412.json
```

Write an introduction for every PR using the [summary contract](summary.md). Its `head_sha` must
match that PR's plan. Each introduction covers only its own PR. Say what it builds on from below
("the recorder from #411") and leave out what lands above it. The first PR that exercises two
lower PRs together is worth calling out, because that is where they first meet.

## The manifest

```json
{
  "title": "Account API keys, as a stack",
  "trunk": "main",
  "prs": [
    {"id": "pr-411", "plan": "pr-411.json", "summary": "pr-411-summary.json"},
    {"id": "pr-412", "plan": "pr-412.json", "summary": "pr-412-summary.json"},
    {"id": "pr-413", "plan": "pr-413.json", "summary": "pr-413-summary.json"},
    {"id": "pr-414", "plan": "pr-414.json", "summary": "pr-414-summary.json", "parent": "pr-412"}
  ]
}
```

- `prs` is listed **bottom of the stack first**, and a parent always comes before its children.
- `plan` and `summary` are paths relative to the manifest, or inline objects. Omit `summary` if the
  plan already embeds one.
- `id` is a short slug and defaults to `pr-<number>`. It appears in the URL hash
  (`#view=plan&pr=pr-413`).
- `parent` is another entry's `id`, or `null` for a PR on trunk. If you omit it, the renderer
  infers it by matching the PR's `target.base` to another PR's `target.branch`. Set it
  explicitly when branches are unknown, as with range plans.
- Branching stacks are fine: two PRs can share a parent (`#413` and `#414` both on `#412`).
- `title` and `trunk` are optional. `trunk` defaults to the base of the lowest PR.

```sh
python3 /path/to/human-review/scripts/render_reading.py --stack run/stack.json -o review.html
```

Every plan and introduction is validated exactly as it would be when rendered alone.

## What the page does

The hash is the route: `#view=stack|plan|focus&pr=<id>&file=<path>`. A stack render opens on the
stack overview, and an unknown `pr` falls back to the lowest PR.

- **Stack overview** (`view=stack`) - each PR, bottom-up, shows its branch, its parent, its size,
  the first sentence of its introduction, its live progress, and links to its plan, focus mode and
  GitHub. A PR that forks from something other than the PR listed above it is indented.
- **Stack sidebar** shows one card per PR, bottom-up, with the number, title, read progress, comment
  count, and `on #N` when a PR forks from an earlier PR. Selecting a PR keeps the current review
  view. The sidebar docks on wide screens and closes after selection on narrow screens.
  **Overview** opens the stack overview. `‹` / `›` and the keys `[` / `]` step down and up. In focus
  mode they keep the open file when the next PR changes it too.
- **Also in** - a file that another PR in the stack also changes shows `also in #412` in its
  drawer or header. The link opens that file in that PR's focus mode.
- **Progress and comments** - every PR keeps its own `localStorage` record, keyed exactly as a
  single-PR render would key it. Re-rendering one PR alone, or the stack without it, keeps what
  was read. Moving a PR's head starts that PR fresh, like any other render.
- **Export** - **This PR** gives the usual `human-review/comments@1`, with a `stack` field naming
  the PR's position. **Whole stack** gives `human-review/stack-comments@1`: one envelope with the
  instructions, `counts`, and `reviews`, a list in stack order with one entry per PR. Each entry is
  a `comments@1` payload (`target`, `review`, `comments`, `progress`, `stats`) plus its `id` and
  `parent`.

## Template notes

`assets/review.html` starts with a `<!--template ... -->` comment that lists its placeholders, the
routes, and the elements the script needs. The renderer removes that comment before substitution.
The data script is `<script type="application/json" id="@@DATA_ID@@">`, where `DATA_ID` is `plan`
or `stack`. `core.js` reads whichever is present and treats a single plan as a stack of one without
the stack chrome. Build links with `HR.link({view, pr, file, at})`. Read the selected PR from
`HR.plan`, `HR.target` and `HR.state` at render time, because `HR.select()` swaps them when the
route names another PR.
