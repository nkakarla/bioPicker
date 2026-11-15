// BioPicker admin panel: accounts, usage & cost, plans & paywall. © 2026 EPerf
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const main = $("#main");

// ---------- tiny DOM helpers (same as the app) ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((c) => c != null && c !== false));
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (err ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = ""), err ? 6000 : 2800);
}
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = (r.headers.get("content-type") || "").includes("json") ? await r.json() : null;
  // signed out, or not an admin (the admin API answers 404 "Not found" to everyone else)
  if (r.status === 401 || (r.status === 404 && data?.error === "Not found")) {
    location.href = "./";
    throw new Error("Please sign in as an admin.");
  }
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

// ---------- formatting ----------
const money = (v) => (v == null ? "No limit" : v === 0 ? "$0.00" : Math.abs(v) < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const int = (v) => (v == null ? "" : Math.round(v).toLocaleString());
const tokens = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v || 0));
const mins = (v) => (v ? `${v.toFixed(1)} min` : "0");
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");
const day = (iso) => (iso ? new Date(iso).toLocaleDateString([], { dateStyle: "medium" }) : "");
const LEVEL_NAMES = { short: "Short film", long: "Long film", episode: "Series episode", setup: "Biopic setup (photos, docs, interview, history, voice, series plan)" };
const TASK_NAMES = { photo: "Photo analysis", document: "Document reading", interview: "Interview questions", history: "Historical research", voice: "Voice casting", series: "Series planning", script: "Script writing", tighten: "Script tightening", media: "Archival media picking", other: "Other" };
const monthName = (m) => (m === "all" ? "All time" : new Date(`${m}-15`).toLocaleDateString([], { month: "long", year: "numeric" }));

// ---------- URL state ----------
const qs = () => new URLSearchParams(location.search);
function go(changes, { replace = false } = {}) {
  const q = qs();
  for (const [k, v] of Object.entries(changes)) {
    q.delete(k);
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else if (v != null && v !== "") q.set(k, v);
  }
  const url = `${location.pathname}?${q}`;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  route();
}
window.addEventListener("popstate", () => route());

// ============================================================================
// EperfTable: paging (20 by default), pager above and below, sticky header, sort on any column,
// search across the text, per-column value filters (union across columns), state in the URL, CSV export.
// Rows are all in the browser here: the admin lists are small (accounts, biopics, the latest 500 events).
// ============================================================================
const SIZES = [20, 50, 100, 200];
const CAP = 500;

function eperfTable(cfg) {
  // cfg: { id, noun, columns:[{key,label,type,text(row),value(row),num}], rows, sort, dir, onRow, csv, emptyAll }
  const k = (s) => `${cfg.id}${s}`;
  const q = qs();
  const cols = cfg.columns;
  const textOf = (c, r) => {
    const t = c.text ? c.text(r) : r[c.key];
    return t == null ? "" : String(t);
  };
  const valueOf = (c, r) => (c.value ? c.value(r) : r[c.key]);
  const size = SIZES.includes(Number(q.get(k("n")))) ? Number(q.get(k("n"))) : 20;
  const sortKey = cols.some((c) => c.key === q.get(k("s"))) ? q.get(k("s")) : cfg.sort || cols[0].key;
  const dir = q.get(k("d")) || (q.get(k("s")) ? "asc" : cfg.dir || "asc");
  const search = q.get(k("q")) || "";
  const filters = {};
  for (const c of cols) {
    const v = q.getAll(k(`f_${c.key}`));
    if (v.length) filters[c.key] = new Set(v);
  }
  const active = Object.keys(filters);

  // filter (search AND union of column selections), then sort the whole result
  const needle = search.trim().toLowerCase();
  let rows = cfg.rows.filter((r) => {
    if (needle && !cols.some((c) => textOf(c, r).toLowerCase().includes(needle))) return false;
    if (active.length && !active.some((key) => filters[key].has(textOf(cols.find((c) => c.key === key), r)))) return false;
    return true;
  });
  const sc = cols.find((c) => c.key === sortKey);
  rows = rows.slice().sort((a, b) => {
    const x = valueOf(sc, a);
    const y = valueOf(sc, b);
    const empty = (v) => v == null || v === "";
    if (empty(x) && empty(y)) return 0;
    if (empty(x)) return 1; // blanks last either way
    if (empty(y)) return -1;
    const d = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
    return dir === "desc" ? -d : d;
  });
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(pages, Math.max(1, Number(q.get(k("p"))) || 1));
  const shown = rows.slice((page - 1) * size, page * size);

  const set = (changes) => go(Object.fromEntries(Object.entries(changes).map(([key, v]) => [k(key), v])));
  const pager = () => {
    const link = (label, target, ok) => (ok ? h("a", { href: "#", onclick: (e) => { e.preventDefault(); set({ p: target }); } }, label) : h("span", { class: "disabled" }, label));
    return h("div", { class: "pager" },
      link("« First", 1, page > 1), link("‹ Prev", page - 1, page > 1),
      h("span", { class: "cur" }, `Page ${page} / ${pages}`),
      link("Next ›", page + 1, page < pages), link("Last »", pages, page < pages));
  };

  const searchBox = h("input", { class: "search", type: "search", placeholder: `Search ${cfg.noun || "rows"}…`, value: search });
  searchBox.addEventListener("keydown", (e) => { if (e.key === "Enter") set({ q: searchBox.value.trim(), p: 1 }); });
  searchBox.addEventListener("search", () => set({ q: searchBox.value.trim(), p: 1 }));
  const toolbar = h("div", { class: "toolbar" },
    searchBox,
    h("button", { class: "btn sm", onclick: () => set({ q: searchBox.value.trim(), p: 1 }) }, "Search"),
    h("select", { "aria-label": "Rows per page", onchange: (e) => set({ n: e.target.value, p: 1 }) },
      ...SIZES.map((n) => h("option", { value: n, selected: n === size ? true : null }, `${n} / page`))),
    h("span", { class: "spacer" }),
    cfg.csv !== false ? h("button", { class: "btn sm ghost", onclick: () => exportCsv(cfg, cols, rows, textOf, valueOf) }, "Export CSV") : null);

  const labelOf = (key) => cols.find((c) => c.key === key)?.label || key;
  const count = h("div", { class: "count" },
    h("b", {}, rows.length.toLocaleString()), ` filtered row${rows.length === 1 ? "" : "s"} (showing ${shown.length} on this page)`,
    active.length ? [
      " · filtered by ", h("b", {}, active.map((key) => `${labelOf(key)} (${filters[key].size})`).join(", ")),
      " · ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); set(Object.fromEntries([...active.map((key) => [`f_${key}`, null]), ["p", 1]])); } }, "clear column filters"),
    ] : null);

  const head = h("tr", {}, ...cols.map((c) => {
    const on = c.key === sortKey;
    const arrow = on ? (dir === "desc" ? " ▼" : " ▲") : "";
    const values = [...new Set(cfg.rows.map((r) => textOf(c, r)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return h("th", { class: c.num ? "num" : "", "aria-sort": on ? (dir === "desc" ? "descending" : "ascending") : null },
      h("button", { class: "sortbtn", title: "Sort", onclick: () => set({ s: c.key, d: on && dir === "asc" ? "desc" : "asc", p: 1 }) }, c.label, h("span", { class: "arrow" }, arrow)),
      filterDropdown(c, values, filters[c.key] || new Set(), (chosen) => set({ [`f_${c.key}`]: chosen, p: 1 })));
  }));

  let body;
  if (!cfg.rows.length) body = h("div", { class: "state empty" }, cfg.emptyAll || `No ${cfg.noun || "rows"} yet.`);
  else if (!rows.length) body = h("div", { class: "state empty" }, `No ${cfg.noun || "rows"} match. Adjust the filters above.`);
  else {
    body = h("div", { class: "tscroll" }, h("table", { class: "et" },
      h("thead", {}, head),
      h("tbody", {}, ...shown.map((r) => h("tr", { class: cfg.onRow ? "click" : "", onclick: cfg.onRow ? () => cfg.onRow(r) : null },
        ...cols.map((c) => h("td", { class: c.num ? "num" : c.cls || "" }, c.cell ? c.cell(r) : textOf(c, r))))))));
  }
  return h("div", { class: "eperf" }, toolbar, count, rows.length ? pager() : null, body, rows.length ? pager() : null);
}

/** A column's value filter: checkboxes for its distinct values, with search, (Select all), Clear and Apply. */
function filterDropdown(col, values, selected, apply) {
  const label = !selected.size ? "All" : selected.size === 1 ? [...selected][0] || "(blank)" : `${selected.size} selected`;
  const btn = h("button", { type: "button", class: `fbtn${selected.size ? " active" : ""}`, title: `Filter ${col.label}` }, h("span", { class: "fl" }, label), h("span", { class: "fcar" }, "▾"));
  const shown = values.slice(0, CAP);
  const boxes = shown.map((v) => h("label", {}, h("input", { type: "checkbox", value: v, checked: selected.has(v) }), " ", v || "(blank)"));
  const list = h("div", { class: "flist" }, ...boxes);
  const fsearch = h("input", { type: "text", class: "fsearch", placeholder: "Search…" });
  const all = h("input", { type: "checkbox" });
  fsearch.addEventListener("input", () => {
    const s = fsearch.value.toLowerCase();
    for (const l of boxes) l.style.display = l.textContent.toLowerCase().includes(s) ? "" : "none";
  });
  all.addEventListener("click", () => { for (const l of boxes) if (l.style.display !== "none") l.querySelector("input").checked = all.checked; });
  const panel = h("div", { class: "fpanel", onclick: (e) => e.stopPropagation() },
    fsearch,
    h("label", { class: "fall" }, all, " (Select all)"),
    list,
    values.length > CAP ? h("div", { class: "ftrunc" }, `${values.length - CAP} more, narrow with search`) : null,
    h("div", { class: "fbar" },
      h("button", { type: "button", class: "btn sm ghost", onclick: () => apply([]) }, "Clear"),
      h("button", { type: "button", class: "btn sm primary", onclick: () => apply(boxes.map((l) => l.querySelector("input")).filter((i) => i.checked).map((i) => i.value)) }, "Apply")));
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = panel.classList.contains("open");
    closePanels();
    if (open) return;
    // fixed position so the scrolling table doesn't clip it
    const r = btn.getBoundingClientRect();
    panel.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 340)}px`;
    panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 256))}px`;
    panel.classList.add("open");
    fsearch.value = "";
    fsearch.dispatchEvent(new Event("input"));
    fsearch.focus();
  });
  return h("div", { class: "fdrop" }, btn, panel);
}
const closePanels = () => document.querySelectorAll(".fpanel.open").forEach((p) => p.classList.remove("open"));
document.addEventListener("click", closePanels);
window.addEventListener("scroll", closePanels, true);

function exportCsv(cfg, cols, rows, textOf, valueOf) {
  const cell = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [cols.map((c) => cell(c.label)).join(",")];
  for (const r of rows) lines.push(cols.map((c) => cell(c.num && typeof valueOf(c, r) === "number" ? valueOf(c, r) : textOf(c, r))).join(","));
  const a = h("a", { href: URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" })), download: `${cfg.csv || cfg.id}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
}

/** A small table (a handful of rows) with click-to-sort headers, for summaries. */
function smallTable(columns, rows, { sort } = {}) {
  let key = sort || columns[0].key;
  let dir = "desc";
  const wrap = h("div", { class: "tscroll small-t" });
  const draw = () => {
    const c = columns.find((x) => x.key === key);
    const v = (r) => (c.value ? c.value(r) : r[c.key]);
    const sorted = rows.slice().sort((a, b) => {
      const x = v(a);
      const y = v(b);
      const d = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true });
      return dir === "desc" ? -d : d;
    });
    fill(wrap, rows.length ? h("table", { class: "et" },
      h("thead", {}, h("tr", {}, ...columns.map((col) => h("th", { class: col.num ? "num" : "" },
        h("button", { class: "sortbtn", onclick: () => { dir = key === col.key && dir === "desc" ? "asc" : "desc"; key = col.key; draw(); } }, col.label, h("span", { class: "arrow" }, key === col.key ? (dir === "desc" ? " ▼" : " ▲") : "")))))),
      h("tbody", {}, ...sorted.map((r) => h("tr", {}, ...columns.map((col) => h("td", { class: col.num ? "num" : "" }, col.text ? col.text(r) : r[col.key]))))))
      : h("div", { class: "state empty" }, "Nothing recorded for this period yet."));
  };
  draw();
  return wrap;
}

// ============================================================================
// pages
// ============================================================================
const TABS = [["overview", "Usage & cost"], ["accounts", "Accounts"], ["plans", "Plans & paywall"]];
let months = [];
const cache = new Map();
async function load(url) {
  if (!cache.has(url)) cache.set(url, api("GET", url).catch((e) => { cache.delete(url); throw e; }));
  return cache.get(url);
}
const refresh = () => { cache.clear(); route(); };

function header(tab) {
  fill($("#tabs"), ...TABS.map(([id, label]) => h("button", { class: tab === id || (tab === "account" && id === "accounts") ? "on" : "", onclick: () => go({ tab: id, id: null }) }, label)));
  const sel = $("#month");
  const cur = qs().get("month") || "";
  const options = [["", `This month`], ...months.filter((m) => m !== thisMonthKey()).map((m) => [m, monthName(m)]), ["all", "All time"]];
  fill(sel, ...options.map(([v, l]) => h("option", { value: v, selected: v === cur ? true : null }, l)));
  sel.onchange = () => go({ month: sel.value });
  sel.closest("label").style.visibility = tab === "plans" || tab === "account" ? "hidden" : "";
}
const thisMonthKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const monthQ = () => { const m = qs().get("month"); return m ? `month=${encodeURIComponent(m)}` : ""; };
const periodName = () => monthName(qs().get("month") || thisMonthKey());

// warnings shown above every admin page (free spots running out or full)
async function drawAlerts() {
  const bar = $("#alertbar");
  if (!bar) return;
  try {
    const { alerts } = await load("api/admin/alerts");
    fill(bar, ...alerts.map((a) => h("div", { class: `alertbar ${a.level}`, role: "alert" },
      h("span", { class: "ai", "aria-hidden": "true" }, "⚠"), h("span", {}, a.text), h("span", { class: "spacer" }),
      a.tab && qs().get("tab") !== a.tab ? h("a", { href: `?tab=${a.tab}`, onclick: (e) => { e.preventDefault(); go({ tab: a.tab, id: null }); } }, "Sign-up settings") : null)));
  } catch {
    fill(bar);
  }
}

async function route() {
  const q = qs();
  const tab = q.get("tab") || "overview";
  header(tab);
  drawAlerts();
  const loading = h("div", { class: "state" }, "Loading…");
  if (!main.firstChild || main.dataset.tab !== tab + (q.get("id") || "")) fill(main, loading);
  main.dataset.tab = tab + (q.get("id") || "");
  try {
    if (tab === "accounts") await pageAccounts();
    else if (tab === "account") await pageAccount(q.get("id"));
    else if (tab === "plans") await pagePlans();
    else await pageOverview();
  } catch (e) {
    fill(main, h("div", { class: "state error" }, h("p", {}, `Couldn't load this page: ${e.message}`), h("button", { class: "btn", onclick: refresh }, "Try again")));
  }
}

function tile(label, value, note, warn = false) {
  return h("div", { class: warn ? "tile warn" : "tile", title: warn ? "Needs attention" : null }, h("div", { class: "tl" }, label), h("div", { class: "tv" }, value), note ? h("div", { class: "tn" }, note) : null);
}
const levelCols = [
  { key: "key", label: "Level", text: (r) => LEVEL_NAMES[r.key] || r.key },
  { key: "aiCost", label: "AI cost", num: true, text: (r) => money(r.aiCost) },
  { key: "renders", label: "Films rendered", num: true },
  { key: "perFilm", label: "AI cost per film", num: true, value: (r) => (r.renders ? r.aiCost / r.renders : null), text: (r) => (r.key === "setup" ? "—" : r.renders ? money(r.aiCost / r.renders) : "no films yet") },
  { key: "tok", label: "Tokens", num: true, value: (r) => r.tokensIn + r.tokensOut + r.cacheRead + r.cacheWrite, text: (r) => tokens(r.tokensIn + r.tokensOut + r.cacheRead + r.cacheWrite) },
  { key: "aiCalls", label: "AI calls", num: true },
  { key: "filmSeconds", label: "Film minutes", num: true, text: (r) => mins(r.filmSeconds / 60) },
  { key: "renderSeconds", label: "Render time", num: true, text: (r) => mins(r.renderSeconds / 60) },
  { key: "rendersFailed", label: "Failed renders", num: true },
];
const tokenCols = [
  { key: "aiCost", label: "AI cost", num: true, text: (r) => money(r.aiCost) },
  { key: "aiCalls", label: "Calls", num: true },
  { key: "tokensIn", label: "Input tokens", num: true, text: (r) => tokens(r.tokensIn) },
  { key: "tokensOut", label: "Output tokens", num: true, text: (r) => tokens(r.tokensOut) },
  { key: "cacheRead", label: "Cache read", num: true, text: (r) => tokens(r.cacheRead) },
  { key: "cacheWrite", label: "Cache write", num: true, text: (r) => tokens(r.cacheWrite) },
];

async function pageOverview() {
  const o = await load(`api/admin/overview?${monthQ()}`);
  months = o.byMonth.map((m) => m.key);
  header("overview");
  const t = o.totals;
  fill(main,
    h("div", { class: "row" }, h("h1", {}, `Usage & cost: ${periodName()}`), h("span", { class: "spacer" }),
      h("a", { class: "btn sm", href: `api/admin/usage.csv?${monthQ()}` }, "Export usage CSV"),
      h("button", { class: "btn sm ghost", onclick: refresh }, "Refresh")),
    h("p", { class: "lead" }, o.since
      ? `Tracking since ${day(o.since)}. AI cost is what the Claude API charges for the tokens used, at the prices on the Plans & paywall page (model in use: ${o.model}). Narration (Microsoft Edge voices) and rendering on this server have no per-use charge; render time shows the server load.`
      : `Nothing recorded yet. Every AI call and film render from now on is counted here (model in use: ${o.model}).`),
    o.unpriced.length ? h("div", { class: "warnbox" }, `No price set for ${o.unpriced.join(", ")}, so those calls show $0. Add the price on Plans & paywall.`) : null,
    h("div", { class: "tiles" },
      tile("AI cost", money(t.aiCost), `${int(t.aiCalls)} AI calls`),
      tile("Tokens", tokens(t.tokensIn + t.tokensOut + t.cacheRead + t.cacheWrite), `${tokens(t.tokensIn)} in · ${tokens(t.tokensOut)} out`),
      tile("Films rendered", int(t.renders), t.rendersFailed ? `${t.rendersFailed} failed` : "none failed"),
      tile("Film minutes", mins(t.filmSeconds / 60).replace(" min", ""), `render time ${mins(t.renderSeconds / 60)}`),
      tile("Avg AI cost per film", t.renders ? money(t.aiCost / t.renders) : "—", "all AI cost ÷ films rendered"),
      tile("Accounts", int(o.accounts.total), `${o.accounts.activeInScope} active in this period${o.accounts.turnedOff ? ` · ${o.accounts.turnedOff} turned off` : ""}`),
      tile("Free spots", o.freeSpots.max == null ? `${o.freeSpots.used}` : `${o.freeSpots.used} / ${o.freeSpots.max}`,
        o.freeSpots.max == null ? "no cap set" : o.freeSpots.full ? `full${o.freeSpots.turnedAwayToday ? ` · ${o.freeSpots.turnedAwayToday} turned away today` : ""}` : o.freeSpots.waiting ? `${o.freeSpots.waiting} waiting for a plan` : `${Math.max(0, o.freeSpots.max - o.freeSpots.used)} left`,
        o.freeSpots.warning || o.freeSpots.full),
      tile("Paying accounts", int(o.paying.count), `about ${money(o.paying.monthly)} a month before fees`),
      tile("Biopics", int(o.biopics), "all accounts")),
    h("h2", {}, "By film level"),
    h("p", { class: "small muted" }, "Script writing, script tightening and media picking are charged to the film level they were for. “Biopic setup” is work shared by every film of a biopic."),
    smallTable(levelCols, o.byLevel, { sort: "aiCost" }),
    h("div", { class: "grid2 adm-grid" },
      h("div", {}, h("h2", {}, "By AI task"), smallTable([{ key: "key", label: "Task", text: (r) => TASK_NAMES[r.key] || r.key }, ...tokenCols], o.byTask, { sort: "aiCost" })),
      h("div", {}, h("h2", {}, "By model"), smallTable([{ key: "key", label: "Model" }, ...tokenCols], o.byModel, { sort: "aiCost" }))),
    h("h2", {}, "By month"),
    smallTable([{ key: "key", label: "Month", text: (r) => monthName(r.key) }, ...levelCols.slice(1)], o.byMonth, { sort: "key" }));
}

const accountCols = [
  { key: "username", label: "Account", cell: (r) => h("span", {}, h("b", {}, r.username), r.admin ? h("span", { class: "tag" }, "admin") : null) },
  { key: "status", label: "Status", cell: (r) => h("span", { class: r.status === "Active" ? "ok" : "bad" }, r.status) },
  { key: "planName", label: "Plan", text: (r) => r.planName + (r.custom ? " *" : "") },
  { key: "source", label: "Plan from" },
  { key: "payment", label: "Payment", text: (r) => r.payment || "—" },
  { key: "signupPlace", label: "Signed up from", text: (r) => r.signupPlace || "—" },
  { key: "signupCountry", label: "Country", text: (r) => r.signupCountry || "—" },
  { key: "signupDevice", label: "Sign-up device", text: (r) => r.signupDevice || "—" },
  { key: "signupIp", label: "Sign-up IP", text: (r) => r.signupIp || "—" },
  { key: "referrer", label: "Came from", text: (r) => r.referrer || "—" },
  { key: "lastPlace", label: "Last seen at", text: (r) => r.lastPlace || "—" },
  { key: "lastIp", label: "Last IP", text: (r) => r.lastIp || "—" },
  { key: "lastDevice", label: "Last device", text: (r) => r.lastDevice || "—" },
  { key: "biopics", label: "Biopics", num: true },
  { key: "films", label: "Films", num: true },
  { key: "rendersMonth", label: "Renders (period)", num: true, text: (r) => (r.renderLimit == null ? `${r.rendersMonth}` : `${r.rendersMonth} / ${r.renderLimit}`) },
  { key: "aiCostMonth", label: "AI cost (period)", num: true, text: (r) => money(r.aiCostMonth) },
  { key: "aiBudget", label: "AI budget / month", num: true, text: (r) => money(r.aiBudget) },
  { key: "aiCostTotal", label: "AI cost (all time)", num: true, text: (r) => money(r.aiCostTotal) },
  { key: "tokensTotal", label: "Tokens (all time)", num: true, text: (r) => tokens(r.tokensTotal) },
  { key: "rendersTotal", label: "Renders (all time)", num: true },
  { key: "lastLoginAt", label: "Last sign-in", text: (r) => day(r.lastLoginAt) || "—", value: (r) => r.lastLoginAt || "" },
  { key: "lastSeenAt", label: "Last seen", text: (r) => day(r.lastSeenAt) || "—", value: (r) => r.lastSeenAt || "" },
  { key: "createdAt", label: "Joined", text: (r) => day(r.createdAt), value: (r) => r.createdAt },
];

async function pageAccounts() {
  const [rows, overview] = await Promise.all([load(`api/admin/accounts?${monthQ()}`), load(`api/admin/overview?${monthQ()}`)]);
  months = overview.byMonth.map((m) => m.key);
  header("accounts");
  fill(main,
    h("div", { class: "row" }, h("h1", {}, "Accounts"), h("span", { class: "spacer" }),
      h("button", { class: "btn sm primary", onclick: addAccountDialog }, "Add account"),
      h("button", { class: "btn sm ghost", onclick: refresh }, "Refresh")),
    h("p", { class: "lead" }, `“Period” columns are for ${periodName()}. * = this account has its own plan or limits. Places are approximate (from the IP address). Click an account to change its plan or limits, turn it off, or set a new password.`),
    eperfTable({ id: "a", noun: "accounts", columns: accountCols, rows, sort: "aiCostTotal", dir: "desc", csv: "biopicker-accounts", onRow: (r) => go({ tab: "account", id: r.id }) }));
}

function pwInput(name, attrs = {}) {
  const input = h("input", { name, type: "password", ...attrs });
  const eye = h("button", { type: "button", class: "pw-eye", "aria-label": "Show password", title: "Show password", onclick: () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    eye.textContent = show ? "🙈" : "👁";
    eye.setAttribute("aria-label", show ? "Hide password" : "Show password");
    eye.title = eye.getAttribute("aria-label");
  } }, "👁");
  return h("span", { class: "pw-wrap" }, input, eye);
}
function dialog(title, ...content) {
  document.querySelector("dialog.bp")?.remove();
  const d = h("dialog", { class: "bp" }, h("div", { class: "row" }, h("h2", {}, title), h("span", { class: "spacer" }), h("button", { class: "btn sm ghost", "aria-label": "Close", onclick: () => d.close() }, "✕")), ...content);
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}
async function addAccountDialog() {
  const billing = (await load("api/admin/billing")).billing;
  const f = h("form", { class: "authform" },
    h("label", { class: "f" }, "Username", h("input", { name: "username", required: true, autocomplete: "off", autocapitalize: "none", spellcheck: "false" })),
    h("label", { class: "f" }, "Password", pwInput("password", { required: true, autocomplete: "new-password" })),
    h("label", { class: "f" }, "Plan", h("select", { name: "plan" }, h("option", { value: "" }, `Default for new accounts (${billing.plans.find((p) => p.id === billing.defaultPlan)?.name || billing.defaultPlan})`), ...billing.plans.map((p) => h("option", { value: p.id }, p.name)))),
    h("p", { class: "small muted" }, "Give the person their username and password; they can change the password under Account settings."),
    h("div", { class: "row end" }, h("button", { type: "button", class: "btn", onclick: () => d.close() }, "Cancel"), h("button", { class: "btn primary" }, "Create account")));
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    try {
      const r = await api("POST", "api/admin/accounts", { username: fd.get("username"), password: fd.get("password"), plan: fd.get("plan") });
      d.close();
      toast(`Account ${r.username} created.`);
      cache.clear();
      go({ tab: "account", id: r.id });
    } catch (x) {
      toast(x.message, true);
    }
  });
  const d = dialog("Add an account", f);
}

/** A limit field: the plan's value, no limit, or a number of its own. */
function limitField(label, name, override, planValue, fmt, step) {
  const mode = override === undefined ? "plan" : override === null ? "none" : "custom";
  const sel = h("select", { name: `${name}_mode` },
    h("option", { value: "plan", selected: mode === "plan" ? true : null }, `Plan's (${planValue == null ? "no limit" : fmt(planValue)})`),
    h("option", { value: "none", selected: mode === "none" ? true : null }, "No limit"),
    h("option", { value: "custom", selected: mode === "custom" ? true : null }, "Custom"));
  const num = h("input", { name, type: "number", min: 0, step, value: mode === "custom" ? override : "", style: mode === "custom" ? "" : "display:none" });
  sel.addEventListener("change", () => { num.style.display = sel.value === "custom" ? "" : "none"; if (sel.value === "custom") num.focus(); });
  return h("label", { class: "f" }, label, h("div", { class: "row nowrap" }, sel, num));
}

async function pageAccount(id) {
  const [a, billingResp] = await Promise.all([load(`api/admin/accounts/${encodeURIComponent(id)}`), load("api/admin/billing")]);
  const billing = billingResp.billing;
  const acc = a.account;
  const sub = a.sub;
  const plan =billing.plans.find((p) => p.id === (a.planChoice || acc.plan)) || billing.plans[0];
  const defaultName = billing.plans.find((p) => p.id === (acc.admin ? billing.adminPlan : billing.defaultPlan))?.name;

  const form = h("form", { class: "card grid2" },
    h("label", { class: "f" }, "Plan", h("select", { name: "plan" },
      h("option", { value: "", selected: !a.planChoice ? true : null }, sub?.active ? `From their subscription (${(billing.plans.find((p) => p.id === sub.planId) || {}).name || sub.planId})` : a.needsPlan ? "None yet (waiting for a plan)" : `Default (${defaultName})`),
      ...billing.plans.map((p) => h("option", { value: p.id, selected: a.planChoice === p.id ? true : null }, `${p.name}${p.priceMonthly ? ` · $${p.priceMonthly}/mo` : ""}`)))),
    h("label", { class: "f" }, "Status", h("select", { name: "disabled" },
      h("option", { value: "0", selected: acc.status === "Active" ? true : null }, "Active"),
      h("option", { value: "1", selected: acc.status !== "Active" ? true : null }, "Turned off (can't sign in)"))),
    limitField("Film renders per month", "rendersPerMonth", "rendersPerMonth" in a.limits ? a.limits.rendersPerMonth : undefined, plan.rendersPerMonth, (v) => `${v}`, 1),
    limitField("AI budget per month (US$)", "aiBudgetMonthly", "aiBudgetMonthly" in a.limits ? a.limits.aiBudgetMonthly : undefined, plan.aiBudgetMonthly, money, 0.5),
    h("label", { class: "f" }, "Documentary series", h("select", { name: "series" },
      h("option", { value: "plan", selected: !("series" in a.limits) ? true : null }, `Plan's (${plan.series ? "included" : "not included"})`),
      h("option", { value: "yes", selected: a.limits.series === true ? true : null }, "Allowed"),
      h("option", { value: "no", selected: a.limits.series === false ? true : null }, "Not allowed"))),
    h("div", { class: "row end full" }, h("button", { class: "btn primary" }, "Save changes")));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const lim = (name) => (fd.get(`${name}_mode`) === "plan" ? "plan" : fd.get(`${name}_mode`) === "none" ? "" : fd.get(name));
    const series = fd.get("series");
    try {
      if (fd.get(`rendersPerMonth_mode`) === "custom" && fd.get("rendersPerMonth") === "") throw new Error("Enter the number of renders, or choose No limit.");
      if (fd.get(`aiBudgetMonthly_mode`) === "custom" && fd.get("aiBudgetMonthly") === "") throw new Error("Enter the AI budget, or choose No limit.");
      await api("PATCH", `api/admin/accounts/${encodeURIComponent(id)}`, {
        plan: fd.get("plan"),
        disabled: fd.get("disabled") === "1",
        limits: { rendersPerMonth: lim("rendersPerMonth"), aiBudgetMonthly: lim("aiBudgetMonthly"), ...(series === "plan" ? {} : { series: series === "yes" }) },
      });
      toast("Saved.");
      refresh();
    } catch (x) {
      toast(x.message, true);
    }
  });

  const pwForm = h("form", { class: "row" }, h("label", { class: "f grow" }, "Set a new password (signs them out everywhere)", pwInput("password", { autocomplete: "new-password", required: true })), h("button", { class: "btn" }, "Set password"));
  pwForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("POST", `api/admin/accounts/${encodeURIComponent(id)}/password`, { password: new FormData(pwForm).get("password") });
      pwForm.reset();
      toast("New password set. Give it to them; they can change it under Account settings.");
    } catch (x) {
      toast(x.message, true);
    }
  });

  const loginCols = [
    { key: "at", label: "Signed in", text: (r) => when(r.at), value: (r) => r.at },
    { key: "placeText", label: "Place (approximate)", text: (r) => r.placeText || "unknown" },
    { key: "ip", label: "IP address" },
    { key: "device", label: "Device", text: (r) => r.device || "" },
  ];
  const giveSpot = a.needsPlan ? h("div", { class: "warnbox" },
    "This account signed up when the free spots were full, so it has no plan until it subscribes. ",
    h("button", { class: "btn sm", onclick: async () => {
      try {
        await api("PATCH", `api/admin/accounts/${encodeURIComponent(id)}`, { needsPlan: false });
        toast("Given a free spot.");
        refresh();
      } catch (x) {
        toast(x.message, true);
      }
    } }, "Give a free spot")) : null;
  const su = a.signup;
  const where = h("div", { class: "card" },
    h("div", { class: "grid2" },
      h("div", {},
        h("b", {}, "Signed up"),
        su ? h("div", { class: "small" }, `${when(su.at)} · ${su.placeText || "place unknown"} · ${su.ip}`) : h("div", { class: "small muted" }, "No sign-up record (made by an admin, or before 1.2)."),
        su ? h("div", { class: "small muted" }, `${su.device || "unknown device"}${su.referrer ? ` · came from ${su.referrer}` : " · no referring page"}${su.landing && su.landing !== "/" ? ` · first page ${su.landing}` : ""}`) : null),
      h("div", {},
        h("b", {}, "Last seen"),
        a.lastSeen ? h("div", { class: "small" }, `${when(a.lastSeen.at)} · ${a.lastSeen.placeText || "place unknown"} · ${a.lastSeen.ip}`) : h("div", { class: "small muted" }, "Not seen since tracking started."),
        a.lastSeen ? h("div", { class: "small muted" }, a.lastSeen.device || "") : null)),
    su?.ua ? h("p", { class: "small muted" }, `Sign-up browser: ${su.ua}`) : null);
  const subCard = sub ? h("div", { class: "card" },
    h("b", {}, "Subscription"),
    h("div", { class: "small" }, `${sub.text}${sub.active ? "" : " (not active)"} · plan ${(billing.plans.find((p) => p.id === sub.planId) || {}).name || sub.planId}`),
    h("div", { class: "small muted" }, sub.provider === "stripe" ? `Stripe customer ${sub.customer || "?"} · subscription ${sub.subscription || "?"}. Refunds and cancellations are done in the Stripe dashboard.` : `App Store original transaction ${sub.original}. Refunds are handled by Apple.`),
    a.planChoice ? h("div", { class: "small warn" }, "A plan set here by the admin overrides the subscription.") : null) : null;

  const biopicCols = [
    { key: "name", label: "Biopic", text: (r) => r.name + (r.archived ? " (archived)" : "") + (r.public ? " · public" : "") },
    { key: "films", label: "Films kept", num: true },
    { key: "renders", label: "Renders", num: true },
    { key: "shortCost", label: "Short AI", num: true, text: (r) => money(r.shortCost) },
    { key: "longCost", label: "Long AI", num: true, text: (r) => money(r.longCost) },
    { key: "episodeCost", label: "Episodes AI", num: true, text: (r) => money(r.episodeCost) },
    { key: "setupCost", label: "Setup AI", num: true, text: (r) => money(r.setupCost) },
    { key: "aiCost", label: "Total AI", num: true, text: (r) => money(r.aiCost) },
    { key: "tokens", label: "Tokens", num: true, text: (r) => tokens(r.tokens) },
    { key: "filmMinutes", label: "Film minutes", num: true, text: (r) => mins(r.filmMinutes) },
    { key: "renderMinutes", label: "Render time", num: true, text: (r) => mins(r.renderMinutes) },
    { key: "updatedAt", label: "Last edited", text: (r) => day(r.updatedAt), value: (r) => r.updatedAt || "" },
  ];
  const eventCols = [
    { key: "at", label: "Time", text: (r) => when(r.at), value: (r) => r.at },
    { key: "kind", label: "Kind", text: (r) => (r.t === "ai" ? "AI call" : "Render") },
    { key: "biopic", label: "Biopic" },
    { key: "level", label: "Level", text: (r) => ({ short: "Short", long: "Long", episode: "Episode", setup: "Setup" })[r.level] || r.level },
    { key: "version", label: "Version", text: (r) => r.version || "" },
    { key: "task", label: "Task / result", text: (r) => (r.t === "ai" ? TASK_NAMES[r.task] || r.task || "" : r.status === "done" ? "Rendered" : `Failed${r.error ? `: ${r.error}` : ""}`) },
    { key: "model", label: "Model", text: (r) => (r.model || "") + (r.fallback ? " (fallback)" : "") },
    { key: "in", label: "Input", num: true, text: (r) => (r.t === "ai" ? int(r.in) : "") },
    { key: "out", label: "Output", num: true, text: (r) => (r.t === "ai" ? int(r.out) : "") },
    { key: "cr", label: "Cache read", num: true, text: (r) => (r.t === "ai" ? int(r.cr) : "") },
    { key: "cw", label: "Cache write", num: true, text: (r) => (r.t === "ai" ? int(r.cw) : "") },
    { key: "cost", label: "Cost", num: true, text: (r) => (r.t === "ai" ? money(r.cost) : "") },
    { key: "filmSeconds", label: "Film length", num: true, text: (r) => (r.t === "render" && r.filmSeconds ? `${Math.round(r.filmSeconds)} s` : "") },
    { key: "wallSeconds", label: "Render time", num: true, text: (r) => (r.t === "render" ? `${Math.round(r.wallSeconds)} s` : "") },
  ];

  fill(main,
    h("p", {}, h("a", { href: "#", onclick: (e) => { e.preventDefault(); go({ tab: "accounts", id: null }); } }, "‹ All accounts")),
    h("div", { class: "row" }, h("h1", {}, acc.username), acc.admin ? h("span", { class: "tag" }, "admin") : null, h("span", { class: acc.status === "Active" ? "tag ok" : "tag bad" }, acc.status)),
    h("p", { class: "lead" }, `Joined ${day(acc.createdAt)}${acc.lastLoginAt ? ` · last signed in ${when(acc.lastLoginAt)}` : ""}${acc.lastActivity ? ` · last activity ${when(acc.lastActivity)}` : ""}${acc.devices ? ` · ${acc.devices} iPhone(s) for notifications` : ""}`),
    h("div", { class: "tiles" },
      tile("Plan", acc.planName, acc.custom ? "own plan or limits" : "default"),
      tile("Renders this month", acc.renderLimit == null ? `${acc.rendersMonth}` : `${acc.rendersMonth} / ${acc.renderLimit}`, acc.renderLimit == null ? "no limit" : `${Math.max(0, acc.renderLimit - acc.rendersMonth)} left`),
      tile("AI cost this month", money(acc.aiCostMonth), acc.aiBudget == null ? "no budget limit" : `budget ${money(acc.aiBudget)}`),
      tile("AI cost, all time", money(acc.aiCostTotal), `${tokens(acc.tokensTotal)} tokens`),
      tile("Biopics", int(acc.biopics), `${acc.films} films kept · ${acc.rendersTotal} rendered`)),
    giveSpot,
    h("h2", {}, "Plan and limits"), form,
    subCard,
    h("h2", {}, "Where they sign in from"),
    where,
    a.logins.length ? smallTable(loginCols, a.logins, { sort: "at" }) : null,
    h("div", { class: "card" }, pwForm),
    h("h2", {}, "Biopics"),
    eperfTable({ id: "b", noun: "biopics", columns: biopicCols, rows: a.biopics, sort: "aiCost", dir: "desc", csv: `biopicker-${acc.username}-biopics`, emptyAll: "This account has no biopics." }),
    h("h2", {}, "By month"),
    smallTable([{ key: "key", label: "Month", text: (r) => monthName(r.key) }, ...levelCols.slice(1)], a.byMonth, { sort: "key" }),
    h("h2", {}, "Activity"),
    h("p", { class: "small muted" }, "The latest 500 AI calls and renders. “Export usage CSV” on Usage & cost has everything."),
    eperfTable({ id: "e", noun: "events", columns: eventCols, rows: a.events, sort: "at", dir: "desc", csv: `biopicker-${acc.username}-activity`, emptyAll: "No AI calls or renders recorded for this account yet." }));
}

async function pagePlans() {
  const r = await load("api/admin/billing");
  const b = JSON.parse(JSON.stringify(r.billing));
  const planRows = h("tbody");
  const priceRows = h("tbody");
  const numIn = (obj, key, attrs = {}) => h("input", { type: "number", min: 0, step: "any", value: obj[key] ?? "", placeholder: attrs.placeholder || "", oninput: (e) => (obj[key] = e.target.value === "" ? null : Number(e.target.value)), ...attrs });
  const txtIn = (obj, key, attrs = {}) => h("input", { value: obj[key] ?? "", oninput: (e) => (obj[key] = e.target.value), ...attrs });
  const defaultSel = h("select");
  const adminSel = h("select");
  const drawPlanSelects = () => {
    fill(defaultSel, ...b.plans.map((p) => h("option", { value: p.id, selected: p.id === b.defaultPlan ? true : null }, p.name || p.id)));
    fill(adminSel, ...b.plans.map((p) => h("option", { value: p.id, selected: p.id === b.adminPlan ? true : null }, p.name || p.id)));
  };
  defaultSel.onchange = () => (b.defaultPlan = defaultSel.value);
  b.signups = b.signups || { freeMax: null, perIpPerDay: 3, whenFull: "closed", fullMessage: "" };
  adminSel.onchange = () => (b.adminPlan = adminSel.value);
  const drawPlans = () => {
    fill(planRows, ...b.plans.map((p, i) => h("tr", {},
      h("td", {}, txtIn(p, "id", { size: 8, "aria-label": "Plan id", oninput: (e) => { p.id = e.target.value; drawPlanSelects(); } })),
      h("td", {}, txtIn(p, "name", { "aria-label": "Plan name", oninput: (e) => { p.name = e.target.value; drawPlanSelects(); } })),
      h("td", {}, numIn(p, "priceMonthly", { "aria-label": "Price per month" })),
      h("td", {}, numIn(p, "rendersPerMonth", { placeholder: "no limit", "aria-label": "Renders per month" })),
      h("td", {}, numIn(p, "aiBudgetMonthly", { placeholder: "no limit", "aria-label": "AI budget per month" })),
      h("td", { class: "center" }, h("input", { type: "checkbox", checked: p.series, "aria-label": "Series included", onchange: (e) => (p.series = e.target.checked) })),
      h("td", {}, txtIn(p, "description", { "aria-label": "Description" })),
      h("td", {}, txtIn(p, "stripePriceId", { size: 14, placeholder: "price_…", "aria-label": "Stripe price id" })),
      h("td", {}, txtIn(p, "appleProductId", { size: 14, placeholder: "com.eperf.biopicker.plus", "aria-label": "Apple product id" })),
      h("td", {}, h("button", { type: "button", class: "btn sm ghost danger", title: "Remove plan", onclick: () => { b.plans.splice(i, 1); drawPlans(); drawPlanSelects(); } }, "✕")))));
  };
  const drawPrices = () => {
    fill(priceRows, ...Object.entries(b.prices).map(([model, p]) => h("tr", {},
      h("td", {}, h("code", {}, model), model === r.model ? h("span", { class: "tag" }, "in use") : null),
      h("td", {}, numIn(p, "input")), h("td", {}, numIn(p, "output")), h("td", {}, numIn(p, "cacheWrite")), h("td", {}, numIn(p, "cacheRead")),
      h("td", {}, h("button", { type: "button", class: "btn sm ghost danger", title: "Remove", onclick: () => { delete b.prices[model]; drawPrices(); } }, "✕")))));
  };
  drawPlans();
  drawPlanSelects();
  drawPrices();
  const newModel = h("input", { placeholder: "model id, e.g. claude-opus-5-5", size: 28 });
  const missing = [...new Set([r.model, ...r.modelsSeen])].filter((m) => !b.prices[m]);
  const pw = b.paywall;
  const su = b.signups;
  const ps = r.payments;
  const modelSel = h("select", { onchange: (e) => (b.aiModel = e.target.value || null) },
    h("option", { value: "", selected: !b.aiModel ? true : null }, `Default (${r.defaultModel})`),
    ...Object.keys(b.prices).map((m) => h("option", { value: m, selected: b.aiModel === m ? true : null }, m)));
  const yes = (ok, good, bad) => h("span", { class: ok ? "ok" : "bad" }, ok ? `✓ ${good}` : `✗ ${bad}`);
  const copyable = (v) => h("input", { value: v, readonly: true, onclick: (e) => e.target.select() });

  const save = async () => {
    try {
      const res = await api("PUT", "api/admin/billing", b);
      cache.clear();
      cache.set("api/admin/billing", Promise.resolve({ ...r, billing: res.billing }));
      toast("Plans, paywall and prices saved.");
      route();
    } catch (x) {
      toast(x.message, true);
    }
  };

  fill(main,
    h("div", { class: "row" }, h("h1", {}, "Plans & paywall"), h("span", { class: "spacer" }), h("button", { class: "btn primary", onclick: save }, "Save")),
    h("p", { class: "lead" }, "Plans set how many films each account can render per month, how much AI work it can use (in US$ of Claude API cost), and whether documentary series are included. Blank means no limit. A limit stops new work when reached; work already started finishes."),
    h("div", { class: "card" },
      h("h2", {}, "Plans"),
      h("div", { class: "tscroll" }, h("table", { class: "et edit" },
        h("thead", {}, h("tr", {}, ...["Id", "Name", "Price / month ($)", "Renders / month", "AI budget / month ($)", "Series", "Description", "Stripe price id", "Apple product id", ""].map((x) => h("th", {}, x)))),
        planRows)),
      h("div", { class: "row" }, h("button", { type: "button", class: "btn sm", onclick: () => { b.plans.push({ id: `plan${b.plans.length + 1}`, name: "New plan", priceMonthly: 0, rendersPerMonth: 5, aiBudgetMonthly: 5, series: false, description: "" }); drawPlans(); drawPlanSelects(); } }, "Add a plan")),
      h("div", { class: "grid2" }, h("label", { class: "f" }, "New accounts get", defaultSel), h("label", { class: "f" }, "Admins get", adminSel))),
    h("div", { class: "card" },
      h("h2", {}, "Sign-ups"),
      h("p", { class: "small muted" },
        r.freeSpots.warning || r.freeSpots.full ? h("b", { class: "warn" }, "⚠ ") : null,
        `Free spots in use: ${r.freeSpots.used}${su.freeMax != null ? ` of ${su.freeMax}` : ""}${r.freeSpots.waiting ? ` · ${r.freeSpots.waiting} waiting for a plan` : ""}${r.freeSpots.turnedAwayToday ? ` · ${r.freeSpots.turnedAwayToday} turned away today` : ""}. A free spot is an account on the new-account plan that isn't paying, wasn't given a plan by you, and isn't turned off. Admin-made accounts and the ones you give a plan to don't count.`),
      h("div", { class: "grid2" },
        h("label", { class: "f" }, "Most free accounts", numIn(su, "freeMax", { placeholder: "no cap", step: 1 })),
        h("label", { class: "f" }, "New accounts per IP address per day", numIn(su, "perIpPerDay", { placeholder: "no limit", step: 1 })),
        h("label", { class: "f" }, "When the free spots are full", h("select", { onchange: (e) => (su.whenFull = e.target.value) },
          h("option", { value: "closed", selected: su.whenFull !== "paid" ? true : null }, "Stop new sign-ups (show the message)"),
          h("option", { value: "paid", selected: su.whenFull === "paid" ? true : null }, "Let people sign up, but they must choose a paid plan"))),
        h("label", { class: "f" }, "Message when sign-ups are stopped", txtIn(su, "fullMessage")),
        h("label", { class: "f" }, "Warn me when this many free spots are used", numIn(su, "alertAt", { placeholder: "off", step: 1 })),
        h("label", { class: "f" }, "Send warnings to", txtIn(su, "alertEmail", { type: "email", placeholder: "you@example.com", autocomplete: "email" }))),
      h("p", { class: "small muted" }, "You get an email each time a new free account brings the count to the warning level or above, and at most one a day when someone is turned away because the spots are full. The admin panel shows ⚠ at the top while it applies."),
      h("div", { class: "row" },
        h("span", { class: "small" }, r.email.ready ? yes(true, `email set up (sending as ${r.email.from})`) : yes(false, "", "email not set up: SMTP_HOST, SMTP_USER, SMTP_PASS in the server's .env (see DEPLOY.md); until then warnings only show here")),
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "btn sm", onclick: async (e) => {
          e.target.disabled = true;
          try {
            const x = await api("POST", "api/admin/alerts/test");
            toast(x.result === "sent" ? `Test email sent to ${x.to}.` : `Not sent: ${x.result}.`, x.result !== "sent");
            cache.delete("api/admin/billing");
          } catch (x) {
            toast(x.message, true);
          } finally {
            e.target.disabled = false;
          }
        } }, "Send a test email")),
      r.email.log.length ? h("details", {}, h("summary", { class: "small" }, `Recent warning emails (${r.email.log.length})`),
        smallTable([
          { key: "at", label: "When", text: (x) => when(x.at) },
          { key: "to", label: "To" },
          { key: "subject", label: "Subject" },
          { key: "result", label: "Result" },
        ], r.email.log, { sort: "at" })) : null),
    h("div", { class: "card" },
      h("h2", {}, "Payments"),
      h("p", { class: "small muted" }, "People choose a plan under Account settings, or when they reach a limit. On the website they pay by card through Stripe; in the iPhone app they pay through Apple (App Store rules require it). A plan is offered for sale when it has a Stripe price id (web) or an Apple product id (app). Their plan changes as soon as the payment is confirmed, and goes back when the subscription ends."),
      h("div", { class: "grid2" },
        h("div", {},
          h("b", {}, "Stripe (website)"),
          h("div", { class: "small" }, yes(ps.stripe.keys, `secret key set${ps.stripe.live ? " (live)" : " (test mode)"}`, "STRIPE_SECRET_KEY not set")),
          h("div", { class: "small" }, yes(ps.stripe.webhookSecret, "webhook secret set", "STRIPE_WEBHOOK_SECRET not set")),
          h("div", { class: "small" }, yes(ps.stripe.plans > 0, `${ps.stripe.plans} plan(s) with a price id`, "no plan has a Stripe price id")),
          h("label", { class: "f" }, "Webhook address for the Stripe dashboard", copyable(r.webhooks.stripe))),
        h("div", {},
          h("b", {}, "Apple (iPhone app)"),
          h("div", { class: "small" }, `App bundle id: ${ps.apple.bundleId}`),
          h("div", { class: "small" }, yes(ps.apple.plans > 0, `${ps.apple.plans} plan(s) with a product id`, "no plan has an Apple product id")),
          h("label", { class: "f" }, "Server notifications address for App Store Connect (Version 2)", copyable(r.webhooks.apple)))),
      h("p", { class: "small muted" }, "Keys go in the server's .env file (see DEPLOY.md), never here."),
      h("h3", {}, "Without payments"),
      h("p", { class: "small muted" }, "If no plan can be bought here, a person who reaches a limit can instead be shown your message with an “Upgrade” button that opens a link of yours; you then set their plan by hand."),
      h("label", { class: "agree" }, h("input", { type: "checkbox", checked: pw.enabled, onchange: (e) => (pw.enabled = e.target.checked) }), h("span", {}, "Offer an upgrade when someone reaches a limit")),
      h("div", { class: "grid2" },
        h("label", { class: "f full" }, "Message shown with the limit", h("textarea", { rows: 2, value: pw.message, oninput: (e) => (pw.message = e.target.value) })),
        h("label", { class: "f" }, "Upgrade link (only used when no plan can be bought here)", txtIn(pw, "upgradeUrl", { placeholder: "https://…" })))),
    h("div", { class: "card" },
      h("h2", {}, "AI prices"),
      h("label", { class: "f" }, "Model BioPicker uses for all AI work", modelSel),
      h("p", { class: "small muted" }, `Takes effect with the next AI call after you save. Now using ${r.model}. Prices are US dollars per million tokens, from Anthropic's price list. Costs are worked out from these, so correcting a price here also corrects past months.`),
      missing.length ? h("div", { class: "warnbox" }, `No price for ${missing.join(", ")}.`) : null,
      h("div", { class: "tscroll" }, h("table", { class: "et edit" },
        h("thead", {}, h("tr", {}, ...["Model", "Input", "Output", "Cache write", "Cache read", ""].map((x) => h("th", {}, x)))),
        priceRows)),
      h("div", { class: "row" }, newModel, h("button", { type: "button", class: "btn sm", onclick: () => {
        const m = newModel.value.trim();
        if (!m) return;
        b.prices[m] = b.prices[m] || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
        newModel.value = "";
        drawPrices();
      } }, "Add a model"))),
    h("div", { class: "row end" }, h("button", { class: "btn primary", onclick: save }, "Save")),
    h("p", { class: "small muted" }, r.geo ? "Places are looked up on this server with the free DB-IP City Lite database. " : "Place lookups aren't ready yet (the DB-IP database downloads shortly after the server starts). ",
      h("a", { href: "https://db-ip.com", target: "_blank", rel: "noopener" }, "IP Geolocation by DB-IP"), " (CC BY 4.0)."));
}

route();
