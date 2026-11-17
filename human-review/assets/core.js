/* Shared engine for the review page.
   One page holds every view - the reading plan, focus mode and, for a stack, the stack
   overview - and the URL hash says which: #view=focus&pr=pr-413&file=app%2Fx.rb.
   A single render embeds one plan in the `plan` script; a stack render embeds every
   PR's plan in the `stack` script. Each PR keeps its own localStorage record, keyed
   exactly as it would be on its own, so switching PRs never mixes their progress. */
window.HR = (function () {
  "use strict";
  var MONACO = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs";

  function embedded(id) {
    var node = document.getElementById(id);
    return node ? JSON.parse(node.textContent || "null") : null;
  }
  var stack = embedded("stack");
  // A single plan is a stack of one without the stack chrome, so there is one code path.
  var prs = stack ? stack.prs : [{ id: "pr", parent: null, plan: embedded("plan") }];
  var api = {};

  function keyOf(t) {
    return "human-review:" + (t.repo || "") + ":" +
           (t.number || t.range || "") + ":" + (t.head_sha || "").slice(0, 12);
  }
  var LABEL = { critical: "Stop and read", read: "Read", skim: "Skim", skip: "Skipped" };
  var LANG = { rb: "ruby", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", yml: "yaml", yaml: "yaml", md: "markdown", html: "html", erb: "html", css: "css",
    scss: "scss", sql: "sql", sh: "shell", rake: "ruby", py: "python", toml: "ini", lock: "ini",
    gemspec: "ruby", ru: "ruby", jbuilder: "ruby", vue: "html", graphql: "graphql" };

  function loadState(key) {
    try {
      var raw = JSON.parse(localStorage.getItem(key) || "{}");
      return { read: raw.read || {}, comments: raw.comments || [], seq: raw.seq || 0,
               collapsed: raw.collapsed || {}, verdict: raw.verdict || "comment",
               summary: raw.summary || "" };
    } catch (e) {
      return { read: {}, comments: [], seq: 0, collapsed: {}, verdict: "comment", summary: "" };
    }
  }

  /* ── The selected PR ────────────────────────────────────────────────────
     Everything below reads these, and select() swaps them. Views must read HR.plan and
     friends at render time rather than caching them. */
  var entry, plan, target, byPath, KEY, state;
  function select(id) {
    var next = prs[0];
    prs.forEach(function (pr) { if (pr.id === id) next = pr; });
    if (next === entry) return false;
    entry = next;
    plan = entry.plan;
    target = plan.target;
    byPath = {};
    plan.files.forEach(function (f) { byPath[f.path] = f; });
    KEY = keyOf(target);
    state = loadState(KEY);
    api.entry = entry; api.plan = plan; api.target = target;
    api.byPath = byPath; api.state = state;
    return true;
  }
  select(prs[0].id);
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    paintStack();
  }

  /* ── Routes ─────────────────────────────────────────────────────────────
     The hash is the whole route, so a link to a file survives a reload and the page
     works from file:// and from hosts that drop query strings. */
  var VIEWS = stack ? ["stack", "plan", "focus"] : ["plan", "focus"];
  function parseRoute() {
    var params = new URLSearchParams((location.hash || "").replace(/^#/, ""));
    var view = params.get("view");
    return { view: VIEWS.indexOf(view) >= 0 ? view : VIEWS[0],
             pr: params.get("pr") || prs[0].id,
             file: params.get("file") || "", at: params.get("at") || "" };
  }
  /* A hash for `route`, filled in from the current PR. The PR is left out of single
     renders, where there is only one. */
  function link(route) {
    var params = new URLSearchParams();
    params.set("view", route.view || "plan");
    if (stack) params.set("pr", route.pr || entry.id);
    if (route.file) params.set("file", route.file);
    if (route.at) params.set("at", route.at);
    return "#" + params.toString();
  }
  function prLabel(pr) {
    var t = pr.plan.target;
    return t.number ? "#" + t.number : pr.id;
  }
  function byId(id) {
    for (var i = 0; i < prs.length; i++) if (prs[i].id === id) return prs[i];
    return null;
  }
  /* Other PRs in the stack that change the same path - the reader of a lower PR should
     know the file moves again above it, and the reader of an upper one where it began. */
  function elsewhere(path) {
    if (!stack) return [];
    return prs.filter(function (pr) {
      return pr !== entry && pr.plan.files.some(function (f) { return f.path === path; });
    });
  }
  function progressOf(pr) {
    var s = pr === entry ? state : loadState(keyOf(pr.plan.target));
    var order = pr.plan.order;
    return { done: order.filter(function (p) { return s.read[p]; }).length,
             total: order.length, comments: s.comments.length };
  }
  /* How a PR sits on the one below it: null when it simply continues the chip before. */
  function relationOf(pr) {
    var index = prs.indexOf(pr);
    if (index === 0) return null;
    if (pr.parent == null) return "on " + (stack.trunk || "trunk");
    return pr.parent !== prs[index - 1].id ? "on " + prLabel(byId(pr.parent)) : null;
  }

  /* ── Stack bar ──────────────────────────────────────────────────────────
     One chip per PR, bottom of the stack first, each with that PR's own progress.
     Redrawn on every route change so the chips keep the view you are in. */
  var stackHost = null;
  function renderStack(host, route) {
    if (!stack || !host) return;
    stackHost = host;
    host.hidden = false;
    host.setAttribute("aria-label", "Pull requests in this stack");
    host.textContent = "";
    var view = route.view === "stack" ? "plan" : route.view;
    var head = el("span", "stack-head");
    var overview = el("a", "kicker", "Stack · " + prs.length + " PRs");
    overview.href = link({ view: "stack" });
    overview.title = "Stack overview";
    if (route.view === "stack") overview.setAttribute("aria-current", "page");
    head.appendChild(overview);
    host.appendChild(head);
    var list = el("ol", "stack-prs");
    prs.forEach(function (pr, index) {
      var item = el("li", "stack-pr");
      var chip = el("a", "stack-chip");
      chip.href = link({ view: view, pr: pr.id });
      chip.setAttribute("data-pr", pr.id);
      if (pr === entry && route.view !== "stack") chip.setAttribute("aria-current", "page");
      var relation = relationOf(pr);
      chip.title = (pr.plan.target.title || pr.id) +
                   (pr.plan.target.branch ? " · " + pr.plan.target.branch : "") +
                   (relation ? " · " + relation : "");
      if (index) item.appendChild(el("span", "stack-sep", relation ? "↳" : "→"));
      chip.appendChild(el("b", "", prLabel(pr)));
      chip.appendChild(el("span", "stack-title", pr.plan.target.title || ""));
      if (relation) chip.appendChild(el("span", "stack-rel", relation));
      chip.appendChild(el("span", "stack-tally"));
      chip.appendChild(el("span", "count"));
      chip.appendChild(el("span", "bar")).appendChild(el("i"));
      item.appendChild(chip);
      list.appendChild(item);
    });
    host.appendChild(list);
    var nav = el("span", "stack-step");
    [["Lower PR", -1, "["], ["Upper PR", 1, "]"]].forEach(function (step) {
      var next = stepTarget(step[1], route);
      var button = el(next ? "a" : "span", "btn btn-sm", step[1] < 0 ? "‹" : "›");
      button.title = step[0] + " (" + step[2] + ")";
      button.setAttribute("aria-label", step[0]);
      if (next) button.href = link(next);
      else button.setAttribute("aria-disabled", "true");
      nav.appendChild(button);
    });
    host.appendChild(nav);
    paintStack();
    var current = host.querySelector('[aria-current="page"]');
    if (current && current.scrollIntoView) current.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function paintStack() {
    if (!stackHost) return;
    prs.forEach(function (pr) {
      var chip = stackHost.querySelector('[data-pr="' + pr.id.replace(/"/g, "") + '"]');
      if (!chip) return;
      var p = progressOf(pr);
      chip.classList.toggle("done", p.total > 0 && p.done === p.total);
      chip.querySelector(".stack-tally").textContent = p.done + "/" + p.total;
      chip.querySelector(".bar i").style.width = p.total ? (100 * p.done / p.total) + "%" : "0";
      var count = chip.querySelector(".count");
      count.textContent = String(p.comments);
      count.hidden = !p.comments;
      count.title = p.comments + " comment" + (p.comments === 1 ? "" : "s");
    });
  }
  /* `[` and `]` step down and up the stack, keeping the view - and in focus mode the
     open file, when the next PR changes it too. From the overview they enter the plan. */
  function stepTarget(delta, route) {
    if (!stack) return null;
    var next = prs[prs.indexOf(entry) + delta];
    if (!next) return null;
    var keep = route.view === "focus" && route.file &&
               next.plan.files.some(function (f) { return f.path === route.file; });
    return { view: route.view === "stack" ? "plan" : route.view, pr: next.id,
             file: keep ? route.file : "" };
  }

  /* ── Theme ────────────────────────────────────────────────────────────
     The choice is light / dark / system; what the CSS sees is the resolved mode. */
  var THEME_KEY = "human-review:theme";
  var darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function themeChoice() {
    try { return localStorage.getItem(THEME_KEY) || "system"; } catch (e) { return "system"; }
  }
  function themeMode() {
    var choice = themeChoice();
    if (choice === "light" || choice === "dark") return choice;
    return darkQuery && darkQuery.matches ? "dark" : "light";
  }
  function applyTheme() {
    var mode = themeMode();
    document.documentElement.setAttribute("data-mode", mode);
    if (monacoState.ok && window.monaco) {
      monaco.editor.setTheme(mode === "dark" ? "hr-dark" : "hr-light");
    }
    return mode;
  }
  function setTheme(choice) {
    try { localStorage.setItem(THEME_KEY, choice); } catch (e) {}
    applyTheme();
  }
  if (darkQuery && darkQuery.addEventListener) {
    darkQuery.addEventListener("change", function () {
      if (themeChoice() === "system") applyTheme();
    });
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function toast(message) {
    var node = document.getElementById("toast");
    if (!node) return;
    node.textContent = message;
    node.classList.add("on");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { node.classList.remove("on"); }, 1600);
  }

  /* ── Layered PR introduction ───────────────────────────────────────────
     Expanding context never changes the file reading state. All authored text goes
     through textContent; topic links are data, not HTML or Markdown. */
  function mountSummary(host) {
    host.textContent = "";
    host.hidden = !plan.summary;
    if (!plan.summary) return;
    var summary = plan.summary, topics = Object.create(null), seq = 0;
    summary.topics.forEach(function (topic) { topics[topic.id] = topic; });
    var head = el("div", "summary-head");
    head.appendChild(el("span", "kicker", "Level 1 · PR introduction"));
    var reset = el("button", "btn btn-sm", "Overview only");
    reset.type = "button";
    reset.addEventListener("click", function () {
      host.querySelectorAll(".summary-detail").forEach(function (panel) { panel.hidden = true; });
      host.querySelectorAll(".summary-tag").forEach(function (button) {
        button.setAttribute("aria-expanded", "false");
      });
    });
    if (summary.topics.length) head.appendChild(reset);
    host.appendChild(head);
    if (summary.topics.length) {
      host.appendChild(el("p", "summary-hint", "Click an underlined phrase to go deeper."));
    }

    function paragraphs(parent, blocks, level) {
      blocks.forEach(function (parts) {
        var prose = el("div", "summary-prose");
        var p = el("p");
        prose.appendChild(p);
        parent.appendChild(prose);
        parts.forEach(function (part) {
          if (typeof part === "string") {
            p.appendChild(document.createTextNode(part));
            return;
          }
          var topic = topics[part.topic];
          var button = el("button", "summary-tag", part.text);
          button.type = "button";
          var panel = el("section", "summary-detail");
          panel.id = host.id + "-topic-" + (++seq);
          panel.hidden = true;
          button.setAttribute("aria-controls", panel.id);
          button.setAttribute("aria-expanded", "false");
          panel.setAttribute("aria-label", topic.title);
          var mounted = false;
          button.addEventListener("click", function () {
            if (!mounted) {
              mounted = true;
              var heading = el("div", "summary-head");
              heading.appendChild(el("span", "kicker", "Level " + (level + 1) + " · More context"));
              var close = el("button", "btn btn-sm", "Collapse");
              close.type = "button";
              close.setAttribute("aria-label", "Collapse " + topic.title);
              close.addEventListener("click", function () {
                panel.hidden = true;
                button.setAttribute("aria-expanded", "false");
                button.focus();
              });
              heading.appendChild(close);
              panel.appendChild(heading);
              panel.appendChild(el("h" + Math.min(level + 2, 6), "", topic.title));
              paragraphs(panel, topic.paragraphs, level + 1);
              if (topic.files && topic.files.length) {
                var files = el("div", "summary-files");
                files.appendChild(el("span", "kicker", "Read the change"));
                topic.files.forEach(function (path) {
                  var fileLink = el("a", "", path);
                  fileLink.href = link({ view: "focus", file: path });
                  files.appendChild(fileLink);
                });
                panel.appendChild(files);
              }
            }
            panel.hidden = !panel.hidden;
            button.setAttribute("aria-expanded", String(!panel.hidden));
          });
          p.appendChild(button);
          // Panels follow their paragraph, so opening one keeps the sentence intact.
          parent.appendChild(panel);
        });
      });
    }
    paragraphs(host, [summary.overview], 1);
  }

  /* ── Patch → display lines ──────────────────────────────────────────────
     One array of {text, kind, oldNo, newNo}. The patch already encodes the diff, so
     Monaco only has to colour it - no diff worker, which is what keeps this offline-safe. */
  function parsePatch(patch) {
    var lines = [], oldNo = 0, newNo = 0;
    (patch || "").split("\n").forEach(function (raw) {
      var header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
      if (header) {
        oldNo = +header[1]; newNo = +header[2];
        lines.push({ text: header[3].trim() || "⋯", kind: "hunk", oldNo: null, newNo: null });
        return;
      }
      if (raw === "" || raw[0] === "\\") return;
      var marker = raw[0], text = raw.slice(1);
      if (marker === "+") lines.push({ text: text, kind: "add", oldNo: null, newNo: newNo++ });
      else if (marker === "-") lines.push({ text: text, kind: "del", oldNo: oldNo++, newNo: null });
      else lines.push({ text: text, kind: "ctx", oldNo: oldNo++, newNo: newNo++ });
    });
    return lines;
  }
  function anchorOf(line) {
    return line.kind === "del" ? { side: "left", line: line.oldNo }
      : (line.newNo != null ? { side: "right", line: line.newNo } : null);
  }
  function languageOf(path) {
    var parts = path.split("/").pop().split(".");
    for (var i = parts.length - 1; i > 0; i--) if (LANG[parts[i]]) return LANG[parts[i]];
    if (/Gemfile|Rakefile|Guardfile/.test(path)) return "ruby";
    return "plaintext";
  }

  /* ── Read state ─────────────────────────────────────────────────────── */
  function isRead(path) { return !!state.read[path]; }
  function setRead(paths, value) {
    paths.forEach(function (p) { if (value) state.read[p] = true; else delete state.read[p]; });
    save();
  }
  function tallyRead(paths) {
    var done = paths.filter(isRead).length;
    return { done: done, total: paths.length,
             tri: done === 0 ? "false" : (done === paths.length ? "true" : "mixed") };
  }

  /* ── Comments ───────────────────────────────────────────────────────── */
  function commentsFor(path) {
    return state.comments.filter(function (c) { return c.path === path; });
  }
  function addComment(path, body, kind, anchor) {
    var entry = { id: "c" + (++state.seq), path: path,
                  line: anchor ? anchor.line.line : null, side: anchor ? anchor.line.side : null,
                  kind: kind, body: body, code: anchor ? anchor.text : null };
    state.comments.push(entry);
    save();
    return entry;
  }
  function removeComment(id) {
    state.comments = state.comments.filter(function (c) { return c.id !== id; });
    save();
  }

  /* ── Path tree ──────────────────────────────────────────────────────────
     Rails paths are deep and mostly uninteresting in the middle, so a directory with a
     single child is merged into its parent: app/controllers/concerns/matching reads as
     one row, not four. */
  function buildTree(paths) {
    var root = { name: "", path: "", dirs: {}, files: [] };
    paths.forEach(function (p) {
      var parts = p.split("/");
      var leaf = parts.pop();
      var node = root;
      parts.forEach(function (segment) {
        if (!node.dirs[segment]) {
          node.dirs[segment] = { name: segment, path: (node.path ? node.path + "/" : "") + segment,
                                 dirs: {}, files: [] };
        }
        node = node.dirs[segment];
      });
      node.files.push(p);
    });
    (function collapse(node) {
      Object.keys(node.dirs).forEach(function (key) { collapse(node.dirs[key]); });
      var keys = Object.keys(node.dirs);
      if (node !== root && keys.length === 1 && !node.files.length) {
        var only = node.dirs[keys[0]];
        node.name += "/" + only.name;
        node.path = only.path;
        node.dirs = only.dirs;
        node.files = only.files;
      }
    })(root);
    return root;
  }
  function filesUnder(node) {
    var out = node.files.slice();
    Object.keys(node.dirs).forEach(function (key) {
      out = out.concat(filesUnder(node.dirs[key]));
    });
    return out;
  }
  function sortedDirs(node) {
    return Object.keys(node.dirs).sort().map(function (key) { return node.dirs[key]; });
  }

  /* ── Collapse state ─────────────────────────────────────────────────── */
  function collapsed(key, fallback) {
    return key in state.collapsed ? state.collapsed[key] : !!fallback;
  }
  function setCollapsed(key, value) { state.collapsed[key] = !!value; save(); }

  /* ── Monaco ─────────────────────────────────────────────────────────────
     Loaded once and shared. `ready` resolves either way; callers check `ok` and fall
     back to a plain renderer when it is false. */
  var monacoState = { ok: false, waiting: [], done: false };
  function onMonaco(callback) {
    if (monacoState.done) callback(monacoState.ok);
    else monacoState.waiting.push(callback);
  }
  function finish(ok) {
    monacoState.ok = ok;
    monacoState.done = true;
    monacoState.waiting.splice(0).forEach(function (cb) { cb(ok); });
  }
  function loadMonaco() {
    var loader = document.createElement("script");
    loader.src = MONACO + "/loader.js";
    loader.onerror = function () { finish(false); };
    loader.onload = function () {
      window.require.config({ paths: { vs: MONACO } });
      // The editor never needs a worker: no diffing, no language services.
      self.MonacoEnvironment = { getWorker: function () {
        return { postMessage: function () {}, addEventListener: function () {},
                 removeEventListener: function () {}, terminate: function () {} };
      } };
      window.require(["vs/editor/editor.main"], function () {
        monaco.editor.defineTheme("hr-light", {
          base: "vs", inherit: true,
          rules: [
            { token: "", foreground: "1c1c1a" },
            { token: "comment", foreground: "7d7d75", fontStyle: "italic" },
            { token: "keyword", foreground: "c01c28" },
            { token: "keyword.control", foreground: "c01c28" },
            { token: "operator", foreground: "8a5000" },
            { token: "string", foreground: "0a4d6e" },
            { token: "string.escape", foreground: "8a5000" },
            { token: "regexp", foreground: "0a4d6e" },
            { token: "number", foreground: "1c4fb5" },
            { token: "constant", foreground: "1c4fb5" },
            { token: "type", foreground: "7a3ba8" },
            { token: "type.identifier", foreground: "7a3ba8" },
            { token: "identifier", foreground: "1c1c1a" },
            { token: "variable", foreground: "8a5000" },
            { token: "variable.predefined", foreground: "c01c28" },
            { token: "attribute.name", foreground: "7a3ba8" },
            { token: "attribute.value", foreground: "0a4d6e" },
            { token: "tag", foreground: "0f6b3a" },
            { token: "delimiter", foreground: "56564f" },
            { token: "metatag", foreground: "7d7d75" }
          ],
          colors: {
            "editor.background": "#ffffff",
            "editor.foreground": "#1c1c1a",
            "editorLineNumber.foreground": "#b4b4ac",
            "editorLineNumber.activeForeground": "#0a0a0a",
            "editorGutter.background": "#f8f8f6",
            "editorIndentGuide.background1": "#ecece7",
            "editor.selectionBackground": "#ffe8a3",
            "editor.inactiveSelectionBackground": "#f1f1ec",
            "editorCursor.foreground": "#0a0a0a",
            "editorWidget.background": "#ffffff",
            "editorWidget.border": "#0a0a0a",
            "scrollbarSlider.background": "#d6d6cf88",
            "scrollbarSlider.hoverBackground": "#b4b4acaa"
          }
        });
        monaco.editor.defineTheme("hr-dark", {
          base: "vs-dark", inherit: true,
          rules: [
            { token: "", foreground: "e6e6e0" },
            { token: "comment", foreground: "7c7c73", fontStyle: "italic" },
            { token: "keyword", foreground: "ff7b82" },
            { token: "keyword.control", foreground: "ff7b82" },
            { token: "operator", foreground: "e3a857" },
            { token: "string", foreground: "8fd3ff" },
            { token: "string.escape", foreground: "e3a857" },
            { token: "regexp", foreground: "8fd3ff" },
            { token: "number", foreground: "9db8ff" },
            { token: "constant", foreground: "9db8ff" },
            { token: "type", foreground: "d2a8ff" },
            { token: "type.identifier", foreground: "d2a8ff" },
            { token: "identifier", foreground: "e6e6e0" },
            { token: "variable", foreground: "e3a857" },
            { token: "variable.predefined", foreground: "ff7b82" },
            { token: "attribute.name", foreground: "d2a8ff" },
            { token: "attribute.value", foreground: "8fd3ff" },
            { token: "tag", foreground: "7ee787" },
            { token: "delimiter", foreground: "a3a39a" },
            { token: "metatag", foreground: "7c7c73" }
          ],
          colors: {
            "editor.background": "#13130f",
            "editor.foreground": "#e6e6e0",
            "editorLineNumber.foreground": "#55554c",
            "editorLineNumber.activeForeground": "#ecece7",
            "editorGutter.background": "#1a1a15",
            "editorIndentGuide.background1": "#2a2a23",
            "editor.selectionBackground": "#4a431f",
            "editor.inactiveSelectionBackground": "#26261f",
            "editorCursor.foreground": "#ecece7",
            "editorWidget.background": "#1c1c18",
            "editorWidget.border": "#ecece7",
            "scrollbarSlider.background": "#34342c99",
            "scrollbarSlider.hoverBackground": "#55554cbb"
          }
        });
        finish(true);
      }, function () { finish(false); });
    };
    document.head.appendChild(loader);
  }

  /* ── A diff view for one file ───────────────────────────────────────────
     Monaco when it loaded, a plain <pre> otherwise. Both report gutter clicks through
     `onAnchor`, so the commenting flow is identical either way. */
  function mountDiff(host, file, options) {
    options = options || {};
    var lines = parsePatch(file.patch);
    if (!lines.length) {
      lines = [{ text: "No textual diff (binary, rename, or too large to include).",
                 kind: "hunk", oldNo: null, newNo: null }];
    }
    var view = { lines: lines, editor: null, dispose: function () {}, paint: function () {},
                 reveal: function () {} };

    function marked() {
      var set = {};
      commentsFor(file.path).forEach(function (c) {
        if (c.line != null) set[c.side + ":" + c.line] = true;
      });
      return set;
    }

    if (!monacoState.ok) {
      var pre = el("pre", "fallback");
      if (options.autoHeight) pre.style.maxHeight = "520px";
      lines.forEach(function (line) {
        var row = el("div", "ln " + line.kind);
        var num = el("span", "n", line.kind === "hunk" ? "⋯"
          : (line.newNo != null ? String(line.newNo) : line.oldNo + " −"));
        num.addEventListener("click", function () {
          if (options.onAnchor) options.onAnchor(line);
        });
        row.appendChild(num);
        row.appendChild(el("span", "c",
          (line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ") + line.text));
        pre.appendChild(row);
      });
      host.appendChild(pre);
      view.dispose = function () { pre.remove(); };
      return view;
    }

    var box = el("div");
    box.style.height = options.autoHeight
      ? Math.min(Math.max(lines.length * 19 + 14, 90), 560) + "px"
      : "100%";
    host.appendChild(box);
    var editor = monaco.editor.create(box, {
      value: lines.map(function (l) { return l.text; }).join("\n"),
      language: languageOf(file.path),
      readOnly: true, automaticLayout: true, glyphMargin: true, minimap: { enabled: false },
      scrollBeyondLastLine: false, renderLineHighlight: "none", fontSize: 12.5,
      lineNumbersMinChars: 6, folding: false, wordWrap: "on", contextmenu: false,
      scrollbar: { alwaysConsumeMouseWheel: !options.autoHeight },
      fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace",
      theme: themeMode() === "dark" ? "hr-dark" : "hr-light",
      lineNumbers: function (n) {
        var line = lines[n - 1];
        if (!line) return "";
        if (line.kind === "hunk") return "⋯";
        return line.kind === "del" ? "−" + line.oldNo : String(line.newNo);
      }
    });
    var decorations = [];
    view.editor = editor;
    view.paint = function () {
      var set = marked();
      decorations = editor.deltaDecorations(decorations, lines.map(function (line, i) {
        var base = { add: "dec-add", del: "dec-del", hunk: "dec-hunk", ctx: "" }[line.kind];
        var a = anchorOf(line);
        var hit = a && set[a.side + ":" + a.line];
        return { range: new monaco.Range(i + 1, 1, i + 1, 1),
                 options: { isWholeLine: true, className: hit ? "dec-commented" : base,
                            glyphMarginClassName: hit ? "glyph-comment" : null } };
      }));
    };
    view.reveal = function (side, line) {
      for (var i = 0; i < lines.length; i++) {
        var a = anchorOf(lines[i]);
        if (a && a.side === side && a.line === line) {
          editor.revealLineInCenter(i + 1);
          editor.setPosition({ lineNumber: i + 1, column: 1 });
          return;
        }
      }
    };
    view.dispose = function () {
      var model = editor.getModel();
      editor.dispose();
      if (model) model.dispose();
      box.remove();
    };
    editor.onMouseDown(function (event) {
      var kinds = monaco.editor.MouseTargetType;
      if (event.target.type !== kinds.GUTTER_LINE_NUMBERS &&
          event.target.type !== kinds.GUTTER_GLYPH_MARGIN) return;
      var line = lines[event.target.position.lineNumber - 1];
      if (line && options.onAnchor) options.onAnchor(line);
    });
    view.paint();
    return view;
  }

  /* ── Export ─────────────────────────────────────────────────────────── */
  var INSTRUCTIONS =
    "A human read this change and left the comments below. Treat each one as a request " +
    "from the reviewer. kind=fix means change the code; kind=question means answer it in " +
    "your reply and only change code if the answer implies it; kind=nit is optional and " +
    "should be applied only if it is genuinely trivial; kind=praise needs no action. " +
    "`line` and `side` refer to the diff at target.head_sha: side=right is the new file, " +
    "side=left is the old one. Re-locate a comment if the branch has moved since. Do not " +
    "post anything to GitHub unless you are asked separately. Report per comment id what " +
    "you changed, what you verified, and anything you deliberately skipped.";

  var STACK_INSTRUCTIONS =
    "A human read a stack of pull requests and left the comments below, one entry in " +
    "`reviews` per PR, bottom of the stack first. Apply each entry exactly as a " +
    "human-review/comments@1 payload against its own target.branch and target.head_sha, " +
    "starting with the lowest PR, then restack the PRs above it. Ask before force-pushing " +
    "or rewriting a shared branch. Do not post anything to GitHub unless you are asked " +
    "separately. Report per PR and per comment id what you changed, what you verified, " +
    "and anything you deliberately skipped.";

  function payloadFor(p, s) {
    var files = {};
    p.files.forEach(function (f) { files[f.path] = f; });
    var read = function (path) { return !!s.read[path]; };
    return {
      format: "human-review/comments@1",
      generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      target: p.target,
      instructions: INSTRUCTIONS,
      review: { verdict: s.verdict, summary: (s.summary || "").trim() },
      comments: s.comments.map(function (c) {
        var f = files[c.path] || {};
        return { id: c.id, path: c.path, line: c.line, side: c.side, kind: c.kind,
                 body: c.body, code: c.code, weight: f.weight, rule: f.rule_id };
      }),
      progress: {
        read: p.order.filter(read),
        unread: p.order.filter(function (path) { return !read(path); }),
        skipped_by_rules: p.files.filter(function (f) { return f.weight === "skip"; })
                                 .map(function (f) { return f.path; })
      },
      stats: p.stats
    };
  }
  function exportPayload() {
    var payload = payloadFor(plan, state);
    if (stack) {
      payload.stack = { id: entry.id, parent: entry.parent,
                        position: prs.indexOf(entry) + 1, of: prs.length };
    }
    return payload;
  }
  /* The whole stack in one paste: every PR's payload, each read from its own record. */
  function exportStackPayload() {
    var total = 0;
    var reviews = prs.map(function (pr) {
      var payload = payloadFor(pr.plan, pr === entry ? state : loadState(keyOf(pr.plan.target)));
      total += payload.comments.length;
      // The envelope carries format, time and instructions once for every PR.
      delete payload.format; delete payload.generated_at; delete payload.instructions;
      return Object.assign({ id: pr.id, parent: pr.parent }, payload);
    });
    return {
      format: "human-review/stack-comments@1",
      generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      title: stack.title,
      trunk: stack.trunk,
      instructions: STACK_INSTRUCTIONS,
      comment_instructions: INSTRUCTIONS,
      counts: { prs: reviews.length, comments: total },
      reviews: reviews
    };
  }

  /* Wires the export dialog that both pages include verbatim. */
  function mountExport() {
    var overlay = document.getElementById("overlay");
    var verdict = document.getElementById("x-verdict");
    var summary = document.getElementById("x-summary");
    var scope = document.getElementById("x-scope");
    var whole = false;
    if (scope && stack) {
      scope.hidden = false;
      scope.addEventListener("change", function () { whole = scope.value === "stack"; refresh(); });
    }
    function current() { return whole ? exportStackPayload() : exportPayload(); }
    function refresh() {
      document.getElementById("x-format").textContent =
        whole ? "human-review/stack-comments@1" : "human-review/comments@1";
      document.getElementById("x-json").textContent = JSON.stringify(current(), null, 2);
    }
    [verdict, summary].forEach(function (node) {
      node.addEventListener("input", function () {
        state.verdict = verdict.value;
        state.summary = summary.value;
        save(); refresh();
      });
    });
    document.getElementById("x-close").addEventListener("click", function () {
      overlay.classList.remove("open");
    });
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) overlay.classList.remove("open");
    });
    document.getElementById("x-copy").addEventListener("click", function () {
      var payload = current();
      var count = whole ? payload.counts.comments : payload.comments.length;
      navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).then(function () {
        toast("Copied " + count + " comments" + (whole ? " across the stack" : ""));
      }, function () { toast("Copy blocked - use Download"); });
    });
    document.getElementById("x-download").addEventListener("click", function () {
      var blob = new Blob([JSON.stringify(current(), null, 2)], { type: "application/json" });
      var anchor = el("a");
      anchor.href = URL.createObjectURL(blob);
      anchor.download = whole ? "review-comments-stack.json"
        : "review-comments" + (target.number ? "-" + target.number : "") + ".json";
      anchor.click();
      setTimeout(function () { URL.revokeObjectURL(anchor.href); }, 2000);
    });
    // The record behind the dialog changes with the selected PR, so read it on open.
    return { open: function () {
               verdict.value = state.verdict;
               summary.value = state.summary;
               refresh();
               overlay.classList.add("open");
             },
             close: function () { overlay.classList.remove("open"); },
             refresh: refresh };
  }

  function mountTheme(host) {
    var wrap = el("span", "kinds theme");
    [["light", "Light"], ["dark", "Dark"], ["system", "Auto"]].forEach(function (option) {
      var button = el("button", "", option[1]);
      button.title = option[0] === "system" ? "Follow the system setting" : option[1] + " theme";
      button.setAttribute("aria-pressed", String(themeChoice() === option[0]));
      button.addEventListener("click", function () {
        setTheme(option[0]);
        wrap.querySelectorAll("button").forEach(function (other) {
          other.setAttribute("aria-pressed", String(other === button));
        });
      });
      wrap.appendChild(button);
    });
    host.appendChild(wrap);
  }

  function titleOf() {
    return target.title || target.range || "Change";
  }
  function metaOf() {
    return (target.repo || "") + (target.number ? " #" + target.number : "") +
           (stack ? " · PR " + (prs.indexOf(entry) + 1) + " of " + prs.length +
                    " · " + (target.branch || "") + " → " + (target.base || "") : "") +
           (target.head_sha ? " @" + String(target.head_sha).slice(0, 7) : "") +
           (plan.config && plan.config.name ? " · rules: " + plan.config.name : "");
  }

  applyTheme();
  loadMonaco();

  return Object.assign(api, {
    LABEL: LABEL, stack: stack, prs: prs, VIEWS: VIEWS,
    select: select, save: save, el: el, toast: toast,
    parseRoute: parseRoute, link: link, prLabel: prLabel, byId: byId, elsewhere: elsewhere,
    progressOf: progressOf, relationOf: relationOf, renderStack: renderStack, stepTarget: stepTarget,
    parsePatch: parsePatch, anchorOf: anchorOf, languageOf: languageOf,
    isRead: isRead, setRead: setRead, tallyRead: tallyRead,
    commentsFor: commentsFor, addComment: addComment, removeComment: removeComment,
    buildTree: buildTree, filesUnder: filesUnder, sortedDirs: sortedDirs,
    collapsed: collapsed, setCollapsed: setCollapsed,
    onMonaco: onMonaco, mountDiff: mountDiff,
    themeChoice: themeChoice, themeMode: themeMode, mountTheme: mountTheme,
    exportPayload: exportPayload, exportStackPayload: exportStackPayload, mountExport: mountExport,
    titleOf: titleOf, metaOf: metaOf, mountSummary: mountSummary
  });
})();
