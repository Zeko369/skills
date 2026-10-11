# Reading rules contract

A project's rules live at `<repo>/.claude/reading-rules.json` (or `<repo>/.reading-rules.json`).
`configs/rails.json` is the fallback and a worked example.

```jsonc
{
  "version": 1,
  "name": "acme",
  "rules": [ /* ordered; first match wins */ ],
  "modifiers": { /* corrections applied after matching */ },
  "oversized": { "read_files": 25 }
}
```

## Rules

Two orderings are in play and they are not the same one. **Array order** decides which rule
matches: first wins, so the specific comes before the general - `app/models/**` before `app/**`,
`spec/requests/**` before `spec/**`. **`rank`** decides what you read first once everything is
classified.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable short slug. Groups the file list and names the question it raises. |
| `match` | yes | Glob or list of globs. `**` crosses directories, `*` does not. Anchored at both ends. |
| `weight` | yes | `critical`, `read`, `skim`, or `skip`. |
| `rank` | no | Reading order inside a weight, low first. Defaults to the rule's position in the array. |
| `label` | no | Display name for the group. Defaults to `id`. |
| `why` | no | One sentence, shown to the reader. Write it for `critical` and `skip` especially: both are claims that need justifying. |
| `never_demote` | no | Modifiers may promote these files but never demote, fold, or hide them. |
| `collapse` | no | `"shape"` folds files with an identical `(rule, additions, deletions)` signature. |
| `report` | no | Skip the content but raise the change as a question. See below. |

Without `rank`, a group lands wherever its biggest file does, which is how a 400-line request
spec ends up above the three-line model it covers. Rank the rules in the order you would want
to be walked through the change: the data contract, then the thing that calls it, then the tests
that confirm it.

Ranks are only compared inside a weight, so the same number means different things in `read` and
`skim`. A rule that a modifier can promote across weights - any test rule, because of
`spec_inherits_subject` - wants a rank past the last rule of the weight above, so it stays last
in both.

### never_demote

The modifiers below are heuristics about size, and size is a bad proxy for importance in exactly
one place: files whose job is to declare a contract. A two-line change to `app/models/user.rb`
adding `has_many :api_keys, dependent: :destroy` is three words long and reaches every row in the
table. Marking the rule `never_demote` keeps those files in the reading order no matter how small,
how mechanical, or how duplicated the change looks. Promotion still applies; only demotion,
wiring-collapse and shape-folding are refused. The advice a modifier would have attached is still
attached - a deleted model is still annotated "check for dangling references", it just stays in
`read` while you do.

### report

`report` is for files you never open but whose size still carries a signal. Unconditional
`"delta"` asks about every change, which gets ignored within a day - "db/schema.rb changed" is
not a question when the migration that changed it is sitting in the same diff. Give it conditions
instead, and it speaks only when the delta is not already explained:

| Condition | Fires when |
| --- | --- |
| `unless_paired_with` | Nothing else in the change matches that glob. A schema dump with no migration was hand-edited or is stale. |
| `deletions_over` | The file lost more than N lines. Generated output shrinking means something upstream was removed. |
| `additions_over` | The file gained more than N lines. Use it where additions are the costly direction, like a Brakeman ignore list. |

Weights mean:

- **critical** - a mistake here is expensive or irreversible: migrations, authorization, secrets,
  production config, anything deployed outside the normal pipeline, new dependencies.
- **read** - this is the change, plus the contracts around it.
- **skim** - look at the shape. Markup, verbose end-to-end tests, unit specs that restate the code.
- **skip** - do not open it. Every `skip` is a claim that reading those lines teaches nothing;
  write a `why` that earns it.

## Modifiers

Flat globs get seven things wrong. Each of these came from a real pull request.

| Modifier | Default | What it fixes |
| --- | --- | --- |
| `shape_collapse.min_files` | 3 | A line-count threshold misses fan-outs. One PR added a translation key as 10 files of `+7/-0`, another added 10 of `+20/-1`; both are mechanical. Identical shape, not size, is the signal. |
| `test_caps_at` | `"read"` | A test on a critical path inherited `critical`. A test of dangerous code is never as dangerous as the code. |
| `spec_inherits_subject` | `true` | The inverse: a spec covering a `critical` file sat in `skim`. Promote it one level. |
| `pure_deletion_demotes` | `true` | A 154-line deletion is not 154 lines to read; it is one thing to verify. `additions == 0` demotes and notes "check for dangling references". |
| `mechanical_wiring` | `{max_lines: 2, min_files: 5}` | One PR touched 14 files with one line each, all the same `include`. The diffs are worthless; "is the list complete?" is the real question. |
| `spotlight` | `{max_code_files: 2, max_lines: 3}` | A one-line fix in `app/models/user.rb` under a 20-line spec is the entire change. In a focused PR, tiny means critical, not trivial. |
| `coverage_removed.deletion_ratio` | 5 | A spec deleting far more than it adds gets flagged. Confirm the behaviour went away, not just its test. |

`mechanical_wiring` and `shape_collapse` both skip any rule marked `never_demote`.

`oversized.read_files` raises a question when too many files survive filtering. It is not a failure
of the rules; a change that genuinely touches 31 things should be split, and saying so is useful
output.

## Writing rules for a new project

Read what the last ten merged PRs actually touch before writing anything:

```sh
for n in $(gh pr list --state merged --limit 10 --json number --jq '.[].number'); do
  gh pr view "$n" --json files --jq '.files[] | "\(.additions)+/\(.deletions)- \(.path)"'
done | sort | uniq -c | sort -rn | head -40
```

Look for three things: the fan-outs (one logical change, N mechanical files), the generated files
(never read, but their delta is a signal), and the handful of paths where a mistake is expensive.
Those three produce most of the value. Do not write rules for paths the repository does not have.

## Plan output

`plan_reading.py` emits `human-review/plan@1`:

- `target` - repo, kind, number, title, author, base, branch, `head_sha`, url.
- `config` - which rules file was used. A plan built on the fallback is weaker than one on tuned
  rules and should say so.
- `stats` - per-weight counts plus `files`, `additions`, `deletions`, `folded`.
- `questions` - `{id, kind, text, files}`, answerable without opening a diff.
- `groups` - ordered `{key, rule, label, weight, why, files}`.
- `order` - flat reading order; `critical` and `read` only, folded files excluded.
- `files` - every file with `path`, `add`, `del`, `status`, `weight`, `rule_id`, `why`, `notes`,
  `patch`, and `folded_into` / `folds` for fan-outs.

The patch travels with the plan, so the rendered pages are self-contained and work from `file://`.

## Comment output

The review tool exports `human-review/comments@1`: `target`, `instructions`, `review`
(`verdict`, `summary`), `comments` (`id`, `path`, `line`, `side`, `kind`, `body`, `code`, `weight`,
`rule`), `progress` (`read`, `unread`, `skipped_by_rules`), and `stats`.

`line` and `side` follow GitHub's review vocabulary: `right` is the new file, `left` the old one,
both numbered as in the diff at `target.head_sha`. `plan_reading.py`'s reconstruction of those
numbers is verified against the real blobs in the test suite.
