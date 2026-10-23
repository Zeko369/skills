# Agent skills

Reusable skills for Codex, Cursor, and Claude Code. This checkout is the source of truth; personal skill directories contain links to it.

## Install

Requires Git, Bash, and Python 3.9+ on macOS or Linux.

```sh
git clone https://github.com/Zeko369/skills.git ~/code/skills
cd ~/code/skills
./install.sh
./install.sh --check
```

The installer links every top-level folder containing `SKILL.md` into:

| Directory | Used by |
| --- | --- |
| `~/.agents/skills/<name>` | Codex and Cursor |
| `~/.claude/skills/<name>` | Claude Code |

Links point directly to the skill folder in this checkout. Keep the checkout in place. The installer preserves unrelated skills, skips correct links, and stops before changing anything if it finds an existing conflicting entry. It never force-replaces files or directories. `--dry-run` previews missing links; `--home /path/to/home` selects an alternate installation home for testing.

Start a fresh agent session after installation and check its skill list. A skill is available across local projects but runs only when relevant or explicitly invoked. Local installation does not sync skills into remote/cloud runtimes, install CLIs, or copy provider credentials; set those up on each machine separately.

Discovery locations: [Codex](https://developers.openai.com/codex/skills/), [Cursor](https://cursor.com/docs/skills), [Claude Code](https://code.claude.com/docs/en/skills#choose-where-skills-load).

## Update

```sh
git -C ~/code/skills pull --ff-only
~/code/skills/install.sh
~/code/skills/install.sh --check
```

Existing links immediately point at updated files. Rerunning installation adds newly introduced skills. Refresh or restart agent sessions if their skill catalog is cached. If you move the checkout, remove only its old per-skill links and run the installer from the new location.

## Skills

### multi-agent-review

Independent reviews by Codex, Claude Code, and Cursor, reconciled into a standalone HTML report. In T3 Code it requests app-owned delegation for every reviewer, including the coordinator's own harness. Outside T3, or when a provider's T3 route is unavailable, it uses the matching installed CLI.

Requested defaults: GPT-6.1 Sol / xhigh, Claude Opus 5.5 / xhigh, and Cursor Grok 4.7 / xhigh. The skill refreshes capabilities before each run and records unavailable models rather than silently substituting them.

Invoke `$multi-agent-review` in Codex or `/multi-agent-review` in Claude Code/Cursor, or ask the agent to use the skill to review a PR, branch, working tree, plan, or document. Reviewers do not implement fixes or publish comments unless separately requested.

Each run renders the report as one `train` page: stack-first merge readiness, with a merge plan and per-PR dossiers. The design is described in [`multi-agent-review/references/designs/train.md`](multi-agent-review/references/designs/train.md). The older `triage` and `board` designs are still available with `--theme`. Stacked PRs get a hierarchy view and per-PR filtering.

Every finding starts approved for fixing. Mark the ones you don't want fixed as Ignore, add comments where needed, then use **Copy answers** to get JSON you can paste back to the agent. The skill's "Apply review answers" section tells it how to act on that JSON. Answers stay in your browser and are shared by every page of the same report. Finding drawers can be dragged wider.

The pages in [`multi-agent-review/examples/`](multi-agent-review/examples/) use illustrative data, not a real code review. To regenerate them:

```sh
for theme in train triage board; do
  python3 multi-agent-review/scripts/render_report.py multi-agent-review/assets/example-stack-report.json \
    --output multi-agent-review/examples/stack/$theme.html --theme $theme
done
python3 multi-agent-review/scripts/render_report.py multi-agent-review/assets/example-report.json \
  --output multi-agent-review/examples/setup/train.html
```

### human-review

A reading plan for a change, then a tool to read it in. Where `multi-agent-review` answers "what is
wrong", this answers "what did this change do, and have I looked at it".

Per-project rules in `<repo>/.claude/reading-rules.json` sort every changed file into **stop and
read**, **read**, **skim**, or **skip**, and seven modifiers correct what a flat glob list gets
wrong: identical fan-outs fold into one row, tests cap below the code they cover, a spec inheriting
a critical subject is promoted, pure deletion becomes verification rather than reading, near-empty
edits of one kind collapse into a single question, a tiny change in a focused change is promoted
instead of buried, and a spec that deletes far more than it adds is flagged. Each modifier exists
because a real pull request broke the naive rule; the evidence is in
[`human-review/references/rules.md`](human-review/references/rules.md).

Every modifier reasons about size, so rules that declare a contract - models, permission maps -
carry `never_demote` and are promoted but never shrunk, folded or hidden. Reading order inside a
weight comes from each rule's `rank`, so the small model sorts above the large request spec that
covers it rather than below it.

```sh
python3 human-review/scripts/plan_reading.py --pr 412 --repo-path ~/work/app -o reading-plan.json
python3 human-review/scripts/render_reading.py reading-plan.json --output-dir review/
```

`plan.html` is the whole review in one page: the questions you can answer without opening a diff,
then the reading order as a numbered rail of groups, each holding a collapsible directory tree with
a checkbox at every level. Tick a file, a folder, or a whole group - ticking a group folds it away.
Clicking a file opens its diff inline with the comment composer beside it. `review.html` is focus
mode for one file at a time, with a full-height editor and keyboard navigation.

Both render the diff as a plain Monaco editor plus custom decorations rather than a diff editor,
since the patch already encodes the diff; no diff worker is needed and the pages degrade to a plain
diff view with no network. Progress, comments and collapse state live in your browser, keyed by
repo, PR and head SHA, and are shared by both pages.

The exported `human-review/comments@1` carries each comment's path, line, side, and a `kind` of
`fix`, `question`, `nit` or `praise`, plus which files you never opened. Paste it back and the skill
acts on it. It does not post to GitHub; that is a separate, explicitly requested step.

`configs/rails.json` is the fallback and a worked example. Write your own by looking at what your
last ten merged PRs actually touch. The pages in
[`human-review/examples/`](human-review/examples/) use a synthetic change, not a real review:

```sh
python3 human-review/scripts/render_reading.py human-review/assets/example-plan.json \
  --output-dir human-review/examples
```

## Add a skill

Create `<skill-name>/SKILL.md` with a YAML `name` and `description`, then its instructions. Put optional scripts, references, and assets beside it and use paths relative to the skill folder. Run `./install.sh` again. Keep generated review runs, source snapshots, credentials, and machine-specific configuration outside this repository.

## Tests

```sh
python3 -m unittest discover -s tests -v
```

Installer tests use temporary home directories and cover repeat installation, paths with spaces, dry runs, and preservation of conflicting entries. Renderer tests render every theme and cover stack validation and script-safe data embedding.
