# CLI fallback

Use this per reviewer when T3 is absent or cannot run that requested provider. These commands were checked against local help on **2026-10-04**: Codex 0.159.2, Claude Code 2.1.286, Cursor Agent 2026.10.01-e373342. Help/catalog verification is not proof of a successful model inference. Refresh local help before running if flags differ.

## Preflight

```sh
command -v codex claude cursor-agent
codex exec --help
claude --help
cursor-agent --help
cursor-agent models
```

Use `cursor-agent` explicitly. A generic `agent` executable may belong to **Grok**, not Cursor. Do not install or authenticate additional CLIs just to hide unavailable coverage. For Codex/Claude, resolve exact model IDs from the live T3 catalog when present or current official/model configuration information; a generic `opus` alias does not pin Opus 5.5.

The local Cursor model list included `grok-4.7-xhigh`; use that exact listed ID. Current Cursor help also supports parameterized models, but do not invent an effort flag or assume T3's effort option is a CLI argument. Avoid `auto` and unrequested `-fast` variants.

## Concrete invocations

Set `review_workspace` to the reviewed checkout or preserved source snapshot and `review_run` to an absolute, unique **round directory**, such as `/tmp/review-RUN/round-1`, containing the complete `brief.txt`. Use a new `round-2` directory for follow-up work, preserving every earlier brief, log, and result. These are ordinary shell variables; do not repurpose `HOME` or `CODEX_HOME`. Run each command from the reviewed workspace where indicated.

Codex (stdin prompt, read-only sandbox, final response plus event log):

```sh
codex exec --cd "$review_workspace" \
  --model gpt-6.1-sol --config 'model_reasoning_effort="xhigh"' \
  --sandbox read-only --ephemeral --json \
  --output-last-message "$review_run/codex.txt" \
  - < "$review_run/brief.txt" \
  > "$review_run/codex.events.jsonl" 2> "$review_run/codex.stderr.log"
```

For a document workspace that is not a Git repository, add the supported `--skip-git-repo-check` deliberately. `codex review` exists, but `exec` makes the shared brief and output capture explicit for code and document reviews alike. Keep user configuration/rules unless a specific isolated test requires otherwise.

Claude Code (run with the process working directory set to `review_workspace`):

```sh
claude -p --model claude-opus-5-5 --effort xhigh \
  --permission-mode plan --permission-prompts none \
  --no-session-persistence --output-format json \
  < "$review_run/brief.txt" \
  > "$review_run/claude.result.json" 2> "$review_run/claude.stderr.log"
```

Keep the explicit review task in stdin; plan mode does not mean the desired output is an implementation plan. Do not add a fallback model. If tools are denied, record which evidence could not be collected. The final result is wrapped in CLI JSON; inspect `is_error` and the returned result rather than treating exit zero alone as success.

Cursor Agent:

```sh
cursor-agent --workspace "$review_workspace" --print --mode ask \
  --model grok-4.7-xhigh --output-format json \
  "Independently review the target described in $review_run/brief.txt. Read that file first; it contains scope and output requirements. Do not edit files or launch other agents." \
  > "$review_run/cursor.result.json" 2> "$review_run/cursor.stderr.log"
```

The brief remains in a file; a short argument points to it without putting a patch or secrets on the process command line. Verify the CLI can read the artifact directory; if access is denied, provide the brief via its documented input mechanism or an appropriate read-access option. Do not silently proceed without the brief. `--mode ask` is the documented read-only mode; do not add `--force`, `--yolo`, or disabled sandbox flags.

A fresh source snapshot can trigger Cursor's workspace-trust gate before inference. For a verified copy of the user's explicitly authorized repository, `--trust` acknowledges that specific workspace while retaining `--mode ask`; it is distinct from `--force`/`--yolo`. Confirm the first attempt exited, retain its logs, and retry once with `--trust` in a separate attempt file. Do not apply this to an unknown workspace or change trust globally. If the brief is outside the source directory, use a supported `--add-dir` for that artifact directory when needed.

## Process management and results

Launch independent processes concurrently using the current execution tool or a small `subprocess.Popen` supervisor with **argument arrays**, explicit `cwd`, and separate stdin/stdout/stderr files. Avoid constructing shell commands from source text. Preserve PID/session IDs and per-process exit statuses. Use task-specific deadlines (a practical default is 15 minutes per reviewer, adjustable for scope); communicate while work runs. A waiting parent timeout is not a killed process. On cancellation/timeout, terminate the process group you launched, wait for exit, and mark its output partial. Do not kill unrelated sessions by executable name.

**Keep a standalone CLI coordinator alive until it has collected the results.** A final response from `claude -p` or `codex exec` ends that process; background reviewer completion does not provide T3's durable wake-up mechanism. Run the supervisor as a foreground tracked command, or keep taking bounded status/wait tool steps until every launched process is terminal and the report has been written. Do not end with “I'll be notified” while reviewers remain active. If monitoring is denied, use an already-allowed read/status path or report the exact permission limitation; do not invent automatic continuation or bypass the denial. A caller recovering an exited coordinator should collect the existing processes and artifacts, then start a synthesis-only continuation with those handles/results; never relaunch the reviewer team just to finish the report.

Parse each harness's actual output format, retaining the original logs. Detect nonzero exit, error envelopes, empty/malformed output, auth failures, unsupported model/effort, and incomplete turns. Include these as reviewer failures/gaps, even if other reviewers succeeded. Do not count requested model IDs as runtime-confirmed model identity. Never fabricate cost/tokens/timing unavailable from the provider.

CLI plan/ask modes and Codex's shell sandbox are different guarantees; connected MCP tools and local configuration still matter. The review-only brief is required for all three. Every round starts a fresh process without `--continue` or `--resume`; later briefs include the original scope, claims, counterevidence, and unresolved questions explicitly. Do not overwrite or append a new run into an earlier round's result files.

## Sources

- [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters)

Exact preset IDs and Cursor's effort-specific alias above were established from the live T3/CLI catalogs, not inferred from public docs.
