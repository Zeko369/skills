---
name: human-review
description: Introduce a pull request or diff with a short summary whose inline topics expand into deeper explanations, then build a reading plan from per-project rules and render a Monaco-backed review tool that exports line comments as JSON. Use when asked to review a PR yourself, decide what matters in a large diff, or prepare a change for human reading.
---

# Human review

Agent review answers "what is wrong". This answers "what did this change do, and have I looked at
it". The deliverable is a layered PR introduction, a reading plan and a review tool. It is a companion
to `multi-agent-review`, not a replacement, and the two are run separately.

Rules are deterministic and run first. The agent writes the introduction, names groups and escalates;
it never silently demotes what the config marked critical. That ordering is the point: a predictable
floor you can trust, with judgment layered on top.

## Establish the target

Take the target from the conversation. A PR number, a branch, a revision range, or the working tree.
Record repository, absolute workspace, base and head SHA, and whether the tree is dirty. The plan
pins `head_sha`; comments exported later are anchored to that SHA, so say so if the branch moves.

## Resolve the rules

Read `<repo>/.claude/reading-rules.json`, else `<repo>/.reading-rules.json`, else fall back to
`configs/rails.json`. The contract is in [rules](references/rules.md).

Rules are per project because the noise is per project. Before writing a new one, look at what the
last ten merged PRs actually touch: the fan-outs, the generated files, and the handful of paths where
a mistake is expensive. Do not invent rules for paths the repo does not have. Report which config
was used; a plan built on the fallback is weaker than one built on tuned rules, and should say so.

Never let a config downgrade a path below `read` without a stated reason. Skipping is a claim that
a human reading those lines would learn nothing, and it has to be earned.

## Build the plan

```sh
python3 /path/to/human-review/scripts/plan_reading.py --pr 412 --repo-path ~/work/app \
  -o reading-plan.json
python3 /path/to/human-review/scripts/plan_reading.py --range main...HEAD --repo-path . \
  -o reading-plan.json
```

Every file lands in exactly one of four weights:

| Weight | Means |
| --- | --- |
| `critical` | Stop and read. A mistake here is expensive or irreversible. |
| `read` | Read it. This is the change. |
| `skim` | Look at the shape, do not study it. |
| `skip` | Do not open. Folded into a count. |

Seven modifiers then correct what a flat glob list gets wrong. Each exists because a real PR broke
the naive rule: shape-collapse folds identical fan-outs, tests cap at `read`, specs inherit a
critical subject, pure deletion demotes to verification, mechanical wiring collapses into one
question, a tiny change in a focused PR is promoted to `critical`, and a spec that deletes far more
than it adds is flagged. They are documented with their evidence in [rules](references/rules.md).

Every one of them reasons about size, which is the wrong proxy for the files that declare a
contract - models, schemas, permission maps. Mark those rules `never_demote` so the modifiers can
promote them but never shrink, fold or hide them. Two lines added to a model is still a change to
every row in the table.

Reading order inside a weight comes from each rule's `rank`, not from file size. Rank them the way
you would want to be walked through a change: the data contract, then what calls it, then the tests
that confirm it. Left unranked, a 400-line request spec floats above the three-line model it covers.

Questions the plan raises are answered without opening a diff: whether a wiring list is complete,
whether removed coverage was intentional, whether a generated file changed in a way its inputs do
not explain, whether the change is too big for one sitting. Keep them scarce. A question that fires
on every change - "db/schema.rb changed, is that expected?" when the migration is right there - is
noise, and noise is read past. Give `report` a condition so it speaks only when surprised.

## Write the PR introduction

Before rendering, read the pinned diff and the surrounding code needed to explain it, then author
`pr-summary.json` using [the summary contract](references/summary.md). The deterministic planner
does not write prose; this is part of the agent's work on every review.

Start with one short paragraph of roughly five sentences explaining the problem, the resulting
behavior and the main review considerations. Put a few clickable words or phrases inside those
sentences. Each opens another three to five sentences about that particular topic, in one or two
paragraphs. Where useful, a phrase inside that explanation opens a third level for a mechanism,
tradeoff or evidence. Keep each level readable on its own and add detail instead of repeating it.

Link topics to changed files so the reader can go from explanation to diff. Ground claims in the
reviewed code; identify inferred intent, unknowns and validation limits. Tests present in the diff
are not proof they passed. Keep material risks visible in the opening paragraph even when their
details expand. The introduction does not alter file priorities or count toward reading progress.

## Render and review

```sh
python3 /path/to/human-review/scripts/render_reading.py reading-plan.json \
  --summary pr-summary.json --output-dir review/
```

Writes `plan.html`, `review.html`, and an `index.html` chooser. Both pages embed the same plan JSON,
share `assets/core.css` and `assets/core.js`, and work offline from `file://`.

- **plan.html** - the whole review in one page, and the one to start in. The expandable introduction
  comes first, followed by metrics, questions and the reading order as a numbered rail of groups.
  Each group holds a collapsible directory tree with a
  checkbox at every level: tick a file, a folder, or a whole group, and ticking a group folds it
  away. Clicking a file opens its diff inline, with the comment composer beside it, so triage and
  reading are the same page.
- **review.html** - focus mode for one file at a time: full-height editor, keyboard navigation,
  the file list as a flat rail, and a **PR intro** link back to the explanation. Reach for it when
  a file is long enough that the drawer is cramped.

Both render the diff with a plain Monaco editor plus custom decorations rather than a diff editor,
because the patch already encodes the diff. That avoids the diff worker entirely. Monaco loads from
jsDelivr; without a network both pages fall back to a plain diff view that still anchors comments.

Progress, comments and collapse state live in that browser's `localStorage`, keyed by repo, PR and
head SHA, and are shared by both pages. Moving between files uses `replaceState`, so Back leaves the
tool instead of walking every file you opened.

Open and check the rendered pages when browser tools are available. Confirm the reading order matches
the plan, the critical group is first, a gutter click anchors a comment to the right line, and the
console is clean. Expand an inline topic and a deeper topic, collapse back to the overview, and
follow a file link. These actions must leave reading progress unchanged. Summary controls must
work with the keyboard and without Monaco or a network connection.

## Hand comments back

**Copy JSON** in the review tool produces `human-review/comments@1`. When the user pastes it:

- Follow its `instructions` field. `kind` decides the action: `fix` changes code, `question` is
  answered in your reply and only changes code if the answer implies it, `nit` is applied only when
  genuinely trivial, `praise` needs nothing.
- `line` and `side` refer to the diff at `target.head_sha`. `side: "right"` is the new file,
  `side: "left"` the old one. Check the SHA against the checkout and re-locate anything that moved,
  saying which comments no longer apply.
- `progress.unread` lists files the human never opened. If a comment implies a defect that likely
  also appears in an unread file, say so rather than silently fixing beyond what was reviewed.
- Report per comment `id` what changed, what you verified, and what you skipped and why.

Do not post anything to GitHub. Posting is a separate, explicitly requested step.
