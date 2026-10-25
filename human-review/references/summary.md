# Layered PR introduction

Write this after inspecting the change, before rendering the reading plan. The reader should get
the gist in about five sentences and choose where to spend more attention by clicking phrases in
that paragraph. The default view shows only that paragraph; no topic starts expanded.

## Writing the levels

- **Overview:** one paragraph, roughly five sentences and 80–130 words. Explain the concrete
  problem, the resulting behavior, the main pieces of the solution and material risks or unknowns.
  Use two to four natural phrases as entry points into the details. Avoid a list of filenames or
  a collection of tags below the prose. Scale down for a small change rather than padding it.
- **Topic:** three to five more sentences in one or two short paragraphs. Explain what changes in
  that part, how it fits into the whole, and what a reviewer should understand. Add changed-file
  references as a route into the code.
- **Deeper topic, when useful:** another short explanation reached from a phrase inside a topic.
  Use it for a mechanism, compatibility consequence, tradeoff or validation evidence. Usually two
  or three levels are enough. Add a level only when it reveals new information.

Make every paragraph coherent when its topics are closed. Use descriptive phrases such as
"revocation checks" or "existing accounts", rather than "more", "details" or severity labels.
Keep critical caveats in the overview, then explain them further in a topic. Summaries explain the
change; deterministic weights still decide what the human must read.

Derive behavior from the pinned diff and relevant surrounding code. PR descriptions can supply
intent but do not establish behavior. Distinguish source inspection, tests added, tests actually
run and deployed behavior. Say when intent is inferred or validation is unavailable. Do not make
up a before-state, test result or rationale to fill the paragraph.

## JSON contract

The renderer accepts a `summary` object already embedded in `human-review/plan@1`, or an external
file passed with `--summary pr-summary.json`. The flag attaches it to both rendered pages without
modifying the input plan. Existing plans without a summary still render; when running the skill,
the agent authors the introduction rather than relying on that compatibility path.

```json
{
  "head_sha": "0123456789abcdef0123456789abcdef01234567",
  "overview": [
    "This change adds account API keys with ",
    {"text": "hashed tokens", "topic": "tokens"},
    ". The migration and secret handling are the main review considerations."
  ],
  "topics": [
    {
      "id": "tokens",
      "title": "Hashed tokens",
      "paragraphs": [
        [
          "The model stores a digest rather than a raw token. The ",
          {"text": "digest implementation", "topic": "digest"},
          " determines how tokens are derived."
        ]
      ],
      "files": ["app/models/api_key.rb"]
    },
    {
      "id": "digest",
      "title": "Digest implementation",
      "paragraphs": [
        ["The digest service uses HMAC-SHA256 with the application secret as its key. Check callers before drawing conclusions about token lookup behavior."]
      ],
      "files": ["app/services/api_keys/token_digest.rb"]
    }
  ]
}
```

This abbreviated example illustrates structure. A complete worked introduction is in
[`assets/example-plan.json`](../assets/example-plan.json).

- `head_sha` must equal `plan.target.head_sha`. Regenerate the introduction after the reviewed
  revision changes, and check that the base and working tree still match the reviewed snapshot.
- `overview` is one paragraph represented as an array of segments. Each segment is a plain string
  or `{"text": "visible phrase", "topic": "topic-id"}`. Whitespace is literal; include spaces
  around linked phrases as needed. All text is rendered literally, with no HTML or Markdown.
- `topics` is a list of objects with unique lowercase slug `id`s, a `title`, a nonempty list of
  `paragraphs` (each uses the same segment structure), and optional `files` from `plan.files`.
- Every topic must be reachable from the overview. References must resolve and cannot form
  cycles. Topics may be referenced from more than one paragraph.

Expansion is local to the introduction. It does not mark files read or change the reading plan.
**Overview only** collapses all topics. File links open the corresponding diff in focus mode,
which has a **PR intro** link back to the introduction. The prose and disclosure controls work
offline independently of Monaco.
