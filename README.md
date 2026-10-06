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

The [example HTML](multi-agent-review/example-report.html) is a setup demonstration, not a real code review. To render it locally:

```sh
python3 multi-agent-review/scripts/render_report.py \
  multi-agent-review/assets/example-report.json \
  --output multi-agent-review/example-report.html
```

## Add a skill

Create `<skill-name>/SKILL.md` with a YAML `name` and `description`, then its instructions. Put optional scripts, references, and assets beside it and use paths relative to the skill folder. Run `./install.sh` again. Keep generated review runs, source snapshots, credentials, and machine-specific configuration outside this repository.

## Check the installer

```sh
python3 -m unittest discover -s tests -v
```

The tests use temporary home directories and cover repeat installation, paths with spaces, dry runs, and preservation of conflicting entries.
