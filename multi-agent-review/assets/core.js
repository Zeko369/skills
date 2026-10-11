/* multi-agent-review shared runtime, inlined into every theme.
 * Owns filter state, faceted counts, the PR stack hierarchy, answers (fix by default, ignore, comment),
 * pins, URL state, keyboard shortcuts, panel resizing, and safe DOM builders. state.view (URL `view=`)
 * is a free slot for theme view modes. Themes call MultiAgentReview.create(), build their layout with
 * app.h()/app.ui.*, render findings from app.view(), and finish with app.start().
 * Report text is inserted with textContent only; never route report data through innerHTML. */
(function () {
  'use strict';

  const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];
  const SEVERITY_LABELS = { P0: 'Critical', P1: 'High', P2: 'Medium', P3: 'Low' };
  const DISPOSITIONS = ['confirmed', 'needs validation', 'disputed', 'rejected'];
  const CONFIDENCES = ['high', 'medium', 'low'];
  /* Every finding is approved for fixing unless the coordinator rejected it; the user ignores the rest. */
  const ANSWERS = ['fix', 'ignore'];
  const ANSWER_LABELS = { fix: 'Fix', ignore: 'Ignore' };
  const FACETS = ['severity', 'disposition', 'reviewer', 'pr', 'confidence', 'tag', 'answer'];
  const FACET_LABELS = { severity: 'Severity', disposition: 'Disposition', reviewer: 'Raised by', pr: 'Pull request', confidence: 'Confidence', tag: 'Tags', answer: 'Your answer' };
  const HASH_KEYS = { severity: 'sev', disposition: 'disp', reviewer: 'rev', pr: 'pr', confidence: 'conf', tag: 'tag', answer: 'ans' };
  const ANSWERS_FORMAT = 'multi-agent-review/answers@1';
  const ANSWERS_INSTRUCTIONS = 'Fix every finding in `fix`, bottom of the stack first when `stack` is present. A `comment` is the reviewer\'s own instruction and overrides `recommendation`. '
    + 'Confirm `needs validation` and `disputed` findings before changing code, and report any that do not reproduce instead of fixing them. '
    + 'Do not change code for findings in `ignore`. Afterwards, report what changed per finding id and which checks ran.';
  const NO_PR = '(none)';
  const CROSS_PR = '(cross)';
  const PRESETS = {
    actionable: { label: 'Actionable', hint: 'P0–P2 that are not rejected', severity: ['P0', 'P1', 'P2'], disposition: ['confirmed', 'needs validation', 'disputed'] },
    blocking: { label: 'Blocking', hint: 'P0–P1 that are confirmed or still need validation', severity: ['P0', 'P1'], disposition: ['confirmed', 'needs validation'] },
    disagreements: { label: 'Disagreements', hint: 'Disputed and rejected candidates', disposition: ['disputed', 'rejected'] },
    all: { label: 'Everything', hint: 'Clear every filter' },
  };
  const FIELDS = [
    ['location', 'Location'], ['trigger', 'Trigger'], ['impact', 'Impact'], ['evidence', 'Evidence'],
    ['recommendation', 'Suggested correction'], ['decision', 'Coordinator decision'], ['validation', 'Validation limits'],
  ];
  const GROUPS = { none: 'No grouping', pr: 'Pull request', severity: 'Severity', disposition: 'Disposition' };
  const SORTS = { severity: 'Severity', disposition: 'Disposition', pr: 'Stack order', id: 'ID' };

  const unique = (values) => Array.from(new Set(values));
  const norm = (value) => String(value == null ? '' : value).trim().toLowerCase();
  const capitalize = (value) => value.charAt(0).toUpperCase() + value.slice(1);
  const byNumericId = (a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true });

  function safeUrl(value) {
    try { return ['http:', 'https:'].includes(new URL(String(value)).protocol); } catch (_) { return false; }
  }

  /** Drop null, undefined, and empty-string values so exported JSON stays compact. */
  function compact(obj) {
    const out = {};
    for (const [key, value] of Object.entries(obj)) if (value != null && value !== '') out[key] = value;
    return out;
  }

  /** Rendered and not inside a closed <details> or [hidden] ancestor (getClientRects alone misses closed details in Chrome). */
  function isShown(el) {
    if (!el || !el.getClientRects().length) return false;
    return typeof el.checkVisibility === 'function' ? el.checkVisibility() : !el.closest('details:not([open]) > :not(summary), [hidden]');
  }
  /** Prefer the visible element when a control is rendered twice (e.g. inline row details and the drawer). */
  function byFocusKey(key) {
    const all = Array.from(document.querySelectorAll(`[data-focus-key="${CSS.escape(key)}"]`));
    return all.find(isShown) || null;
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {
      const area = h('textarea', { style: 'position:fixed;top:0;left:0;opacity:0' }, text);
      document.body.append(area); area.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (__) { ok = false; }
      area.remove(); return ok;
    }
  }

  /** Build an element. Children may be nodes, strings, numbers, arrays, or null. */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'dataset') { for (const [k, v] of Object.entries(value)) if (v != null) el.dataset[k] = v; }
      else if (key === 'style') el.style.cssText = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'href') { if (safeUrl(value) || String(value).startsWith('#')) el.setAttribute('href', value); }
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  /* Stack layout: depth is true distance from the trunk; lane is a git-graph row where the first
     child continues its parent's lane and later siblings fork into new lanes; indent counts forks. */
  function buildStack(entries) {
    const byId = new Map(entries.map((entry, index) => [entry.id, Object.assign({}, entry, { index, children: [] })]));
    const roots = [];
    for (const node of byId.values()) {
      node.parentEntry = node.parent != null ? byId.get(node.parent) || null : null;
      (node.parentEntry ? node.parentEntry.children : roots).push(node);
    }
    const order = [];
    let lanes = 0;
    const walk = (node, depth, trail, lane, indent, forked) => {
      Object.assign(node, { depth, trail, lane, indent, forked, order: order.length });
      order.push(node);
      node.children.forEach((child, i) => {
        child.isLast = i === node.children.length - 1;
        walk(child, depth + 1, depth === 0 ? [] : trail.concat(!node.isLast), i === 0 ? lane : ++lanes, indent + (i === 0 ? 0 : 1), i > 0);
      });
    };
    roots.forEach((root, i) => { root.isLast = i === roots.length - 1; walk(root, 0, [], i === 0 ? 0 : ++lanes, 0, false); });
    const ancestors = (id) => { const out = []; let node = byId.get(id); while (node && node.parentEntry) { node = node.parentEntry; out.push(node.id); } return out; };
    const descendants = (id) => { const out = []; const visit = (node) => node.children.forEach((c) => { out.push(c.id); visit(c); }); const n = byId.get(id); if (n) visit(n); return out; };
    const trunk = unique(roots.map((r) => r.base).filter(Boolean)).join(', ') || 'trunk';
    return { order, byId, roots, ancestors, descendants, trunk, maxDepth: Math.max(0, ...order.map((n) => n.depth)), laneCount: lanes + 1 };
  }

  function create() {
    const data = JSON.parse(document.getElementById('report-data').textContent);
    const findings = data.findings;
    const byId = new Map(findings.map((f) => [f.id, f]));
    const stack = buildStack(data.stack || []);
    /* One PR is a single review target, not a stack: stack views, the PR facet, and PR grouping need at least two. */
    const hasStack = stack.order.length > 1;
    const soloPR = stack.order.length === 1 ? stack.order[0] : null;
    const reviewerNames = unique(data.reviewers.map((r) => r.name).concat(...findings.map((f) => f.reviewers)));
    const reviewerIndex = (name) => Math.max(0, reviewerNames.indexOf(name)) % 6;
    const prLabel = (id) => { const n = stack.byId.get(id); if (!n) return id === NO_PR ? 'No PR' : String(id); return n.number != null ? `#${n.number}` : n.id; };
    const searchText = new Map(findings.map((f) => [f.id, norm([
      f.id, f.title, f.severity, f.disposition, f.confidence, f.reviewers.join(' '), f.tags.join(' '),
      f.prs.map((p) => `${prLabel(p)} ${(stack.byId.get(p) || {}).title || ''}`).join(' '),
      ...FIELDS.map(([key]) => f[key] || ''),
    ].join(' '))]));

    const confidences = unique(findings.map((f) => norm(f.confidence)).filter(Boolean));
    confidences.sort((a, b) => (CONFIDENCES.indexOf(a) + 1 || 99) - (CONFIDENCES.indexOf(b) + 1 || 99) || a.localeCompare(b));
    const options = {
      severity: SEVERITIES.map((v) => ({ value: v, label: v, hint: SEVERITY_LABELS[v] })),
      disposition: DISPOSITIONS.map((v) => ({ value: v, label: capitalize(v) })),
      reviewer: reviewerNames.map((v) => ({ value: v, label: v })),
      pr: hasStack ? stack.order.map((n) => ({ value: n.id, label: prLabel(n.id), hint: n.title, node: n }))
        .concat(findings.some((f) => !f.prs.length) ? [{ value: NO_PR, label: 'No PR', hint: 'Findings not tied to one pull request' }] : []) : [],
      confidence: confidences.map((v) => ({ value: v, label: capitalize(v) })),
      tag: unique(findings.flatMap((f) => f.tags)).sort().map((v) => ({ value: v, label: v })),
      answer: findings.length ? [
        { value: 'fix', label: 'Fix', hint: 'Approved for fixing; included in the copied answers' },
        { value: 'ignore', label: 'Ignore', hint: 'Left out of the fix list' },
      ] : [],
    };

    /* Local state is keyed by report, so every design rendered from one report.json shares it. */
    const storeKey = `multi-agent-review:${data.meta.key}`;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(storeKey) || '{}') || {}; } catch (_) { saved = {}; }
    const pinned = new Set((saved.pinned || []).filter((id) => byId.has(id)));
    const answers = {};
    for (const [id, value] of Object.entries(saved.answers || {})) if (byId.has(id) && ANSWERS.includes(value)) answers[id] = value;
    for (const id of saved.hidden || []) if (byId.has(id) && !answers[id]) answers[id] = 'ignore'; // hides saved before answers existed
    const comments = {};
    for (const [id, text] of Object.entries(saved.comments || {})) if (byId.has(id) && typeof text === 'string' && text.trim()) comments[id] = text;
    const sections = Object.assign({}, saved.sections);
    const sectionDefaults = {};
    const sizes = Object.assign({}, saved.sizes);
    const themeStore = Object.assign({}, saved.theme);
    const persist = () => {
      try { localStorage.setItem(storeKey, JSON.stringify({ pinned: [...pinned], answers, comments, sections, sizes, theme: themeStore })); } catch (_) { /* storage blocked: keep state in memory */ }
    };
    const defaultAnswer = (f) => (f.disposition === 'rejected' ? 'ignore' : 'fix');
    const answerOf = (id) => answers[id] || (byId.has(id) ? defaultAnswer(byId.get(id)) : 'fix');
    const commentOf = (id) => (comments[id] || '').trim();
    function answerNote(id) {
      const f = byId.get(id);
      if (!answers[id]) return f.disposition === 'rejected' ? 'Ignored by default: the coordinator rejected it' : 'Approved by default';
      return answers[id] === 'ignore' ? 'Ignored by you' : 'Fix requested by you, although the coordinator rejected it';
    }

    const valuesOf = (f, facet) => {
      switch (facet) {
        case 'severity': return [f.severity];
        case 'disposition': return [f.disposition];
        case 'reviewer': return f.reviewers;
        case 'pr': return f.prs.length ? f.prs : [NO_PR];
        case 'confidence': return [norm(f.confidence)];
        case 'answer': return [answerOf(f.id)];
        default: return f.tags;
      }
    };

    const defaults = () => ({
      q: '', severity: new Set(), disposition: new Set(), reviewer: new Set(), pr: new Set(), confidence: new Set(), tag: new Set(), answer: new Set(),
      pinnedOnly: false, prInherited: false, groupBy: hasStack ? 'pr' : 'severity', sort: 'severity', selected: null, view: '', drawerFull: false,
    });
    const state = defaults();
    const open = new Set();
    const listeners = [];
    const refreshers = [];
    let searchInput = null;
    let focusAfterChange = null;
    /* Key specs: 'j / k' is a pair, 'i or r' are alternatives. Answer keys act only while a finding's answer block is on screen. */
    const SHORTCUTS = [
      { group: 'Move', keys: [['j / k', 'Next / previous finding'], ['f', 'Full-screen the open finding (toggle)'], ['o', 'Expand or collapse inline details'], ['/', 'Search'], ['Esc', 'Leave a text field, exit full screen, then close the finding']] },
      { group: 'Answer the open finding', keys: [['a', 'Fix (the default)'], ['i or r', 'Ignore (reject)'], ['x', 'Toggle fix / ignore'], ['c', 'Comment'], ['p', 'Pin']] },
      { group: 'Help', keys: [['?', 'Show this cheatsheet']] },
    ];
    const extraShortcuts = [];
    const shortcutGroups = () => SHORTCUTS.slice(0, 2).concat(extraShortcuts, SHORTCUTS.slice(2));
    const keyCaps = (spec) => spec.split(/\s+(or|\/)\s+/).map((part, i) => (i % 2 ? h('span', { class: 'kbd-or' }, ` ${part} `) : h('kbd', null, part)));
    const shortcutList = (groups) => groups.map((g) => h('section', { class: 'shortcut-group' }, h('h3', { class: 'shortcut-group-title' }, g.group),
      h('dl', null, g.keys.map(([spec, text]) => [h('dt', null, keyCaps(spec)), h('dd', null, text)]))));
    let sheet = null;
    let sheetReturn = null;
    function openSheet() {
      if (sheet) return;
      sheetReturn = document.activeElement;
      const close = h('button', { type: 'button', class: 'shortcut-close', 'aria-label': 'Close keyboard shortcuts', onclick: () => closeSheet() }, '×');
      sheet = h('div', { class: 'shortcut-overlay', onclick: (event) => { if (event.target === sheet) closeSheet(); } },
        h('div', { class: 'shortcut-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'shortcut-title' },
          h('div', { class: 'shortcut-head' }, h('h2', { class: 'shortcut-title', id: 'shortcut-title' }, 'Keyboard shortcuts'), close),
          h('div', { class: 'shortcut-groups' }, shortcutList(shortcutGroups())),
          h('p', { class: 'shortcut-foot' }, 'Shortcuts pause while you type in a field; Esc leaves it. Press ? or Esc to close.')));
      document.body.append(sheet);
      close.focus();
    }
    function closeSheet() {
      if (!sheet) return;
      sheet.remove();
      sheet = null;
      if (sheetReturn && sheetReturn.isConnected) sheetReturn.focus({ preventScroll: true });
      sheetReturn = null;
    }
    /* While the cheatsheet is open it owns the keyboard; this capture listener runs before any theme listener. */
    window.addEventListener('keydown', (event) => {
      if (!sheet) return;
      if (event.key === 'Escape' || event.key === '?') closeSheet();
      else if (event.key === 'Tab') sheet.querySelector('.shortcut-close').focus();
      else if (event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);

    function readHash() {
      const params = new URLSearchParams(location.hash.replace(/^#/, ''));
      Object.assign(state, defaults());
      state.q = params.get('q') || '';
      for (const facet of FACETS) {
        const allowed = new Set(options[facet].map((o) => o.value));
        state[facet] = new Set(params.getAll(HASH_KEYS[facet]).filter((v) => allowed.has(v)));
      }
      state.pinnedOnly = params.get('pinned') === '1';
      state.prInherited = params.get('inherit') === '1';
      if (GROUPS[params.get('group')] && (params.get('group') !== 'pr' || hasStack)) state.groupBy = params.get('group');
      if (SORTS[params.get('sort')]) state.sort = params.get('sort');
      if (byId.has(params.get('f'))) { state.selected = params.get('f'); open.add(state.selected); }
      if (/^[a-z][a-z0-9-]{0,31}$/.test(params.get('view') || '')) state.view = params.get('view');
      state.drawerFull = Boolean(state.selected) && params.get('full') === '1';
    }
    function writeHash() {
      const params = new URLSearchParams();
      if (state.q) params.set('q', state.q);
      for (const facet of FACETS) state[facet].forEach((v) => params.append(HASH_KEYS[facet], v));
      if (state.pinnedOnly) params.set('pinned', '1');
      if (state.prInherited) params.set('inherit', '1');
      if (state.groupBy !== defaults().groupBy) params.set('group', state.groupBy);
      if (state.sort !== 'severity') params.set('sort', state.sort);
      if (state.selected) params.set('f', state.selected);
      if (state.view) params.set('view', state.view);
      if (state.drawerFull) params.set('full', '1');
      const hash = params.toString();
      try { history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search); } catch (_) { /* some file:// contexts reject replaceState */ }
    }

    function matches(f, except) {
      if (state.pinnedOnly && !pinned.has(f.id)) return false;
      if (state.q) { const text = searchText.get(f.id); if (!norm(state.q).split(/\s+/).every((term) => text.includes(term))) return false; }
      for (const facet of FACETS) {
        if (facet === except || !state[facet].size) continue;
        let selected = state[facet];
        if (facet === 'pr' && state.prInherited) selected = new Set([...selected].flatMap((id) => [id, ...stack.ancestors(id)]));
        if (!valuesOf(f, facet).some((v) => selected.has(v))) return false;
      }
      return true;
    }
    function counts(facet) {
      const out = new Map();
      for (const f of findings) if (matches(f, facet)) for (const v of valuesOf(f, facet)) out.set(v, (out.get(v) || 0) + 1);
      return out;
    }
    /** Per-PR severity breakdown under every filter except the PR filter itself. */
    function prBreakdown() {
      const out = new Map(stack.order.map((n) => [n.id, { total: 0, P0: 0, P1: 0, P2: 0, P3: 0 }]));
      for (const f of findings) {
        if (!matches(f, 'pr')) continue;
        for (const id of f.prs) { const row = out.get(id); if (row) { row.total += 1; row[f.severity] += 1; } }
      }
      return out;
    }

    const rank = (list, value) => { const i = list.indexOf(value); return i < 0 ? list.length : i; };
    const prOrder = (f) => (f.prs.length ? Math.min(...f.prs.map((p) => (stack.byId.get(p) || { order: 999 }).order)) + (f.prs.length > 1 ? 0.5 : 0) : 1000);
    const SORTERS = {
      severity: (a, b) => rank(SEVERITIES, a.severity) - rank(SEVERITIES, b.severity) || rank(DISPOSITIONS, a.disposition) - rank(DISPOSITIONS, b.disposition) || prOrder(a) - prOrder(b) || byNumericId(a, b),
      disposition: (a, b) => rank(DISPOSITIONS, a.disposition) - rank(DISPOSITIONS, b.disposition) || rank(SEVERITIES, a.severity) - rank(SEVERITIES, b.severity) || byNumericId(a, b),
      pr: (a, b) => prOrder(a) - prOrder(b) || rank(SEVERITIES, a.severity) - rank(SEVERITIES, b.severity) || byNumericId(a, b),
      id: byNumericId,
    };
    function groupDefs() {
      if (state.groupBy === 'severity') return SEVERITIES.map((v) => ({ key: v, label: `${v} · ${SEVERITY_LABELS[v]}`, severity: v, canonical: true, test: (f) => f.severity === v }));
      if (state.groupBy === 'disposition') return DISPOSITIONS.map((v) => ({ key: v, label: capitalize(v), disposition: v, canonical: true, test: (f) => f.disposition === v }));
      if (state.groupBy === 'pr' && hasStack) {
        return stack.order.map((n) => ({ key: n.id, label: `${prLabel(n.id)} ${n.title}`, pr: n, canonical: true, test: (f) => f.prs.length === 1 && f.prs[0] === n.id }))
          .concat({ key: CROSS_PR, label: 'Spans several PRs', test: (f) => f.prs.length > 1 }, { key: NO_PR, label: 'Not tied to a PR', test: (f) => !f.prs.length });
      }
      return [{ key: 'all', label: 'All findings', canonical: true, test: () => true }];
    }
    /** Visible findings, sorted (pinned first) and grouped. keepEmpty keeps canonical groups with no items. */
    function view(opts) {
      const keepEmpty = opts && opts.keepEmpty;
      const sorter = SORTERS[state.sort] || SORTERS.severity;
      const visible = findings.filter((f) => matches(f)).sort((a, b) => (pinned.has(b.id) - pinned.has(a.id)) || sorter(a, b));
      const groups = groupDefs().map((g) => Object.assign({}, g, { items: visible.filter(g.test) })).filter((g) => g.items.length || (keepEmpty && g.canonical));
      return { groups, flat: groups.flatMap((g) => g.items), visible, total: findings.length };
    }

    function notify(reason, detail, opts) {
      const active = document.activeElement;
      const focusKey = active && active.dataset ? active.dataset.focusKey : null;
      if (!state.selected) state.drawerFull = false;
      document.documentElement.toggleAttribute('data-drawer-full', state.drawerFull);
      if (reason !== 'open') { writeHash(); refreshers.forEach((fn) => fn()); }
      listeners.forEach((fn) => fn(reason, detail));
      syncFindingElements(reason === 'select' && !(opts && opts.scroll === false));
      const next = focusAfterChange;
      focusAfterChange = null;
      if (focusKey && (!document.activeElement || document.activeElement === document.body)) {
        // A finding that left the view took its controls along; move focus to the same control on the next finding.
        const sameControl = next && focusKey.includes(':') ? `${focusKey.slice(0, focusKey.lastIndexOf(':'))}:${next}` : null;
        const target = (sameControl && byFocusKey(sameControl))
          || byFocusKey(focusKey)
          || (next && findingElement(next) && findingElement(next).querySelector('button,[href],[tabindex]:not([tabindex="-1"])'));
        if (target) target.focus({ preventScroll: true });
      }
    }
    /** First rendered element for a finding; themes may render a finding more than once (e.g. board + matrix). */
    function findingElement(id) {
      if (!id) return null;
      const all = Array.from(document.querySelectorAll(`[data-finding-id="${CSS.escape(id)}"]`));
      return all.find((el) => el.getClientRects().length) || all[0] || null;
    }
    /* Finding elements get data-selected, data-pinned, data-answer="fix|ignore", data-ignored, and
       data-commented. Answer and pin controls built by app.ui stay in sync here, so themes need not re-render them. */
    function syncFindingElements(scroll) {
      document.querySelectorAll('[data-finding-id]').forEach((el) => {
        const id = el.dataset.findingId;
        const answer = answerOf(id);
        el.toggleAttribute('data-selected', id === state.selected);
        el.toggleAttribute('data-pinned', pinned.has(id));
        el.dataset.answer = answer;
        el.toggleAttribute('data-ignored', answer === 'ignore');
        el.toggleAttribute('data-commented', Boolean(commentOf(id)));
      });
      syncAnswerControls();
      document.querySelectorAll('[data-pin-for]').forEach((el) => {
        const on = pinned.has(el.dataset.pinFor);
        el.setAttribute('aria-pressed', String(on));
        el.textContent = on ? 'Unpin' : 'Pin';
      });
      document.querySelectorAll('details[data-open-for]').forEach((el) => { el.open = open.has(el.dataset.openFor); });
      if (scroll) { const el = findingElement(state.selected); if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    }
    function syncAnswerControls() {
      document.querySelectorAll('[data-answer-for]').forEach((el) => {
        const id = el.dataset.answerFor;
        const answer = answerOf(id);
        el.dataset.answer = answer;
        if (el.hasAttribute('data-answer-toggle')) el.setAttribute('aria-pressed', String(answer === 'ignore'));
        el.querySelectorAll('[data-answer-value]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.answerValue === answer)));
        const note = el.querySelector('.answer-note');
        if (note) note.textContent = answerNote(id);
      });
    }
    /** Apply answers, keeping selection and focus on a neighbour when a finding leaves the filtered view. */
    function changeAnswers(ids, value) {
      ids = ids.filter((id) => byId.has(id));
      if (!ids.length) return;
      const before = view().flat;
      for (const id of ids) {
        if (value == null || value === defaultAnswer(byId.get(id))) delete answers[id];
        else answers[id] = value;
      }
      persist();
      const gone = (id) => !matches(byId.get(id));
      const neighbour = (id) => {
        const at = before.findIndex((f) => f.id === id);
        if (at < 0) return null;
        for (let i = at + 1; i < before.length; i += 1) if (!gone(before[i].id)) return before[i].id;
        for (let i = at - 1; i >= 0; i -= 1) if (!gone(before[i].id)) return before[i].id;
        return null;
      };
      if (ids.length === 1 && gone(ids[0])) focusAfterChange = neighbour(ids[0]);
      if (state.selected && gone(state.selected)) state.selected = neighbour(state.selected);
      notify('filter', { answer: ids });
    }
    function answersReport() {
      const prRef = (id) => { const n = stack.byId.get(id); return n ? compact({ id: n.id, number: n.number, branch: n.branch, title: n.title }) : { id }; };
      const ordered = findings.slice().sort(SORTERS.pr);
      const base = (f) => compact({
        id: f.id, title: f.title, severity: f.severity, disposition: f.disposition, confidence: f.confidence,
        prs: f.prs.length ? f.prs.map(prRef) : null, location: f.location,
      });
      const fix = ordered.filter((f) => answerOf(f.id) === 'fix').map((f) => compact(Object.assign(base(f), {
        trigger: f.trigger, impact: f.impact, evidence: f.evidence, recommendation: f.recommendation, decision: f.decision, validation: f.validation,
        comment: commentOf(f.id), decided_by: answers[f.id] ? 'you' : null,
      })));
      const ignore = ordered.filter((f) => answerOf(f.id) === 'ignore').map((f) => compact(Object.assign(base(f), {
        comment: commentOf(f.id), decided_by: answers[f.id] ? 'you' : 'default: rejected by the coordinator',
      })));
      return compact({
        format: ANSWERS_FORMAT,
        instructions: ANSWERS_INSTRUCTIONS,
        answered_at: new Date().toISOString(),
        report: compact({
          title: data.title, verdict: data.verdict, status: data.status, generated_at: data.generated_at, snapshot_id: data.snapshot_id,
          key: data.meta.key, target: data.target.length ? Object.fromEntries(data.target) : null,
        }),
        stack: stack.order.length ? stack.order.map((n) => compact({ id: n.id, number: n.number, title: n.title, branch: n.branch, base: n.base, parent: n.parent, head: n.head })) : null,
        counts: { fix: fix.length, ignore: ignore.length, comments: Object.keys(comments).filter((id) => commentOf(id)).length },
        fix, ignore,
      });
    }
    document.addEventListener('toggle', (event) => {
      const el = event.target;
      if (!el.dataset || !el.dataset.openFor || el.open === open.has(el.dataset.openFor)) return;
      if (el.open) open.add(el.dataset.openFor); else open.delete(el.dataset.openFor);
    }, true);

    const app = {
      data, findings, byId, stack, hasStack, soloPR, options, state, h,
      constants: { SEVERITIES, SEVERITY_LABELS, DISPOSITIONS, ANSWERS, ANSWER_LABELS, ANSWERS_FORMAT, FACETS, FACET_LABELS, PRESETS, FIELDS, GROUPS, SORTS, NO_PR, CROSS_PR },
      view, counts, prBreakdown, matches, findingElement, prLabel, reviewerIndex, safeUrl, copyText, isShown,
      /** Re-apply data-selected/-pinned/-answer/-ignored/-commented and details state after a theme-local re-render. */
      sync: () => syncFindingElements(false),
      subscribe(fn) { listeners.push(fn); return app; },
      toggle(facet, value, solo) {
        const set = state[facet];
        if (solo) { const only = set.size === 1 && set.has(value); set.clear(); if (!only) set.add(value); }
        else if (set.has(value)) set.delete(value); else set.add(value);
        notify('filter');
      },
      setFacet(facet, values) { state[facet] = new Set(values); notify('filter'); },
      set(key, value) { state[key] = value; notify(key === 'selected' ? 'select' : 'filter'); },
      applyPreset(name) {
        const preset = PRESETS[name];
        FACETS.forEach((facet) => { state[facet] = new Set(preset[facet] || []); });
        if (name === 'all') { state.q = ''; state.pinnedOnly = false; state.prInherited = false; }
        notify('filter');
      },
      presetActive(name) {
        const preset = PRESETS[name];
        return FACETS.every((facet) => { const want = preset[facet] || []; return state[facet].size === want.length && want.every((v) => state[facet].has(v)); })
          && (name !== 'all' || (!state.q && !state.pinnedOnly));
      },
      reset() { const keep = { groupBy: state.groupBy, sort: state.sort, selected: state.selected, view: state.view }; Object.assign(state, defaults(), keep); notify('filter'); },
      isFiltered() { return Boolean(state.q || state.pinnedOnly || FACETS.some((f) => state[f].size)); },
      /** Select a finding (null clears). Pass { scroll: false } to keep the page where it is. */
      select(id, opts) { state.selected = id && byId.has(id) ? id : null; notify('select', state.selected, opts); },
      /**
       * Full-screen reading mode for the open finding (key f). Core sets html[data-drawer-full] and forces
       * --drawer-width to 100vw; themes add any layout rules they need. Opening with nothing selected picks the
       * first shown finding. Closing the finding leaves the mode. Notifies 'select' or 'layout'.
       */
      isDrawerFull: () => state.drawerFull,
      setDrawerFull(value) {
        let reason = 'layout';
        if (value && !state.selected) {
          const first = view().flat[0];
          if (!first) return;
          state.selected = first.id;
          reason = 'select';
        }
        state.drawerFull = Boolean(value && state.selected);
        notify(reason, reason === 'select' ? state.selected : state.drawerFull);
      },
      toggleDrawerFull() { app.setDrawerFull(!state.drawerFull); },
      /** Add theme keys to the ? cheatsheet and the inline legend: addShortcuts('View', [['v', 'Cycle views']]). */
      addShortcuts(group, keys) { extraShortcuts.push({ group, keys }); },
      openShortcuts: () => openSheet(),
      move(delta) {
        const flat = view().flat;
        if (!flat.length) return;
        const at = flat.findIndex((f) => f.id === state.selected);
        const next = at < 0 ? (delta > 0 ? 0 : flat.length - 1) : Math.min(flat.length - 1, Math.max(0, at + delta));
        app.select(flat[next].id);
      },
      isOpen: (id) => open.has(id),
      setOpen(id, value) { if (value) open.add(id); else open.delete(id); notify('open', id); },
      expandAll(value) { open.clear(); if (value) view().flat.forEach((f) => open.add(f.id)); notify('open'); },
      isPinned: (id) => pinned.has(id),
      pinnedCount: () => pinned.size,
      togglePinned(id) { if (pinned.has(id)) pinned.delete(id); else pinned.add(id); persist(); notify('filter'); },
      clearPins() { pinned.clear(); persist(); notify('filter'); },
      /* Answers: 'fix' (the default) or 'ignore' (the default for coordinator-rejected findings), plus a free-text comment. */
      answer: answerOf,
      isIgnored: (id) => answerOf(id) === 'ignore',
      /** True when the user chose this answer rather than inheriting the default. */
      answerChanged: (id) => Boolean(answers[id]),
      answerNote,
      /** Set one finding's answer; null restores the default. */
      setAnswer(id, value) { changeAnswers([id], value); },
      setAnswers(ids, value) { changeAnswers(ids, value); },
      toggleAnswer(id) { changeAnswers([id], answerOf(id) === 'ignore' ? 'fix' : 'ignore'); },
      answerCounts() {
        let fix = 0;
        findings.forEach((f) => { if (answerOf(f.id) === 'fix') fix += 1; });
        return { fix, ignore: findings.length - fix, comments: findings.filter((f) => commentOf(f.id)).length, changed: Object.keys(answers).length };
      },
      resetAnswers() { Object.keys(answers).forEach((id) => delete answers[id]); Object.keys(comments).forEach((id) => delete comments[id]); persist(); notify('filter', { answer: findings.map((f) => f.id) }); },
      comment: (id) => comments[id] || '',
      /** Store a comment without re-rendering (typing must keep focus); finding elements and counts update in place. */
      setComment(id, text, source) {
        if (!byId.has(id)) return;
        if (String(text).trim()) comments[id] = String(text); else delete comments[id];
        persist();
        document.querySelectorAll(`[data-finding-id="${CSS.escape(id)}"]`).forEach((el) => el.toggleAttribute('data-commented', Boolean(commentOf(id))));
        document.querySelectorAll(`[data-answer-for="${CSS.escape(id)}"] textarea`).forEach((el) => { if (el !== source && el.value !== text) el.value = text; });
        refreshers.forEach((fn) => fn());
      },
      /** Everything needed to act on the review: approved findings with comments, plus what to leave alone. */
      answersReport,
      answersJSON: () => JSON.stringify(answersReport(), null, 2),
      copyAnswers: () => copyText(app.answersJSON()),
      /** Theme-owned state persisted per report beside pins and answers. Values must be JSON. */
      store: {
        get: (name, fallback) => (Object.prototype.hasOwnProperty.call(themeStore, name) ? themeStore[name] : fallback),
        set(name, value) { themeStore[name] = value; persist(); },
      },
      /** Sections default to visible; pass { key: false } to hide one until the user turns it on. */
      sectionDefaults(map) { Object.assign(sectionDefaults, map); },
      sectionVisible: (key) => (Object.prototype.hasOwnProperty.call(sections, key) ? sections[key] : sectionDefaults[key]) !== false,
      setSection(key, visible) { sections[key] = visible; persist(); app.applySections(); notify('sections', key); },
      applySections() { document.querySelectorAll('[data-section]').forEach((el) => { el.hidden = !app.sectionVisible(el.dataset.section); }); },
      initials(name) { const words = String(name).split(/\s+/).filter(Boolean); return (words.length > 1 ? words[0][0] + words[1][0] : String(name).slice(0, 2)).toUpperCase(); },
      filterSummary() {
        const parts = [];
        if (state.q) parts.push(`“${state.q}”`);
        FACETS.forEach((facet) => {
          if (!state[facet].size) return;
          const values = [...state[facet]].map((v) => (facet === 'pr' ? prLabel(v) : v));
          parts.push(`${FACET_LABELS[facet]}: ${values.join(', ')}${facet === 'pr' && state.prInherited ? ' (+ lower PRs)' : ''}`);
        });
        if (state.pinnedOnly) parts.push('pinned only');
        return parts.length ? parts.join(' · ') : 'All findings';
      },
      toMarkdown(list) {
        const lines = [`# ${data.title}`, '', `**Verdict:** ${data.verdict}`, `**Status:** ${data.status} · **Filter:** ${app.filterSummary()}`, ''];
        for (const f of list) {
          lines.push(`## [${f.severity}] ${f.title}`, '', `- **${f.id}** · ${f.disposition} · ${f.confidence} confidence · raised by ${f.reviewers.join(', ') || 'coordinator'}`);
          if (f.prs.length) lines.push(`- **PR:** ${f.prs.map((p) => `${prLabel(p)} ${(stack.byId.get(p) || {}).title || ''}`.trim()).join('; ')}`);
          lines.push(`- **Your answer:** ${ANSWER_LABELS[answerOf(f.id)]}${commentOf(f.id) ? ` — ${commentOf(f.id).replace(/\s*\n\s*/g, ' ')}` : ''}`);
          lines.push(`- **Location:** ${f.location}`, '');
          for (const [key, label] of FIELDS.slice(1)) {
            if (!f[key]) continue;
            if (key === 'evidence') {
              const fence = '`'.repeat(Math.max(3, ...(String(f[key]).match(/`+/g) || ['']).map((run) => run.length + 1)));
              lines.push(`**${label}:**`, '', fence, String(f[key]), fence, '');
            } else lines.push(`**${label}:** ${f[key]}`, '');
          }
        }
        return lines.join('\n');
      },
      copyMarkdown: () => copyText(app.toMarkdown(view().flat)),
      start() {
        app.applySections();
        notify('init');
        if (state.selected) { const el = findingElement(state.selected); if (el) el.scrollIntoView({ block: 'center' }); }
        return app;
      },
    };

    /* Shared controls. Markup and class names are stable so each theme only supplies CSS. */
    const ui = {
      /** Toggle buttons for one facet; returns null when the facet has no values (e.g. no stack). */
      facet(facet, opts) {
        opts = opts || {};
        const choices = options[facet];
        if (!choices.length) return null;
        const buttons = choices.map((choice) => h('button', {
          type: 'button', class: `facet-option facet-${facet}`, 'aria-pressed': 'false',
          title: `${choice.hint ? `${choice.hint}. ` : ''}${facet === 'pr' ? 'Click to show only this PR; shift-click to add it.' : 'Shift-click to show only this.'}`,
          dataset: {
            value: choice.value, focusKey: `facet:${facet}:${choice.value}`,
            severity: facet === 'severity' ? choice.value : null, disposition: facet === 'disposition' ? choice.value : null,
            rv: facet === 'reviewer' ? String(reviewerIndex(choice.value)) : null,
            indent: choice.node ? String(choice.node.indent) : null,
          },
          onclick: (event) => app.toggle(facet, choice.value, facet === 'pr' ? !(event.shiftKey || event.altKey) : event.shiftKey || event.altKey),
        }, h('span', { class: 'facet-swatch', 'aria-hidden': 'true' }),
        h('span', { class: 'facet-label' }, opts.labels && opts.labels[choice.value] || choice.label),
        facet === 'pr' && choice.node && opts.titles !== false ? h('span', { class: 'facet-hint' }, choice.node.title) : null,
        h('span', { class: 'facet-count' })));
        const legend = opts.legend === false ? null : h('legend', { class: 'facet-legend' }, opts.legend || FACET_LABELS[facet]);
        const root = h('fieldset', { class: 'facet', dataset: { facet } }, legend, h('div', { class: 'facet-options' }, buttons));
        refreshers.push(() => {
          const n = counts(facet);
          buttons.forEach((b) => {
            const count = n.get(b.dataset.value) || 0;
            b.setAttribute('aria-pressed', String(state[facet].has(b.dataset.value)));
            b.querySelector('.facet-count').textContent = String(count);
            b.toggleAttribute('data-empty', count === 0);
          });
        });
        return root;
      },
      search(opts) {
        const input = h('input', {
          type: 'search', class: 'search-input', placeholder: (opts && opts.placeholder) || 'Search findings…  ( / )',
          'aria-label': 'Search findings', autocomplete: 'off', spellcheck: 'false', dataset: { focusKey: 'search' },
          oninput: () => { state.q = input.value; notify('filter'); },
        });
        searchInput = input;
        refreshers.push(() => { if (input.value !== state.q) input.value = state.q; });
        return input;
      },
      toggle(key, label) {
        if (key === 'prInherited' && !(hasStack && stack.maxDepth > 0)) return null;
        const input = h('input', { type: 'checkbox', dataset: { focusKey: `toggle:${key}` }, onchange: () => app.set(key, input.checked) });
        const count = h('span', { class: 'toggle-count' });
        const root = h('label', { class: 'toggle', dataset: { toggle: key } }, input, h('span', { class: 'toggle-label' }, label), count);
        refreshers.push(() => {
          input.checked = Boolean(state[key]);
          const n = key === 'pinnedOnly' ? pinned.size : null;
          count.textContent = n == null ? '' : String(n);
          root.toggleAttribute('data-empty', n === 0 && !state[key]);
        });
        return root;
      },
      select(key, label) {
        const choices = Object.entries(key === 'groupBy' ? GROUPS : SORTS).filter(([value]) => value !== 'pr' || hasStack);
        const select = h('select', { dataset: { focusKey: `select:${key}` }, onchange: () => app.set(key, select.value) },
          choices.map(([value, text]) => h('option', { value }, text)));
        refreshers.push(() => { select.value = state[key]; });
        return h('label', { class: 'select', dataset: { select: key } }, h('span', { class: 'select-label' }, label), select);
      },
      presets(names) {
        const buttons = (names || Object.keys(PRESETS)).map((name) => h('button', {
          type: 'button', class: 'preset', title: PRESETS[name].hint, 'aria-pressed': 'false', dataset: { preset: name, focusKey: `preset:${name}` },
          onclick: () => app.applyPreset(name),
        }, PRESETS[name].label));
        refreshers.push(() => buttons.forEach((b) => b.setAttribute('aria-pressed', String(app.presetActive(b.dataset.preset)))));
        return h('div', { class: 'presets', role: 'group', 'aria-label': 'Quick views' }, buttons);
      },
      reset(label) {
        const button = h('button', { type: 'button', class: 'reset', dataset: { focusKey: 'reset' }, onclick: () => app.reset() }, label || 'Clear filters');
        refreshers.push(() => { button.disabled = !app.isFiltered(); });
        return button;
      },
      copy(label) {
        label = label || 'Copy as Markdown';
        const button = h('button', { type: 'button', class: 'copy', title: 'Copy the findings currently shown as Markdown', onclick: async () => {
          const ok = await app.copyMarkdown();
          button.textContent = ok ? 'Copied ✓' : 'Copy failed';
          setTimeout(() => { button.textContent = label; }, 1600);
        } }, label);
        return button;
      },
      print(label) { return h('button', { type: 'button', class: 'print', onclick: () => window.print() }, label || 'Print / PDF'); },
      expand() {
        return h('div', { class: 'expand-controls' },
          h('button', { type: 'button', class: 'expand-all', onclick: () => app.expandAll(true) }, 'Expand all'),
          h('button', { type: 'button', class: 'collapse-all', onclick: () => app.expandAll(false) }, 'Collapse all'));
      },
      count() {
        const el = h('p', { class: 'result-count', 'aria-live': 'polite' });
        refreshers.push(() => { el.textContent = `${view().flat.length} of ${findings.length} findings`; });
        return el;
      },
      filterSummary() { const el = h('p', { class: 'filter-summary' }); refreshers.push(() => { el.textContent = app.filterSummary(); }); return el; },
      /** Checkboxes that show/hide page regions marked data-section="key"; persisted per report. */
      sections(defs) {
        return h('fieldset', { class: 'section-toggles' }, h('legend', { class: 'facet-legend' }, 'Show sections'),
          defs.map(([key, label]) => {
            const input = h('input', { type: 'checkbox', checked: app.sectionVisible(key), onchange: () => app.setSection(key, input.checked) });
            refreshers.push(() => { input.checked = app.sectionVisible(key); });
            return h('label', { class: 'toggle' }, input, h('span', { class: 'toggle-label' }, label));
          }));
      },
      findingFields(f) {
        return h('dl', { class: 'finding-fields' }, FIELDS.filter(([key]) => f[key]).map(([key, label]) => [
          h('dt', { dataset: { field: key } }, label),
          h('dd', { dataset: { field: key } }, key === 'evidence' ? h('pre', null, f[key]) : key === 'location' ? h('code', null, f[key]) : f[key]),
        ]));
      },
      /** Compact row controls: an Ignore toggle (pressed = ignored) and Pin. { answer: false } or { pin: false } drops one. */
      findingActions(f, opts) {
        opts = opts || {};
        return h('div', { class: 'finding-actions' },
          opts.answer === false ? null : h('button', {
            type: 'button', class: 'action action-ignore', 'aria-pressed': String(answerOf(f.id) === 'ignore'), title: 'Ignore: leave out of the fix list (x)',
            dataset: { answerFor: f.id, answerToggle: '', answer: answerOf(f.id), focusKey: `ignore:${f.id}` },
            onclick: (e) => { e.stopPropagation(); app.toggleAnswer(f.id); },
          }, 'Ignore'),
          opts.pin === false ? null : h('button', {
            type: 'button', class: 'action action-pin', 'aria-pressed': String(pinned.has(f.id)), title: 'Pin to top (p)', dataset: { pinFor: f.id, focusKey: `pin:${f.id}` },
            onclick: (e) => { e.stopPropagation(); app.togglePinned(f.id); },
          }, pinned.has(f.id) ? 'Unpin' : 'Pin'));
      },
      /** Full answer block for a detail view: Fix / Ignore, where the answer came from, and a comment for the fixer. */
      answer(f, opts) {
        opts = opts || {};
        const value = answerOf(f.id);
        const option = (v) => h('button', {
          type: 'button', class: 'answer-option', 'aria-pressed': String(v === value), dataset: { answerValue: v, focusKey: `answer:${v}:${f.id}` },
          title: v === 'fix' ? 'Approve for fixing' : 'Leave out of the fix list (x)', onclick: (e) => { e.stopPropagation(); app.setAnswer(f.id, v); },
        }, h('span', { class: 'answer-mark', 'aria-hidden': 'true' }, v === 'fix' ? '✓' : '✕'), ANSWER_LABELS[v]);
        const area = h('textarea', {
          class: 'answer-input', rows: String(opts.rows || 3), spellcheck: 'true', 'aria-label': `Comment on ${f.id} for whoever fixes it`,
          placeholder: opts.placeholder || 'Comment for the fix (optional): what to do differently, or why to ignore it',
          dataset: { focusKey: `comment:${f.id}` },
          oninput: () => app.setComment(f.id, area.value, area),
          onclick: (e) => e.stopPropagation(),
        });
        area.value = comments[f.id] || '';
        return h('section', { class: 'answer', 'aria-label': `Your answer for ${f.id}`, dataset: { answerFor: f.id, answer: value } },
          h('div', { class: 'answer-head' },
            h('span', { class: 'answer-legend' }, opts.legend || 'Your answer'),
            h('div', { class: 'answer-choice', role: 'group', 'aria-label': 'Fix or ignore' }, ANSWERS.map(option)),
            h('span', { class: 'answer-note' }, answerNote(f.id))),
          h('label', { class: 'answer-comment' }, h('span', { class: 'answer-comment-label' }, 'Comment'), area));
      },
      /** Copies app.answersJSON(); the count stays live. */
      copyAnswers(label) {
        label = label || 'Copy answers JSON';
        const text = h('span', { class: 'copy-answers-label' }, label);
        const count = h('span', { class: 'copy-answers-count' });
        const button = h('button', {
          type: 'button', class: 'copy-answers', dataset: { focusKey: 'copy-answers' },
          title: 'Copy every answer as JSON: the findings to fix (with your comments) and the ones to ignore. Paste it to the agent that fixes them.',
          onclick: async () => {
            const ok = await app.copyAnswers();
            text.textContent = ok ? 'Copied ✓' : 'Copy failed';
            setTimeout(() => { text.textContent = label; }, 1600);
          },
        }, text, count);
        refreshers.push(() => { const c = app.answerCounts(); count.textContent = `${c.fix} fix · ${c.ignore} ignore`; button.disabled = !findings.length; });
        return button;
      },
      answerSummary() {
        const el = h('p', { class: 'answer-summary', 'aria-live': 'polite' });
        refreshers.push(() => {
          const c = app.answerCounts();
          el.textContent = `${c.fix} to fix · ${c.ignore} ignored${c.comments ? ` · ${c.comments} ${c.comments === 1 ? 'comment' : 'comments'}` : ''}`;
        });
        return el;
      },
      /** Answer every finding in the current view at once, plus a two-step reset of all answers and comments. */
      bulkAnswer() {
        const make = (value) => h('button', {
          type: 'button', class: `bulk-answer bulk-${value}`, dataset: { focusKey: `bulk:${value}` },
          onclick: () => app.setAnswers(view().flat.map((f) => f.id), value),
        });
        const fix = make('fix');
        const ignore = make('ignore');
        let armed = null;
        const reset = h('button', {
          type: 'button', class: 'bulk-answer bulk-reset', dataset: { focusKey: 'bulk:reset' }, title: 'Restore every default answer and delete your comments',
          onclick: () => {
            if (armed) { clearTimeout(armed); armed = null; app.resetAnswers(); return; }
            reset.textContent = 'Click again to reset';
            armed = setTimeout(() => { armed = null; reset.textContent = 'Reset answers'; }, 3000);
          },
        }, 'Reset answers');
        refreshers.push(() => {
          const shown = view().flat;
          fix.textContent = `Fix ${shown.length} shown`;
          ignore.textContent = `Ignore ${shown.length} shown`;
          fix.disabled = !shown.some((f) => answerOf(f.id) !== 'fix');
          ignore.disabled = !shown.some((f) => answerOf(f.id) !== 'ignore');
          if (!armed) reset.disabled = !Object.keys(answers).length && !Object.keys(comments).length;
        });
        return h('div', { class: 'bulk-answers', role: 'group', 'aria-label': 'Answer every shown finding' }, fix, ignore, reset);
      },
      /**
       * Drag handle that resizes a docked panel; append it inside the (positioned) panel on every render.
       * The width goes to a CSS custom property (default --drawer-width on <html>) so the theme's CSS stays in charge:
       * width: min(var(--drawer-width, 520px), 100vw). Double-click resets. Arrow keys resize. Persisted per key.
       * side 'left' (default) means the handle sits on the panel's left edge, for a panel docked to the right.
       */
      resizer(panel, opts) {
        opts = opts || {};
        const key = opts.key || 'drawer';
        const prop = opts.property || '--drawer-width';
        const target = opts.target || document.documentElement;
        const min = opts.min || 320;
        const dir = opts.side === 'right' ? -1 : 1;
        const maxWidth = () => Math.max(min, Math.min(opts.max || Infinity, window.innerWidth - (opts.gutter == null ? 48 : opts.gutter)));
        const handle = h('div', {
          class: 'resize-handle', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': opts.label || 'Resize panel',
          'aria-valuemin': String(min), title: 'Drag to resize · double-click to reset', dataset: { side: opts.side || 'left' },
        });
        const apply = (width, save) => {
          if (width == null) { target.style.removeProperty(prop); handle.removeAttribute('aria-valuenow'); }
          else {
            width = Math.round(Math.min(maxWidth(), Math.max(min, width)));
            target.style.setProperty(prop, `${width}px`);
            handle.setAttribute('aria-valuenow', String(width));
          }
          if (save) { if (width == null) delete sizes[key]; else sizes[key] = width; persist(); }
        };
        if (typeof sizes[key] === 'number') apply(sizes[key]);
        let drag = null;
        const end = () => {
          if (!drag) return;
          drag = null;
          document.documentElement.classList.remove('is-resizing');
          const width = parseFloat(target.style.getPropertyValue(prop));
          if (width) apply(width, true);
        };
        handle.addEventListener('pointerdown', (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          drag = { x: event.clientX, width: panel.getBoundingClientRect().width };
          handle.setPointerCapture(event.pointerId);
          document.documentElement.classList.add('is-resizing');
        });
        handle.addEventListener('pointermove', (event) => { if (drag) apply(drag.width + (drag.x - event.clientX) * dir); });
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
        handle.addEventListener('lostpointercapture', end);
        handle.addEventListener('dblclick', () => apply(null, true));
        handle.addEventListener('click', (event) => event.stopPropagation());
        handle.addEventListener('keydown', (event) => {
          const step = event.shiftKey ? 120 : 40;
          const width = panel.getBoundingClientRect().width;
          if (event.key === 'ArrowLeft') apply(width + step * dir, true);
          else if (event.key === 'ArrowRight') apply(width - step * dir, true);
          else if (event.key === 'Home') apply(maxWidth(), true);
          else if (event.key === 'End') apply(min, true);
          else if (event.key === 'Enter') apply(null, true);
          else return;
          event.preventDefault();
          event.stopPropagation();
        });
        return handle;
      },
      prChip(id) {
        if (!hasStack) return null; // one PR is the target itself; there is nothing to filter to
        const node = stack.byId.get(id);
        return h('button', { type: 'button', class: 'pr-chip', title: node ? `${node.title} — show only this PR` : 'Show only this PR', dataset: { pr: id },
          onclick: (e) => { e.stopPropagation(); app.setFacet('pr', [id]); } }, prLabel(id));
      },
      reviewerBadges(names) {
        return h('span', { class: 'rv-badges' }, names.map((name) => h('span', { class: 'rv', title: name, dataset: { rv: String(reviewerIndex(name)) } }, app.initials(name))));
      },
      /** Per-severity counts. { labels: true } renders "P1 2" instead of a bare number. */
      severityPips(row, opts) {
        const labels = opts && opts.labels;
        return h('span', { class: 'sev-pips', role: 'img', 'aria-label': SEVERITIES.filter((s) => row[s]).map((s) => `${row[s]} ${s} ${SEVERITY_LABELS[s]}`).join(', ') || 'No findings' },
          SEVERITIES.filter((s) => row[s]).map((s) => h('span', { class: 'sev-pip', title: `${row[s]} × ${s} ${SEVERITY_LABELS[s]}`, dataset: { severity: s } }, labels ? `${s} ${row[s]}` : `${row[s]}`)));
      },
      /** Default tree: trunk, then PRs in stack order. Click filters to one PR; shift-click adds. */
      stackTree(opts) {
        if (!hasStack) return null;
        opts = opts || {};
        const items = stack.order.map((node) => {
          const pips = h('span', { class: 'stack-pips' });
          const total = h('span', { class: 'stack-total' });
          const button = h('button', {
            type: 'button', class: 'stack-select', 'aria-pressed': 'false', dataset: { focusKey: `stack:${node.id}` },
            title: `${node.title}${node.branch ? ` (${node.branch})` : ''}. Click to show only this PR; shift-click to add it.`,
            onclick: (event) => app.toggle('pr', node.id, !(event.shiftKey || event.altKey)),
          },
          h('span', { class: 'stack-graph', 'aria-hidden': 'true' },
            node.trail.map((line) => h('span', { class: line ? 'stack-guide stack-guide-line' : 'stack-guide' })),
            node.depth ? h('span', { class: `stack-guide ${node.isLast ? 'stack-elbow' : 'stack-tee'}` }) : null,
            h('span', { class: 'stack-dot' })),
          h('span', { class: 'stack-body' },
            h('span', { class: 'stack-head' }, h('span', { class: 'stack-number' }, prLabel(node.id)), h('span', { class: 'stack-title' }, node.title)),
            opts.meta === false ? null : h('span', { class: 'stack-meta' }, [node.branch, node.forked ? `forks from ${prLabel(node.parent)}` : null, node.status].filter(Boolean).join(' · '))),
          h('span', { class: 'stack-stats' }, pips, total));
          const li = h('li', { class: 'stack-node', dataset: { pr: node.id, depth: String(node.depth), indent: String(node.indent), lane: String(node.lane) } }, button);
          return { node, li, button, pips, total };
        });
        refreshers.push(() => {
          const rows = prBreakdown();
          items.forEach(({ node, button, pips, total }) => {
            const row = rows.get(node.id);
            button.setAttribute('aria-pressed', String(state.pr.has(node.id)));
            pips.replaceChildren(ui.severityPips(row));
            total.textContent = String(row.total);
            button.toggleAttribute('data-empty', row.total === 0);
          });
        });
        return h('ol', { class: 'stack-tree', 'aria-label': 'Stacked pull requests' },
          h('li', { class: 'stack-node stack-trunk' }, h('span', { class: 'stack-graph', 'aria-hidden': 'true' }, h('span', { class: 'stack-dot' })), h('span', { class: 'stack-number' }, stack.trunk)),
          items.map((item) => item.li));
      },
      /** Inline legend (a details element) listing every key, including theme additions, plus a button for the ? sheet. */
      shortcuts() {
        const list = h('div', { class: 'shortcut-groups' });
        const root = h('details', { class: 'shortcuts', ontoggle: () => { if (root.open) list.replaceChildren(...shortcutList(shortcutGroups())); } },
          h('summary', null, 'Keyboard shortcuts'), list,
          h('button', { type: 'button', class: 'shortcuts-open', onclick: () => openSheet() }, 'Open cheatsheet (?)'));
        return root;
      },
    };
    app.ui = ui;

    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable;
      if (event.key === 'Escape') {
        if (typing) target.blur(); else if (state.drawerFull) app.setDrawerFull(false); else if (state.selected) app.select(null);
        return;
      }
      if (typing) return;
      const id = state.selected;
      // "Open" means the finding's answer block is on screen (its drawer or detail pane is showing).
      const answerBlock = id && Array.from(document.querySelectorAll(`.answer[data-answer-for="${CSS.escape(id)}"]`)).find(isShown);
      switch (event.key) {
        case '?': openSheet(); break;
        case '/': if (searchInput) { event.preventDefault(); searchInput.focus(); searchInput.select(); } break;
        case 'j': app.move(1); break;
        case 'k': app.move(-1); break;
        case 'f': app.toggleDrawerFull(); break;
        case 'o': if (id) app.setOpen(id, !open.has(id)); break;
        case 'p': if (id) app.togglePinned(id); break;
        case 'x': if (id) app.toggleAnswer(id); break;
        case 'a': if (!answerBlock) return; app.setAnswer(id, 'fix'); break;
        case 'i': case 'r': if (!answerBlock) return; app.setAnswer(id, 'ignore'); break;
        case 'c': {
          const area = answerBlock && answerBlock.querySelector('textarea');
          if (!area) return;
          area.focus();
          break;
        }
        default: return;
      }
      event.preventDefault();
    });
    window.addEventListener('hashchange', () => { readHash(); notify('filter'); });
    let openBeforePrint = null;
    window.addEventListener('beforeprint', () => {
      openBeforePrint = Array.from(document.querySelectorAll('details')).map((el) => [el, el.open]);
      openBeforePrint.forEach(([el]) => { el.open = true; });
    });
    window.addEventListener('afterprint', () => { if (openBeforePrint) openBeforePrint.forEach(([el, wasOpen]) => { el.open = wasOpen; }); });

    readHash();
    return app;
  }

  window.MultiAgentReview = { create, h, safeUrl, SEVERITIES, SEVERITY_LABELS, DISPOSITIONS };
}());
