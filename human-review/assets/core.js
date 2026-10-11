/* Shared engine for the reading plan and the review tool.
   Both pages read the same embedded plan and the same localStorage record, so a file
   marked read in one is read in the other. */
window.HR = (function () {
  "use strict";
  var MONACO = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs";
  var plan = JSON.parse(document.getElementById("plan").textContent);
  var target = plan.target;
  var byPath = {};
  plan.files.forEach(function (f) { byPath[f.path] = f; });

  var KEY = "human-review:" + (target.repo || "") + ":" +
            (target.number || target.range || "") + ":" + (target.head_sha || "").slice(0, 12);
  var LABEL = { critical: "Stop and read", read: "Read", skim: "Skim", skip: "Skipped" };
  var LANG = { rb: "ruby", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", yml: "yaml", yaml: "yaml", md: "markdown", html: "html", erb: "html", css: "css",
    scss: "scss", sql: "sql", sh: "shell", rake: "ruby", py: "python", toml: "ini", lock: "ini",
    gemspec: "ruby", ru: "ruby", jbuilder: "ruby", vue: "html", graphql: "graphql" };

  var state = (function () {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || "{}");
      return { read: raw.read || {}, comments: raw.comments || [], seq: raw.seq || 0,
               collapsed: raw.collapsed || {}, verdict: raw.verdict || "comment",
               summary: raw.summary || "" };
    } catch (e) {
      return { read: {}, comments: [], seq: 0, collapsed: {}, verdict: "comment", summary: "" };
    }
  })();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }

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

  function exportPayload() {
    return {
      format: "human-review/comments@1",
      generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      target: target,
      instructions: INSTRUCTIONS,
      review: { verdict: state.verdict, summary: (state.summary || "").trim() },
      comments: state.comments.map(function (c) {
        var f = byPath[c.path] || {};
        return { id: c.id, path: c.path, line: c.line, side: c.side, kind: c.kind,
                 body: c.body, code: c.code, weight: f.weight, rule: f.rule_id };
      }),
      progress: {
        read: plan.order.filter(isRead),
        unread: plan.order.filter(function (p) { return !isRead(p); }),
        skipped_by_rules: plan.files.filter(function (f) { return f.weight === "skip"; })
                                    .map(function (f) { return f.path; })
      },
      stats: plan.stats
    };
  }

  /* Wires the export dialog that both pages include verbatim. */
  function mountExport() {
    var overlay = document.getElementById("overlay");
    var verdict = document.getElementById("x-verdict");
    var summary = document.getElementById("x-summary");
    verdict.value = state.verdict;
    summary.value = state.summary;
    function refresh() {
      document.getElementById("x-json").textContent =
        JSON.stringify(exportPayload(), null, 2);
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
      navigator.clipboard.writeText(JSON.stringify(exportPayload(), null, 2)).then(function () {
        toast("Copied " + state.comments.length + " comments");
      }, function () { toast("Copy blocked - use Download"); });
    });
    document.getElementById("x-download").addEventListener("click", function () {
      var blob = new Blob([JSON.stringify(exportPayload(), null, 2)], { type: "application/json" });
      var link = el("a");
      link.href = URL.createObjectURL(blob);
      link.download = "review-comments" + (target.number ? "-" + target.number : "") + ".json";
      link.click();
      setTimeout(function () { URL.revokeObjectURL(link.href); }, 2000);
    });
    return { open: function () { refresh(); overlay.classList.add("open"); },
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
           (target.head_sha ? " @" + String(target.head_sha).slice(0, 7) : "") +
           (plan.config && plan.config.name ? " · rules: " + plan.config.name : "");
  }

  applyTheme();
  loadMonaco();

  return {
    plan: plan, target: target, byPath: byPath, state: state, LABEL: LABEL,
    save: save, el: el, toast: toast,
    parsePatch: parsePatch, anchorOf: anchorOf, languageOf: languageOf,
    isRead: isRead, setRead: setRead, tallyRead: tallyRead,
    commentsFor: commentsFor, addComment: addComment, removeComment: removeComment,
    buildTree: buildTree, filesUnder: filesUnder, sortedDirs: sortedDirs,
    collapsed: collapsed, setCollapsed: setCollapsed,
    onMonaco: onMonaco, mountDiff: mountDiff,
    themeChoice: themeChoice, themeMode: themeMode, mountTheme: mountTheme,
    exportPayload: exportPayload, mountExport: mountExport,
    titleOf: titleOf, metaOf: metaOf
  };
})();
