// BioPicker front end — © 2026 ePerf
const $ = (s, el = document) => el.querySelector(s);
const main = $("#main");

// ---------- tiny DOM helper ----------
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

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (err ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = ""), err ? 6000 : 2800);
}

async function api(method, url, body, isForm) {
  const r = await fetch(url, {
    method,
    headers: isForm || !body ? {} : { "Content-Type": "application/json" },
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : await r.blob();
  if (r.status === 401 && data?.login) {
    showLogin();
    throw new Error("Please enter the passcode.");
  }
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

// ---------- state ----------
let P = null; // current project
let step = "person";
let health = { ai: true };
let voices = null;
let scriptTab = "short";
const STEPS = [
  ["person", "The person"],
  ["media", "Photos & documents"],
  ["timeline", "Timeline & places"],
  ["interview", "AI interview"],
  ["history", "History overlay"],
  ["style", "Style, length & voice"],
  ["script", "Script & media"],
  ["render", "Render film"],
];

const recent = () => {
  try {
    return JSON.parse(localStorage.getItem("bp_recent") || "[]");
  } catch {
    return [];
  }
};
function remember(p) {
  try {
    const list = recent().filter((x) => x.id !== p.id);
    list.unshift({ id: p.id, name: p.person.name || "Untitled", at: Date.now() });
    localStorage.setItem("bp_recent", JSON.stringify(list.slice(0, 20)));
  } catch {}
}

const fileUrl = (dir, f) => `files/${P.id}/${dir}/${encodeURIComponent(f)}`;
const TYPES = ["birth", "school", "graduation", "college", "job", "marriage", "child", "move", "military", "award", "fame", "retirement", "death", "other"];

// ---------- routing ----------
function route() {
  const m = location.hash.match(/p=([A-Za-z0-9]+)(?:&s=(\w+))?/);
  if (!m) {
    if (P && isDirty()) flush();
    P = null;
    return renderHome();
  }
  step = m[2] || step;
  if (!P || P.id !== m[1]) {
    if (P && isDirty()) flush();
    api("GET", `api/projects/${m[1]}`)
      .then((p) => {
        P = p;
        remember(P);
        render();
        watchJobs();
      })
      .catch((e) => {
        toast(e.message, true);
        location.hash = "";
      });
  } else render();
}
window.addEventListener("hashchange", route);
const go = (s) => (location.hash = `p=${P.id}&s=${s}`);

// ---------- persistence ----------
// Every edit is saved to the server a moment after you stop typing, so work survives closing the tab
// and can be continued from any browser that can reach this server.
const saveState = { inflight: 0, error: null, at: null };
const deferred = new Map(); // key -> { run, beacon } debounced saves other than patch() (e.g. the script editor)
const isDirty = () => !!(patch.pending && Object.keys(patch.pending).length) || deferred.size > 0;

async function tracked(fn) {
  saveState.inflight++;
  updateSaveUI();
  try {
    const r = await fn();
    saveState.error = null;
    saveState.at = new Date();
    return r;
  } catch (e) {
    saveState.error = e.message;
    throw e;
  } finally {
    saveState.inflight--;
    updateSaveUI();
  }
}

let saveTimer;
let patchWaiters = [];
function patch(body, delay = 500) {
  clearTimeout(saveTimer);
  const id = P.id;
  if (Object.keys(body).length) patch.pending = { ...(patch.pending || {}), ...body };
  updateSaveUI();
  return new Promise((res) => {
    patchWaiters.push(res);
    saveTimer = setTimeout(async () => {
      const b = patch.pending;
      const waiters = patchWaiters;
      patch.pending = null;
      patchWaiters = [];
      let out = null;
      if (b && Object.keys(b).length) {
        try {
          const p = await tracked(() => api("PATCH", `api/projects/${id}`, b));
          if (P?.id === id) {
            P = { ...p, jobs: p.jobs };
            renderProjBar();
          }
          out = P;
        } catch (e) {
          // keep the unsaved edits so "Save now" (or the next edit) retries them
          patch.pending = { ...b, ...(patch.pending || {}) };
          toast(`Not saved: ${e.message}`, true);
          updateSaveUI();
        }
      } else out = P;
      waiters.forEach((w) => w(out));
    }, delay);
  });
}

function defer(key, run, beacon, delay = 900) {
  const prev = deferred.get(key);
  clearTimeout(prev?.t);
  const d = { run, beacon, t: setTimeout(() => runDeferred(key), delay) };
  deferred.set(key, d);
  updateSaveUI();
}
function runDeferred(key) {
  const d = deferred.get(key);
  if (!d) return Promise.resolve();
  clearTimeout(d.t);
  deferred.delete(key);
  return tracked(d.run).catch((e) => toast(`Not saved: ${e.message}`, true));
}

const flush = async () => {
  await Promise.all([...deferred.keys()].map(runDeferred));
  return patch({}, 0);
};

// Last-chance save when the tab is closed, reloaded or sent to the background.
function beaconSaves() {
  if (!P) return;
  if (patch.pending && Object.keys(patch.pending).length) {
    clearTimeout(saveTimer);
    fetch(`api/projects/${P.id}`, { method: "PATCH", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch.pending) }).catch(() => {});
  }
  for (const [key, d] of deferred) {
    clearTimeout(d.t);
    try { d.beacon?.(); } catch {}
    deferred.delete(key);
  }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && isDirty()) flush(); });
window.addEventListener("beforeunload", (e) => {
  if (!isDirty() && !saveState.inflight) return;
  beaconSaves();
  e.preventDefault();
  e.returnValue = ""; // browser asks "Leave site?" so the final save has time to land
});
window.addEventListener("pagehide", beaconSaves);

function updateSaveUI() {
  const el = document.getElementById("saveStat");
  if (!el) return;
  let text, cls;
  if (saveState.inflight) (text = "Saving…"), (cls = "saving");
  else if (saveState.error && isDirty()) (text = "Not saved — retry"), (cls = "err");
  else if (isDirty()) (text = "Unsaved changes…"), (cls = "saving");
  else if (saveState.at) (text = `Saved ✓ ${saveState.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`), (cls = "ok");
  else if (P?.updatedAt) (text = `Saved ✓ ${new Date(P.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`), (cls = "ok");
  else (text = "Saved ✓"), (cls = "ok");
  el.textContent = text;
  el.className = "savestat " + cls;
  el.title = saveState.error ? `Last error: ${saveState.error}` : "Your work is saved on the BioPicker server automatically as you type.";
}

async function saveNow() {
  try {
    await flush();
    if (!isDirty()) toast("All changes saved. You can close this tab and continue later from “All biopics”.");
  } catch (e) {
    toast(e.message, true);
  }
}

async function copyLink() {
  const url = `${location.origin}${location.pathname}#p=${P.id}&s=${step}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied. Open it in any browser that can reach this server to continue.");
  } catch {
    prompt("Copy this link to continue elsewhere:", url);
  }
}

async function downloadBackup() {
  await flush();
  const a = h("a", { href: `api/projects/${P.id}/export`, download: "" });
  document.body.append(a);
  a.click();
  a.remove();
  toast("Downloading a full backup (.zip). Restore it on any BioPicker from the home page.");
}

// ---------- File menu: Word round trip, undo, link, backup ----------
function fileMenu() {
  const menu = h("details", { class: "menu" });
  const item = (label, hint, fn) => h("button", { onclick: () => { menu.open = false; fn(); } }, h("b", {}, label), h("span", {}, hint));
  const wordInput = h("input", { type: "file", accept: ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document", hidden: true, onchange: (e) => { uploadWord(e.target.files[0]); e.target.value = ""; } });
  menu.append(
    h("summary", { class: "btn sm ghost" }, "File ▾"),
    h("div", { class: "pop" },
      item("Download Word document", "Everything you've entered, the photos and the scripts, to edit in Word", downloadWord),
      item("Update from Word…", "Upload the edited .docx; changes are applied and can be undone", () => wordInput.click()),
      item("Undo a change…", "Go back to before a Word upload or script restore", showHistory),
      h("hr"),
      item("Copy link", "Continue this biopic in another browser or device", copyLink),
      item("Download backup (.zip)", "Everything, including films, to restore on any BioPicker", downloadBackup),
      h("hr"),
      P.archivedAt
        ? item("Unarchive", "Put this biopic back in your main list", () => setArchived(P.id, false, render))
        : item("Archive", "Hide from the main list; nothing is changed or deleted", () => setArchived(P.id, true, render)),
      item("Delete biopic…", "Move to Recently deleted (restorable for 30 days)", () => deleteBiopic({ id: P.id, name: P.person.name, archivedAt: P.archivedAt, counts: { films: P.films.length } }))),
    wordInput,
  );
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) menu.open = false; });
  return menu;
}

function showDialog(title, ...content) {
  document.querySelector("dialog.bp")?.remove();
  const d = h("dialog", { class: "bp" },
    h("div", { class: "row" }, h("h2", {}, title), h("span", { class: "spacer" }), h("button", { class: "btn sm ghost", "aria-label": "Close", onclick: () => d.close() }, "✕")),
    ...content);
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

async function downloadWord() {
  await flush();
  const a = h("a", { href: `api/projects/${P.id}/word`, download: "" });
  document.body.append(a);
  a.click();
  a.remove();
  toast("Downloading the Word document. Edit it, save it as .docx, then use File → Update from Word.");
}

async function uploadWord(file) {
  if (!file) return;
  await flush();
  const fd = new FormData();
  fd.append("doc", file);
  toast(`Reading ${file.name}…`);
  try {
    const r = await api("POST", `api/projects/${P.id}/word`, fd, true);
    P = r.project;
    render();
    watchJobs();
    const scriptsTouched = r.changes.some((c) => /script/i.test(c));
    showDialog(r.changes.length ? "Updated from Word" : "Nothing to update",
      r.changes.length
        ? h("ul", {}, ...r.changes.map((c) => h("li", {}, c)))
        : h("p", { class: "muted" }, "The document matches what's already in BioPicker."),
      r.warnings.length ? h("div", { class: "warnbox" }, h("b", {}, "Please check"), h("ul", {}, ...r.warnings.map((w) => h("li", {}, w)))) : null,
      scriptsTouched ? h("p", { class: "small" }, "Script changes show up in your films after you render them again. Each render is saved as a new version, and your earlier versions are kept.") : null,
      h("div", { class: "row end" },
        r.undo ? h("button", { class: "btn", onclick: async (e) => { e.currentTarget.disabled = true; await undoTo(r.undo.file); document.querySelector("dialog.bp")?.close(); } }, "Undo this upload") : null,
        scriptsTouched ? h("button", { class: "btn", onclick: () => { document.querySelector("dialog.bp")?.close(); go("render"); } }, "Go to Render →") : null,
        h("button", { class: "btn primary", onclick: () => document.querySelector("dialog.bp")?.close() }, "OK")));
  } catch (e) {
    toast(e.message, true);
  }
}

async function undoTo(file) {
  try {
    P = await api("POST", `api/projects/${P.id}/history/${encodeURIComponent(file)}/restore`);
    render();
    toast("Undone. (Your state just before the undo was saved too, in case you change your mind.)");
  } catch (e) {
    toast(e.message, true);
  }
}

async function showHistory() {
  await flush();
  let list = [];
  try { list = await api("GET", `api/projects/${P.id}/history`); } catch (e) { return toast(e.message, true); }
  showDialog("Undo a change",
    h("p", { class: "muted small" }, "BioPicker saves an undo point before each Word upload and script restore. Going back restores your details, timeline, photos, interview, series plan and scripts. Rendered films are never removed by an undo."),
    list.length
      ? h("div", { class: "hist" }, ...list.map((s) => h("div", { class: "row" },
          h("span", {}, h("b", {}, new Date(s.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })), h("span", { class: "muted small" }, "  ", s.reason)),
          h("span", { class: "spacer" }),
          h("button", { class: "btn sm", onclick: async () => { if (confirm(`Go back to how things were ${s.reason.toLowerCase()}?`)) { await undoTo(s.file); document.querySelector("dialog.bp")?.close(); } } }, "Go back to this"))))
      : h("p", {}, "No undo points yet."));
}

async function restoreBackup(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append("backup", file);
  toast(`Restoring ${file.name}…`);
  try {
    const r = await api("POST", "api/projects/import", fd, true);
    toast(r.copy ? `Restored as a copy: ${r.name}` : `Restored: ${r.name}`);
    location.hash = `p=${r.id}&s=person`;
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- job watching ----------
const watching = new Set();
async function watchJob(job, { onDone } = {}) {
  if (watching.has(job.id)) return;
  watching.add(job.id);
  while (true) {
    await new Promise((r) => setTimeout(r, 1500));
    let j;
    try {
      j = await api("GET", `api/jobs/${job.id}`);
    } catch {
      break;
    }
    updateJobUI(j);
    if (j.status === "done" || j.status === "error") {
      watching.delete(job.id);
      if (j.status === "error") toast(`${j.label}: ${j.error}`, true);
      else toast(`${j.label} — done`);
      await reload();
      onDone?.(j);
      return j;
    }
  }
  watching.delete(job.id);
}
function watchJobs() {
  for (const j of P.jobs || []) watchJob(j);
}
async function reload() {
  P = await api("GET", `api/projects/${P.id}`);
  render();
}
const jobUI = new Map();
function updateJobUI(j) {
  jobUI.set(j.id, j);
  const box = $("#jobs");
  if (!box) return;
  box.replaceChildren(
    ...[...jobUI.values()]
      .filter((x) => x.status === "running" || x.status === "queued")
      .map((x) =>
        h("div", { class: "job" },
          h("div", {}, h("b", {}, x.label), " ", h("span", { class: "muted" }, x.status === "queued" ? "(queued)" : x.log?.at(-1)?.slice(9) || "")),
          h("div", { class: "progress" }, h("div", { style: `width:${Math.round((x.progress || 0) * 100)}%` }))),
      ),
  );
  const log = $("#renderLog");
  if (log && j.type === "render" && j.status === "running") {
    log.textContent = (j.log || []).join("\n");
    log.scrollTop = log.scrollHeight;
    const bar = $("#renderBar");
    if (bar) bar.style.width = `${Math.round(j.progress * 100)}%`;
  }
}

// ---------- chrome ----------
function renderProjBar() {
  const bar = $("#projBar");
  bar.replaceChildren();
  if (!P) return;
  bar.append(
    h("span", { class: "muted small" }, "Biopic of"),
    h("b", {}, P.person.name || "Untitled"),
    h("span", { id: "saveStat", class: "savestat ok", role: "status", "aria-live": "polite" }),
    h("button", { class: "btn sm", onclick: saveNow, title: "Save everything now (edits also save automatically as you type)" }, "Save now"),
    fileMenu(),
    h("button", { class: "btn sm ghost", onclick: () => (location.hash = "") }, "All biopics"),
  );
  updateSaveUI();
}

function renderSteps() {
  const nav = $("#steps");
  nav.replaceChildren();
  if (!P) return;
  const done = {
    person: !!P.person.name,
    media: P.photos.length > 0,
    timeline: P.timeline.length > 0,
    interview: P.interview.some((q) => q.answer),
    history: !!P.context,
    style: !!P.settings.voice,
    script: Object.keys(P.scripts).length > 0,
    render: Object.keys(P.renders).length > 0,
  };
  STEPS.forEach(([k, label], i) =>
    nav.append(
      h("button", { class: (k === step ? "on " : "") + (done[k] ? "done" : ""), onclick: () => go(k), "aria-current": k === step ? "step" : null },
        h("span", { class: "n" }, done[k] && k !== step ? "✓" : i + 1), label),
    ),
  );
}

function render() {
  renderProjBar();
  renderSteps();
  if (!P) return;
  const views = { person: vPerson, media: vMedia, timeline: vTimeline, interview: vInterview, history: vHistory, style: vStyle, script: vScript, render: vRender };
  const scrollY = window.scrollY;
  const active = document.activeElement?.id;
  main.replaceChildren(
    P.archivedAt ? h("div", { class: "banner" }, "🗄 This biopic is archived, so it's hidden from your main list. You can still view and edit it.", h("button", { class: "btn sm", onclick: () => setArchived(P.id, false, render) }, "Unarchive")) : null,
    h("div", { id: "jobs", class: "jobs" }),
    (views[step] || vPerson)());
  for (const j of P.jobs || []) updateJobUI(j);
  window.scrollTo(0, scrollY);
  if (active && document.getElementById(active)) document.getElementById(active).focus();
}

function nextBtn(to, label = "Continue") {
  return h("div", { class: "row end" }, h("button", { class: "btn primary", onclick: async () => { await flush(); go(to); } }, label + " →"));
}

function aiWarn() {
  return health.ai ? null : h("div", { class: "card", style: "border-color:var(--red)" }, "AI features are offline on this server (no Anthropic API key configured).");
}

// ---------- home ----------
function renderHome() {
  renderProjBar();
  renderSteps();
  main.replaceChildren(
    h("div", { class: "hero" },
      h("h1", {}, "Every life is a film."),
      h("p", {}, "Upload photos, documents, dates and places. BioPicker interviews you, researches the history around each moment, casts a narrator, and cuts a Ken Burns–style biopic with public-domain newsreels, art and music."),
      h("div", { class: "row", style: "justify-content:center" },
        h("input", { id: "newName", placeholder: "Whose story? e.g. Grandma Rose Alvarez", style: "max-width:340px" }),
        h("button", { class: "btn primary", onclick: newProject }, "Start a biopic")),
      h("div", { class: "recent", id: "projList" }, h("p", { class: "muted small" }, "Loading your saved biopics…")),
      h("div", { class: "restore" },
        h("label", { class: "btn sm ghost" }, "Restore a backup (.zip)…",
          h("input", { type: "file", accept: ".zip,application/zip", hidden: true, onchange: (e) => restoreBackup(e.target.files[0]) }))),
    ),
  );
  Promise.all([api("GET", "api/projects"), api("GET", "api/trash").catch(() => [])])
    .then(([list, trash]) => drawProjects(list, trash))
    .catch(() => drawProjects(recent().map((x) => ({ id: x.id, name: x.name, updatedAt: new Date(x.at).toISOString() })), []));
  $("#newName").addEventListener("keydown", (e) => e.key === "Enter" && newProject());
}

function drawProjects(list, trash = []) {
  const box = document.getElementById("projList");
  if (!box) return;
  const ago = (t) => {
    const d = new Date(t);
    return isNaN(d) ? "" : d.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  };
  const bits = (c) => c ? [c.photos && `${c.photos} photo${c.photos > 1 ? "s" : ""}`, c.events && `${c.events} event${c.events > 1 ? "s" : ""}`, c.answers && `${c.answers} answer${c.answers > 1 ? "s" : ""}`, c.scripts && "script ready", c.films && "film rendered"].filter(Boolean).join(" · ") : "";
  const row = (x) => h("div", { class: "projitem" + (x.archivedAt ? " archived" : "") },
    h("a", { href: `#p=${x.id}`, class: "projrow" },
      x.cover ? h("img", { src: `files/${x.id}/thumbs/${encodeURIComponent(x.cover)}`, alt: "", loading: "lazy" }) : h("span", { class: "ph" }, "🎬"),
      h("span", { class: "meta" }, h("b", {}, x.name), h("span", { class: "muted small" }, [x.archivedAt ? `Archived ${ago(x.archivedAt)}` : `Last saved ${ago(x.updatedAt)}`, bits(x.counts)].filter(Boolean).join(" · "))),
      h("span", { class: "go" }, x.archivedAt ? "Open →" : "Continue →")),
    x.counts
      ? h("div", { class: "rowacts" },
          h("button", { class: "btn sm ghost", title: x.archivedAt ? "Move back to your biopics" : "Hide from this list; nothing is changed or deleted", onclick: () => setArchived(x.id, !x.archivedAt, renderHome) }, x.archivedAt ? "Unarchive" : "Archive"),
          h("button", { class: "btn sm ghost danger", title: "Delete this biopic", onclick: () => deleteBiopic(x, renderHome) }, "Delete"))
      : null);
  const active = list.filter((x) => !x.archivedAt);
  const archived = list.filter((x) => x.archivedAt);
  box.replaceChildren(
    ...(active.length
      ? [h("h3", {}, "Your saved biopics — pick up where you left off"), ...active.map(row)]
      : [h("p", { class: "muted small" }, archived.length ? "No active biopics. Your archived ones are below." : "No saved biopics yet.")]),
    archived.length ? h("details", { class: "fold" }, h("summary", {}, `Archived (${archived.length})`), ...archived.map(row)) : null,
    trash.length
      ? h("details", { class: "fold" }, h("summary", {}, `Recently deleted (${trash.length})`),
          h("p", { class: "muted small" }, `Deleted biopics are kept for ${30} days, then removed for good.`),
          ...trash.map((t) => h("div", { class: "projitem deleted" },
            h("div", { class: "projrow" }, h("span", { class: "ph" }, "🗑"),
              h("span", { class: "meta" }, h("b", {}, t.name), h("span", { class: "muted small" }, `Deleted ${ago(t.deletedAt)} · removed for good on ${new Date(t.purgeAt).toLocaleDateString([], { month: "short", day: "numeric" })}`))),
            h("div", { class: "rowacts" },
              h("button", { class: "btn sm", onclick: () => restoreDeleted(t) }, "Restore"),
              h("button", { class: "btn sm ghost danger", onclick: () => purgeDeleted(t) }, "Delete forever")))))
      : null,
  );
}

async function setArchived(id, archived, then) {
  try {
    const p = await api("POST", `api/projects/${id}/archive`, { archived });
    if (P?.id === id) P = p;
    toast(archived ? `“${p.person.name || "Untitled"}” archived. Find it under Archived on the home page.` : `“${p.person.name || "Untitled"}” is back in your biopics.`);
    then?.();
  } catch (e) {
    toast(e.message, true);
  }
}

function deleteBiopic(x, then) {
  const name = x.name || x.person?.name || "Untitled";
  const films = x.counts?.films ?? x.films?.length ?? 0;
  const d = showDialog(`Delete “${name}”?`,
    h("p", {}, "This removes the biopic from your list, with its photos, documents, interview, scripts", films ? ` and ${films} rendered film${films > 1 ? "s" : ""}` : "", "."),
    h("p", { class: "muted small" }, "It goes to Recently deleted on the home page, where you can restore it for 30 days. If you only want it out of the way, Archive it instead."),
    h("div", { class: "row end" },
      h("button", { class: "btn", onclick: () => d.close() }, "Cancel"),
      x.archivedAt ? null : h("button", { class: "btn", onclick: () => { d.close(); setArchived(x.id, true, then); } }, "Archive instead"),
      h("button", { class: "btn primary danger-fill", onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          if (P?.id === x.id) { await flush(); }
          await api("DELETE", `api/projects/${x.id}`);
          try { localStorage.setItem("bp_recent", JSON.stringify(recent().filter((r) => r.id !== x.id))); } catch {}
          d.close();
          toast(`“${name}” moved to Recently deleted.`);
          if (P?.id === x.id) { P = null; location.hash = ""; } else then?.();
        } catch (er) { toast(er.message, true); e.currentTarget.disabled = false; }
      } }, "Delete")));
}

async function restoreDeleted(t) {
  try {
    await api("POST", `api/trash/${t.id}/restore`);
    toast(`“${t.name}” restored.`);
    renderHome();
  } catch (e) {
    toast(e.message, true);
  }
}

async function purgeDeleted(t) {
  if (!confirm(`Delete “${t.name}” forever? Its photos, scripts and films are erased and can't be recovered.`)) return;
  try {
    await api("DELETE", `api/trash/${t.id}`);
    toast(`“${t.name}” deleted forever.`);
    renderHome();
  } catch (e) {
    toast(e.message, true);
  }
}

async function newProject() {
  const name = $("#newName").value.trim();
  try {
    const p = await api("POST", "api/projects", { name });
    P = p;
    remember(P);
    location.hash = `p=${p.id}&s=person`;
  } catch (e) {
    toast(e.message, true);
  }
}

function showLogin() {
  main.replaceChildren(
    h("div", { class: "hero" }, h("h1", {}, "BioPicker"), h("p", {}, "This studio is private. Enter the passcode."),
      h("div", { class: "row", style: "justify-content:center" },
        h("input", { id: "pc", type: "password", placeholder: "Passcode", style: "max-width:260px" }),
        h("button", { class: "btn primary", onclick: async () => { await api("POST", "api/login", { passcode: $("#pc").value }).then(() => route()).catch((e) => toast(e.message, true)); } }, "Enter"))),
  );
}

// ---------- 1. person ----------
function field(label, key, opts = {}) {
  const el = opts.textarea
    ? h("textarea", { id: `f_${key}`, rows: opts.rows || 3, placeholder: opts.ph || "" })
    : opts.select
      ? h("select", { id: `f_${key}` }, ...opts.select.map(([v, l]) => h("option", { value: v }, l)))
      : h("input", { id: `f_${key}`, placeholder: opts.ph || "", type: opts.type || "text" });
  el.value = P.person[key] || "";
  el.addEventListener("input", () => patch({ person: { [key]: el.value } }));
  el.addEventListener("change", () => patch({ person: { [key]: el.value } }));
  return h("label", { class: "f" + (opts.full ? " full" : "") }, label, el);
}

function vPerson() {
  return h("section", {},
    h("h1", {}, "Who is this film about?"),
    h("p", { class: "lead" }, "The basics shape everything — the narrator we cast, the history we overlay and the questions the AI asks you."),
    aiWarn(),
    h("div", { class: "card grid2" },
      field("Full name", "name", { ph: "Rose María Alvarez" }),
      field("Goes by", "preferredName", { ph: "Grandma Rose" }),
      field("Pronouns for narration", "pronouns", { select: [["she/her", "she/her"], ["he/him", "he/him"], ["they/them", "they/them"]] }),
      field("Narration language", "language", { select: [["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"], ["hi", "Hindi"], ["zh", "Chinese"], ["ja", "Japanese"], ["ar", "Arabic"]] }),
      field("Date of birth", "born", { type: "date" }),
      field("Birthplace", "birthplace", { ph: "San Antonio, Texas, USA" }),
      field("Date of death (if applicable)", "died", { type: "date" }),
      field("Nationality / heritage", "nationality", { ph: "Mexican-American" }),
      field("Occupation(s)", "occupation", { ph: "Teacher, then school principal" }),
      field("Claim to fame", "claimToFame", { ph: "Founded the city's first bilingual school" }),
      field("Personality — a few words", "personality", { full: true, ph: "Stubborn, generous, terrible singer, never missed a birthday" }),
      field("Friends & family", "family", { full: true, textarea: true, ph: "Married Luis in 1968; three kids: Ana, Marco, Sofia; best friend June from nursing school…" }),
      field("Legacy — what they leave behind", "legacy", { full: true, textarea: true }),
      field("Anything else", "notes", { full: true, textarea: true }),
    ),
    nextBtn("media"),
  );
}

// ---------- 2. media ----------
function dropZone(label, accept, multiple, onFiles, id) {
  const input = h("input", { type: "file", accept, multiple, hidden: true, id });
  input.addEventListener("change", () => input.files.length && onFiles([...input.files]));
  const z = h("div", { class: "drop", tabindex: 0, role: "button", onclick: () => input.click(), onkeydown: (e) => (e.key === "Enter" || e.key === " ") && input.click() }, label, input);
  z.addEventListener("dragover", (e) => { e.preventDefault(); z.classList.add("over"); });
  z.addEventListener("dragleave", () => z.classList.remove("over"));
  z.addEventListener("drop", (e) => { e.preventDefault(); z.classList.remove("over"); onFiles([...e.dataTransfer.files]); });
  return z;
}

async function uploadFiles(url, field, files) {
  const chunks = [];
  for (let i = 0; i < files.length; i += 20) chunks.push(files.slice(i, i + 20));
  for (const [ci, c] of chunks.entries()) {
    toast(`Uploading ${Math.min((ci + 1) * 20, files.length)} of ${files.length}…`);
    const fd = new FormData();
    c.forEach((f) => fd.append(field, f));
    const r = await api("POST", url, fd, true);
    const proj = r.project || r;
    if (r.errors?.length) toast(r.errors.join("; "), true);
    P = proj;
  }
  render();
  watchJobs();
}

function vMedia() {
  const evOpts = [["", "— link to event —"], ...P.timeline.map((e) => [e.id, `${e.date || "?"} ${e.title}`])];
  const photoPatch = (id, obj) => {
    const ph = P.photos.find((x) => x.id === id);
    Object.assign(ph, obj);
    patch({ photos: [{ id, ...obj }] });
  };
  const dated = P.photos.filter((ph) => /^\d{4}/.test(ph.date || ""));
  return h("section", {},
    h("h1", {}, "Photos & documents"),
    h("p", { class: "lead" }, "Drop in photos (dates and GPS are read from their metadata) and documents — résumés, diplomas, obituaries, letters, articles (PDF, image or text). The AI reads them and suggests timeline events."),
    h("div", { class: "grid2" },
      dropZone("📷  Drop photos here or click to choose (JPEG, PNG, WebP, HEIC)", "image/*", true, (f) => uploadFiles(`api/projects/${P.id}/photos`, "photos", f).catch((e) => toast(e.message, true)), "photoInput"),
      dropZone("📄  Drop documents here (PDF, image scans, .txt)", ".pdf,.txt,.md,.csv,.json,.html,image/*", true, (f) => uploadFiles(`api/projects/${P.id}/documents`, "docs", f).catch((e) => toast(e.message, true)), "docInput"),
    ),
    P.documents.length
      ? h("div", { class: "card", style: "margin-top:16px" },
          h("h2", {}, "Documents"),
          ...P.documents.map((d) =>
            h("div", { style: "border-top:1px solid var(--line);padding:10px 0" },
              h("div", { class: "row" }, h("b", {}, d.name), h("span", { class: "tag" + (d.status === "done" ? " ok" : "") }, d.status), h("span", { class: "spacer" }),
                h("a", { href: fileUrl("docs", d.file), target: "_blank", class: "small" }, "open"),
                h("button", { class: "btn sm danger", onclick: async () => { P = await api("DELETE", `api/projects/${P.id}/documents/${d.id}`); render(); } }, "Remove")),
              d.summary ? h("p", { class: "muted small" }, d.summary) : null,
              d.events?.length
                ? h("div", {},
                    h("div", { class: "row small" }, h("span", { class: "muted" }, `${d.events.length} suggested events`),
                      h("button", { class: "btn sm", onclick: () => addEvents(d.events) }, "Add all to timeline")),
                    h("ul", { class: "small" }, ...d.events.map((e) => h("li", {}, `${e.date} — ${e.title}${e.place ? " @ " + e.place : ""} `,
                      h("button", { class: "btn sm ghost", onclick: () => addEvents([e]) }, "+ add")))))
                : null,
            ),
          ))
      : null,
    P.photos.length
      ? h("div", { style: "margin-top:18px" },
          h("div", { class: "row" }, h("h2", {}, `Photos (${P.photos.length})`), h("span", { class: "spacer" }),
            dated.length ? h("button", { class: "btn sm", onclick: () => photosToEvents() }, "Suggest timeline events from photo dates") : null),
          h("div", { class: "photos" },
            ...P.photos.map((ph) =>
              h("div", { class: "ph" + (ph.include === false ? " off" : "") },
                h("img", { src: fileUrl("thumbs", ph.file), alt: ph.caption || ph.originalName, loading: "lazy" }),
                h("div", { class: "b" },
                  h("div", { class: "row small" },
                    ph.exif?.date ? h("span", { class: "tag ok", title: "Date from photo metadata" }, "EXIF date") : null,
                    ph.exif?.lat != null ? h("span", { class: "tag ok", title: "GPS from photo metadata" }, "GPS") : null,
                    ph.ai ? h("span", { class: "tag", title: ph.ai.description }, "AI ✓") : h("span", { class: "tag" }, "…"),
                  ),
                  h("input", { value: ph.caption || "", placeholder: "Caption", oninput: (e) => photoPatch(ph.id, { caption: e.target.value }) }),
                  h("div", { class: "row", style: "flex-wrap:nowrap" },
                    h("input", { value: ph.date || "", placeholder: ph.ai?.estimatedYearRange || "Date / year", oninput: (e) => photoPatch(ph.id, { date: e.target.value }) }),
                    h("input", { value: ph.place || "", placeholder: "Place", oninput: (e) => photoPatch(ph.id, { place: e.target.value }) })),
                  h("select", { onchange: (e) => photoPatch(ph.id, { eventId: e.target.value || null }) },
                    ...evOpts.map(([v, l]) => h("option", { value: v, selected: (ph.eventId || "") === v }, l))),
                  ph.ai ? h("div", { class: "ai" }, ph.ai.description) : null,
                  h("div", { class: "row" },
                    h("label", { class: "small muted row" }, h("input", { type: "checkbox", checked: ph.include !== false, onchange: (e) => { photoPatch(ph.id, { include: e.target.checked }); render(); } }), "use in film"),
                    h("span", { class: "spacer" }),
                    h("button", { class: "btn sm danger", onclick: async () => { P = await api("DELETE", `api/projects/${P.id}/photos/${ph.id}`); render(); } }, "Delete")),
                ),
              ),
            ),
          ))
      : null,
    h("div", { style: "height:14px" }),
    nextBtn("timeline"),
  );
}

function addEvents(evts) {
  const tl = [...P.timeline];
  for (const e of evts) {
    if (tl.some((x) => x.date === e.date && x.title === e.title)) continue;
    tl.push({ id: undefined, date: e.date, type: TYPES.includes(e.type) ? e.type : "other", title: e.title, place: e.place || "", description: e.description || "" });
  }
  patch({ timeline: tl }, 0).then(() => { toast(`${evts.length} event(s) added to the timeline`); render(); });
}

function photosToEvents() {
  const byYear = {};
  for (const ph of P.photos) {
    const y = String(ph.date || "").slice(0, 4);
    if (!/^\d{4}$/.test(y)) continue;
    (byYear[y] ||= []).push(ph);
  }
  const evts = Object.entries(byYear)
    .filter(([y]) => !P.timeline.some((e) => String(e.date).startsWith(y)))
    .map(([y, phs]) => ({ date: phs[0].date, type: "other", title: phs[0].caption || `Photos from ${y}`, place: phs.find((p) => p.place)?.place || "", description: phs.map((p) => p.ai?.description).filter(Boolean).slice(0, 2).join(" ") }));
  if (!evts.length) return toast("Every photo year already has an event.");
  addEvents(evts);
}

// ---------- 3. timeline ----------
function vTimeline() {
  const tl = P.timeline.map((e) => ({ ...e }));
  const save = () => patch({ timeline: tl }, 900);
  const quick = [
    ["birth", "Born", P.person.born, P.person.birthplace],
    ["graduation", "Graduated from high school", "", ""],
    ["college", "Went to college", "", ""],
    ["job", "First job", "", ""],
    ["fame", P.person.claimToFame || "Claim to fame", "", ""],
    ["marriage", "Married", "", ""],
  ];
  const addRow = (type, title, date, place) => {
    tl.push({ date: date || "", type, title, place: place || "", description: "" });
    patch({ timeline: tl }, 0).then(() => render());
  };
  return h("section", {},
    h("h1", {}, "Timeline & places"),
    h("p", { class: "lead" }, "Key dates and where they happened. Places are placed on a map in the film; dates anchor the history overlay. Use YYYY, YYYY-MM or YYYY-MM-DD."),
    h("div", { class: "row", style: "margin-bottom:12px" }, h("span", { class: "muted small" }, "Quick add:"),
      ...quick.filter(([t]) => !tl.some((e) => e.type === t)).map(([t, title, d, pl]) => h("button", { class: "btn sm", onclick: () => addRow(t, title, d, pl) }, "+ " + title)),
      h("button", { class: "btn sm primary", onclick: () => addRow("other", "", "", "") }, "+ Event")),
    h("div", { class: "tl" },
      ...(tl.length ? tl : []).map((e, i) =>
        h("div", { class: "ev" },
          h("input", { value: e.date, placeholder: "1969-07-20", "aria-label": "Date", oninput: (x) => { e.date = x.target.value; save(); } }),
          h("select", { "aria-label": "Type", onchange: (x) => { e.type = x.target.value; save(); } }, ...TYPES.map((t) => h("option", { value: t, selected: e.type === t }, t))),
          h("input", { value: e.title, placeholder: "What happened", "aria-label": "Title", oninput: (x) => { e.title = x.target.value; save(); } }),
          h("input", { value: e.place, placeholder: "City, Region, Country" + (e.lat != null ? "" : ""), "aria-label": "Place", title: e.lat != null ? `📍 ${e.lat.toFixed(3)}, ${e.lon.toFixed(3)}` : "", oninput: (x) => { e.place = x.target.value; save(); } }),
          h("button", { class: "btn sm danger x", title: "Remove", "aria-label": "Remove event", onclick: () => { tl.splice(i, 1); patch({ timeline: tl }, 0).then(() => render()); } }, "✕"),
          h("textarea", { placeholder: "Details, people involved, a memory…", oninput: (x) => { e.description = x.target.value; save(); } }, e.description || ""),
        ),
      ),
      tl.length ? null : h("div", { class: "card muted" }, "No events yet — use Quick add, or add suggestions from your documents and photos."),
    ),
    h("div", { style: "height:14px" }),
    nextBtn("interview"),
  );
}

// ---------- 4. interview ----------
function vInterview() {
  const ask = async (btn) => {
    btn.disabled = true;
    btn.textContent = "Thinking of good questions…";
    try {
      await flush();
      P = await api("POST", `api/projects/${P.id}/interview/next`);
      render();
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
    }
  };
  return h("section", {},
    h("h1", {}, "The AI interview"),
    h("p", { class: "lead" }, "A documentary producer's questions about personality, fame, friends & family and legacy — tailored to what you've shared so far. Answer what you can; skip the rest. Every answer makes the film more personal."),
    aiWarn(),
    ...P.interview.map((q) =>
      h("div", { class: "qa" },
        h("div", { class: "row" }, h("span", { class: "tag" }, q.category), h("span", { class: "spacer" }),
          h("button", { class: "btn sm ghost", title: "Remove question", onclick: () => { P.interview = P.interview.filter((x) => x !== q); patch({ interview: P.interview.map(({ id, answer }) => ({ id, answer })) }, 0).then(render); } }, "✕")),
        h("div", { class: "q" }, q.question),
        h("div", { class: "why" }, q.why),
        h("textarea", { rows: 3, placeholder: "Your answer…", oninput: (e) => { q.answer = e.target.value; patch({ interview: P.interview.map(({ id, answer }) => ({ id, answer })) }, 900); } }, q.answer || ""),
      ),
    ),
    h("div", { class: "row" },
      h("button", { class: "btn primary", disabled: !health.ai, onclick: (e) => ask(e.currentTarget) }, P.interview.length ? "Ask me more questions" : "Start the interview"),
      h("span", { class: "spacer" }),
      h("button", { class: "btn", onclick: async () => { await flush(); go("history"); } }, "Continue →")),
  );
}

// ---------- 5. history ----------
function vHistory() {
  const c = P.context;
  const byId = Object.fromEntries(P.timeline.map((e) => [e.id, e]));
  return h("section", {},
    h("h1", {}, "History overlay"),
    h("p", { class: "lead" }, "What was happening in the world — and down the street — at each moment of this life, the cultural shifts of the time, and how they may have shaped the person. These become 'Meanwhile…' scenes with public-domain newsreels and art."),
    aiWarn(),
    h("div", { class: "row", style: "margin-bottom:14px" },
      h("button", { class: "btn primary", disabled: !health.ai || !P.timeline.length, onclick: async () => { await flush(); try { const j = await api("POST", `api/projects/${P.id}/context`); watchJob(j); updateJobUI(j); } catch (e) { toast(e.message, true); } } },
        c ? "Research again" : "Research the history"),
      P.timeline.length ? null : h("span", { class: "muted small" }, "Add timeline events first."),
      c ? h("span", { class: "muted small" }, "AI-researched — double-check anything you'll publish.") : null),
    c
      ? h("div", { class: "hist" },
          h("div", { class: "card" }, h("h3", {}, "The arc of history"), h("p", {}, c.eraOverview)),
          ...c.moments.map((m) =>
            h("div", { class: "m" },
              h("h3", {}, `${m.year} · ${byId[m.eventId]?.title || ""}`),
              h("div", { class: "grid2" },
                h("div", {}, h("b", { class: "small" }, "WORLD"), h("ul", {}, ...m.world.map((w) => h("li", {}, h("b", {}, w.title), " — ", w.description)))),
                h("div", {}, h("b", { class: "small" }, "LOCAL / NATIONAL"), h("ul", {}, ...(m.local.length ? m.local : [{ title: "—", description: "" }]).map((w) => h("li", {}, h("b", {}, w.title), w.description ? " — " + w.description : ""))))),
              h("p", { class: "small" }, h("b", {}, "Cultural shift: "), m.culturalShift),
              h("p", { class: "inf" }, m.influence),
              h("div", { class: "small muted" }, m.archivalQuery ? `🎞 footage: “${m.archivalQuery}”  ` : "", m.artQuery ? `🖼 art: “${m.artQuery}”` : ""),
            ),
          ))
      : null,
    h("div", { style: "height:14px" }),
    nextBtn("style"),
  );
}

// ---------- 6. style & voice ----------
function vStyle() {
  const s = P.settings;
  const set = (obj, now) => { Object.assign(P.settings, obj); return patch({ settings: obj }, now ? 0 : 500); };
  const tones = [
    ["serious", "Serious", "A dignified, cinematic documentary portrait."],
    ["humorous", "Humorous", "Affectionate and witty — a loving roast with great timing."],
    ["teachable", "Teachable", "A history lesson: context, choices and takeaways for students."],
  ];
  const voiceBox = h("div", {});
  const drawVoices = () => {
    if (!voices) {
      voiceBox.replaceChildren(h("span", { class: "muted" }, "Loading voices…"));
      return;
    }
    const lang = (P.person.language || "en").slice(0, 2);
    const filter = $("#vfilter")?.value ?? "lang";
    const list = voices.filter((v) => filter === "all" || v.locale.toLowerCase().startsWith(lang) || v.provider !== "edge");
    const cur = s.voice || {};
    const sel = h("select", { id: "voiceSel", onchange: (e) => { const v = voices.find((x) => x.id === e.target.value); set({ voice: { provider: v.provider, id: v.id, label: v.label, rate: cur.rate || 0, pitch: cur.pitch || 0 } }, true); } },
      h("option", { value: "" }, "— choose a narrator —"),
      ...list.map((v) => h("option", { value: v.id, selected: v.id === cur.id }, `${v.label} · ${v.gender} · ${v.locale}${v.personality ? " · " + v.personality : ""}`)));
    const rate = h("input", { type: "range", min: -30, max: 30, value: cur.rate || 0, oninput: (e) => { rl.textContent = `${e.target.value}%`; }, onchange: (e) => set({ voice: { ...P.settings.voice, rate: +e.target.value } }, true) });
    const pitch = h("input", { type: "range", min: -20, max: 20, value: cur.pitch || 0, oninput: (e) => { pl.textContent = `${e.target.value}%`; }, onchange: (e) => set({ voice: { ...P.settings.voice, pitch: +e.target.value } }, true) });
    const rl = h("span", { class: "muted small" }, `${cur.rate || 0}%`);
    const pl = h("span", { class: "muted small" }, `${cur.pitch || 0}%`);
    voiceBox.replaceChildren(
      h("div", { class: "grid2" },
        h("label", { class: "f full" }, "Narrator voice", sel),
        h("label", { class: "f" }, h("span", {}, "Pace ", rl), rate),
        h("label", { class: "f" }, h("span", {}, "Pitch ", pl), pitch),
        h("label", { class: "f" }, "Show", h("select", { id: "vfilter", onchange: drawVoices }, h("option", { value: "lang", selected: filter === "lang" }, "Voices for the narration language"), h("option", { value: "all", selected: filter === "all" }, "All voices (300+)"))),
        h("label", { class: "f" }, "Preview line", h("input", { id: "pvText", value: `This is the story of ${P.person.preferredName || P.person.name || "a remarkable life"}.` })),
      ),
      h("div", { class: "row", style: "margin-top:10px" },
        h("button", { class: "btn", disabled: !s.voice?.id, onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true;
          try { const blob = await api("POST", "api/tts/preview", { voice: P.settings.voice, text: $("#pvText").value }); const a = new Audio(URL.createObjectURL(blob)); a.play(); } catch (er) { toast(er.message, true); }
          b.disabled = false;
        } }, "▶ Preview voice"),
        h("button", { class: "btn primary", disabled: !health.ai, onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true; b.textContent = "Casting…";
          try { await flush(); P = await api("POST", `api/projects/${P.id}/voice/cast`); render(); toast(`Cast: ${P.settings.voice.label}`); } catch (er) { toast(er.message, true); b.disabled = false; }
        } }, "✨ Let AI cast the narrator")),
      s.voiceRationale ? h("p", { class: "inf small", style: "margin-top:10px" }, s.voiceRationale) : null,
    );
  };
  if (!voices) api("GET", "api/voices").then((v) => { voices = v; drawVoices(); }).catch((e) => toast(e.message, true));
  drawVoices();

  const musicUp = h("div", {});
  const drawMusic = () =>
    musicUp.replaceChildren(
      s.music === "upload"
        ? h("div", {},
            dropZone("🎵 Drop your own music (mp3, wav, ogg, m4a) — make sure you have the rights", "audio/*", true, (f) => uploadFiles(`api/projects/${P.id}/music`, "music", f).catch((e) => toast(e.message, true)), "musicInput"),
            ...P.uploadedMusic.map((m) => h("div", { class: "row small", style: "margin-top:6px" }, "🎵 ", m.name, h("span", { class: "spacer" }), h("button", { class: "btn sm danger", onclick: async () => { P = await api("DELETE", `api/projects/${P.id}/music/${m.id}`); render(); } }, "Remove"))))
        : null,
    );
  drawMusic();

  return h("section", {},
    h("h1", {}, "Style, length & voice"),
    h("h2", {}, "Tone"),
    h("div", { class: "tones", style: "margin-bottom:18px" },
      ...tones.map(([k, t, d]) => h("div", { class: "tone" + (s.tone === k ? " on" : ""), tabindex: 0, role: "radio", "aria-checked": s.tone === k, onclick: () => { set({ tone: k }, true); render(); }, onkeydown: (e) => e.key === "Enter" && (set({ tone: k }, true), render()) }, h("div", { class: "t" }, t), h("div", { class: "d" }, d)))),
    h("div", { class: "card grid3" },
      h("label", { class: "f" }, "Short version (seconds)", h("input", { type: "number", min: 30, max: 300, value: s.shortSeconds, onchange: (e) => set({ shortSeconds: +e.target.value }) })),
      h("label", { class: "f" }, "Long version (seconds)", h("input", { type: "number", min: 120, max: 1800, value: s.longSeconds, onchange: (e) => set({ longSeconds: +e.target.value }) })),
      h("label", { class: "f" }, "Video quality", h("select", { onchange: (e) => set({ quality: e.target.value }) }, ...["480p", "720p", "1080p"].map((q) => h("option", { value: q, selected: s.quality === q }, q)))),
      h("label", { class: "f" }, "Music", h("select", { onchange: (e) => { set({ music: e.target.value }, true); s.music = e.target.value; drawMusic(); } },
        ...[["auto", "Public-domain classics (auto-picked)"], ["generated", "Original ambient score"], ["upload", "My own music"], ["none", "No music"]].map(([v, l]) => h("option", { value: v, selected: s.music === v }, l)))),
      h("label", { class: "f" }, "Archival newsreels", h("select", { onchange: (e) => set({ includeArchival: e.target.value === "1" }) }, h("option", { value: "1", selected: s.includeArchival }, "Include public-domain footage"), h("option", { value: "0", selected: !s.includeArchival }, "Don't include"))),
      h("label", { class: "f" }, "Public-domain art", h("select", { onchange: (e) => set({ includeArt: e.target.value === "1" }) }, h("option", { value: "1", selected: s.includeArt }, "Include paintings & prints"), h("option", { value: "0", selected: !s.includeArt }, "Don't include"))),
      h("label", { class: "f" }, "Captions", h("select", { onchange: (e) => set({ burnCaptions: e.target.value === "1" }) }, h("option", { value: "0", selected: !s.burnCaptions }, "Separate .srt file only"), h("option", { value: "1", selected: s.burnCaptions }, "Burn into the video too"))),
    ),
    musicUp,
    h("h2", { style: "margin-top:18px" }, "Documentary series"),
    h("div", { class: "card" },
      h("p", { class: "muted small", style: "margin-top:0" }, "Besides the short and long films, BioPicker can make a multi-episode documentary: the AI splits the life into episodes (childhood, education, career…) and each episode becomes its own film. Plan it on the Script step."),
      h("div", { class: "grid3" },
        h("label", { class: "f" }, "Number of episodes", h("select", { onchange: (e) => set({ episodeCount: +e.target.value }) },
          h("option", { value: 0, selected: !s.episodeCount }, "Let the AI decide (2–8)"),
          ...Array.from({ length: 11 }, (_, i) => i + 2).map((n) => h("option", { value: n, selected: s.episodeCount === n }, `${n} episodes`)))),
        h("label", { class: "f" }, "Minutes per episode", h("input", { type: "number", min: 3, max: 30, value: Math.round((s.episodeSeconds || 600) / 60), onchange: (e) => set({ episodeSeconds: Math.max(3, Math.min(30, +e.target.value || 10)) * 60 }) })))),
    h("h2", { style: "margin-top:18px" }, "Narrator"),
    h("div", { class: "card" }, voiceBox),
    nextBtn("script"),
  );
}

// ---------- 7. script ----------
const VIS_TYPES = ["photo", "map", "archival", "still", "art", "card"];
function thumbFor(v) {
  const a = v.asset;
  if (a?.kind === "photo") {
    const ph = P.photos.find((x) => x.id === a.photoId);
    return ph ? h("img", { class: "th", src: fileUrl("thumbs", ph.file), alt: "" }) : h("div", { class: "th" }, "photo");
  }
  if (a?.kind === "image") return h("img", { class: "th", src: fileUrl("media", a.file), alt: "", loading: "lazy" });
  if (a?.kind === "video") return h("video", { class: "th", src: fileUrl("media", a.file), muted: true, preload: "metadata", onmouseenter: (e) => e.target.play(), onmouseleave: (e) => e.target.pause() });
  if (a?.kind === "map") return h("div", { class: "th" }, "🗺 " + (a.label || ""));
  return h("div", { class: "th" }, { card: "🅣 title card", archival: "🎞 not found yet", still: "📷 not found yet", art: "🖼 not found yet", photo: "📷", map: "🗺" }[v.type] || v.type);
}

const vLabel = (v) => (v === "short" ? "Short version" : v === "long" ? "Long version" : `Episode ${v.slice(2)}`);
const episodes = () => P.series?.episodes || [];
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

function scriptTabs() {
  const tab = (v, label) => h("button", { class: scriptTab === v ? "on" : "", onclick: () => { scriptTab = v; render(); } }, label, P.scripts[v] ? " ✓" : "");
  return h("div", { class: "tabs" },
    tab("short", `Short · ${P.settings.shortSeconds}s`),
    tab("long", `Long · ${Math.round(P.settings.longSeconds / 60)} min`),
    h("span", { class: "sep" }),
    h("button", { class: scriptTab === "series" ? "on" : "", onclick: () => { scriptTab = "series"; render(); } }, "📺 Series plan"),
    ...episodes().map((e) => tab(`ep${e.n}`, `Ep ${e.n}`)));
}

function seriesView() {
  const eps = episodes();
  const jobs = P.jobs || [];
  const planning = jobs.some((j) => j.type === "series");
  const writing = jobs.some((j) => j.type === "script");
  const mins = Math.round(P.settings.episodeSeconds / 60);
  const sid = P.id;
  const body = () => ({ title: P.series?.title || "", episodes: episodes().map(({ title, logline, from, to }) => ({ title, logline, from, to })) });
  const put = () => api("PUT", `api/projects/${sid}/series`, body()).then((p) => { if (P?.id === sid) P = p; });
  const saveSoon = () => defer("series", put, () => fetch(`api/projects/${sid}/series`, { method: "PUT", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()) }));
  const saveNowAndRender = async () => { deferred.delete("series"); await tracked(put).catch((e) => toast(e.message, true)); render(); };
  const startJobBtn = async (url, b) => { try { await flush(); const r = await api("POST", url, b); for (const j of [].concat(r)) { updateJobUI(j); watchJob(j); } P.jobs = [...(P.jobs || []), ...[].concat(r)]; render(); } catch (e) { toast(e.message, true); } };
  const plan = () => {
    if (eps.some((e) => P.scripts[`ep${e.n}`]) && !confirm("Re-planning replaces the episode list. Episode scripts already written are kept, but may no longer match. Continue?")) return;
    startJobBtn(`api/projects/${P.id}/series/plan`);
  };
  const missing = eps.filter((e) => !P.scripts[`ep${e.n}`]).length;
  const unrendered = eps.filter((e) => P.scripts[`ep${e.n}`] && !P.renders[`ep${e.n}`]).length;
  return h("section", {},
    h("h1", {}, "Script & media"),
    h("p", { class: "lead" }, `A documentary series tells the life in episodes of about ${mins} minutes. The AI proposes the episodes; rename them, reword what each covers, then write and render each one as its own film.`),
    aiWarn(),
    scriptTabs(),
    h("div", { class: "card" },
      h("div", { class: "row" },
        h("button", { class: "btn primary", disabled: planning || !health.ai, onclick: plan }, planning ? "Planning…" : eps.length ? "Re-plan the series with AI" : "✨ Plan the series with AI"),
        h("span", { class: "muted small" }, `${P.settings.episodeCount ? P.settings.episodeCount + " episodes" : "AI picks the number of episodes"} · ~${mins} min each · `, h("a", { href: "#", onclick: (e) => { e.preventDefault(); go("style"); } }, "change")),
        h("span", { class: "spacer" }))),
    eps.length
      ? h("div", {},
          h("div", { class: "card" }, h("label", { class: "f" }, "Series title", h("input", { value: P.series.title || "", oninput: (e) => { P.series.title = e.target.value; saveSoon(); } }))),
          h("div", { class: "eps" }, ...eps.map((e) => {
            const v = `ep${e.n}`;
            const s = P.scripts[v];
            const r = P.renders[v];
            return h("div", { class: "ep" },
              h("div", { class: "num" }, e.n),
              h("div", { class: "body" },
                h("input", { value: e.title, placeholder: "Episode title", oninput: (ev) => { e.title = ev.target.value; saveSoon(); } }),
                h("textarea", { rows: 2, placeholder: "What this episode covers", oninput: (ev) => { e.logline = ev.target.value; saveSoon(); } }, e.logline || ""),
                h("span", { class: "muted small" }, [e.from && `${e.from}${e.to && e.to !== e.from ? "–" + e.to : ""}`, s ? `script ✓ (${s.scenes.length} scenes)` : "no script yet", r ? `rendered v${r.n} · ${fmtDur(r.seconds)}` : null].filter(Boolean).join(" · "))),
              h("div", { class: "acts" },
                h("button", { class: "btn sm", onclick: () => { scriptTab = v; render(); } }, s ? "Edit script" : "Open"),
                r ? h("button", { class: "btn sm", onclick: () => go("render") }, "▶ Watch") : null));
          })),
          h("div", { class: "row", style: "margin-top:12px" },
            h("button", { class: "btn sm", disabled: eps.length >= 20, onclick: () => { P.series.episodes.push({ n: eps.length + 1, title: `Episode ${eps.length + 1}`, logline: "", from: "", to: "", eventIds: [] }); saveNowAndRender(); } }, "+ Add episode"),
            h("button", { class: "btn sm ghost", disabled: eps.length <= 1, onclick: () => { const last = eps.at(-1); if (!confirm(`Remove episode ${last.n} "${last.title}"${P.scripts[`ep${last.n}`] ? " and its script" : ""}? Films already rendered are kept.`)) return; P.series.episodes.pop(); saveNowAndRender(); } }, "Remove last episode"),
            h("span", { class: "spacer" }),
            h("button", { class: "btn", disabled: writing || !missing || !health.ai, onclick: () => startJobBtn(`api/projects/${P.id}/series/write-all`) }, writing ? "Writing…" : missing ? `Write ${missing} missing script${missing > 1 ? "s" : ""}` : "All scripts written"),
            h("button", { class: "btn primary", disabled: !unrendered, onclick: async () => { await startJobBtn(`api/projects/${P.id}/series/render-all`); go("render"); } }, unrendered ? `Render ${unrendered} episode${unrendered > 1 ? "s" : ""} →` : "Render →")))
      : h("div", { class: "card muted" }, planning ? "Planning the episodes…" : "No series planned yet."),
  );
}

function vScript() {
  if (scriptTab === "series" || (scriptTab.startsWith("ep") && !episodes().some((e) => `ep${e.n}` === scriptTab))) {
    scriptTab = "series";
    return seriesView();
  }
  const s = P.scripts[scriptTab];
  const ep = episodes().find((e) => `ep${e.n}` === scriptTab);
  const busy = (P.jobs || []).some((j) => ["script", "media"].includes(j.type) && (!j.version || j.version === scriptTab));
  const sid = P.id;
  const tab = scriptTab;
  const url = `api/projects/${sid}/scripts/${tab}`;
  const body = () => ({ title: s.title, tagline: s.tagline, scenes: s.scenes.map((sc) => ({ ...sc, visuals: sc.visuals.map((v, i) => ({ type: v.type, ref: v.ref, caption: v.caption, i })) })) });
  const put = () => api("PUT", url, body()).then((p) => { if (P?.id === sid) P = p; });
  const save = (now) => { deferred.delete(`script:${tab}`); return tracked(put).then(() => { if (now && P?.id === sid) render(); }).catch((e) => toast(`Not saved: ${e.message}`, true)); };
  const saveSoon = () => defer(`script:${tab}`, put, () => fetch(url, { method: "PUT", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()) }));
  const write = async () => {
    await flush();
    try {
      const j = await api("POST", `api/projects/${P.id}/scripts/${scriptTab}`);
      updateJobUI(j);
      watchJob(j);
    } catch (e) { toast(e.message, true); }
  };
  const words = s ? s.scenes.reduce((a, sc) => a + (sc.narration || "").split(/\s+/).filter(Boolean).length, 0) : 0;
  return h("section", {},
    h("h1", {}, "Script & media"),
    h("p", { class: "lead" }, "Claude writes the narration and picks the pictures: your photos, maps of each place, and public-domain newsreels, historic photos and art. Edit any line, swap any clip, then render."),
    aiWarn(),
    scriptTabs(),
    ep ? h("div", { class: "card" }, h("b", {}, `Episode ${ep.n}: ${ep.title}`), ep.from ? h("span", { class: "muted small" }, `  ·  ${ep.from}${ep.to && ep.to !== ep.from ? "–" + ep.to : ""}`) : null, h("div", { class: "muted small" }, ep.logline)) : null,
    s && P.renders[scriptTab] ? h("p", { class: "small muted" }, `Already rendered as v${P.renders[scriptTab].n}. Edit freely: the next render is saved as v${P.renders[scriptTab].n + 1} and earlier versions are kept.`) : null,
    h("div", { class: "row", style: "margin-bottom:14px" },
      h("button", { class: "btn primary", disabled: busy || !health.ai, onclick: () => { if (s && !confirm(`Rewrite the whole ${vLabel(scriptTab)} script with AI? Your edits to it will be replaced (rendered films keep their own copy of the script).`)) return; write(); } }, s ? "Rewrite script" : `Write the ${vLabel(scriptTab).toLowerCase()} script`),
      s ? h("button", { class: "btn", disabled: busy, onclick: async () => { const j = await api("POST", `api/projects/${P.id}/scripts/${scriptTab}/media`); updateJobUI(j); watchJob(j); } }, "Re-find media") : null,
      s ? h("span", { class: "muted small" }, `${s.scenes.length} scenes · ${words} words ≈ ${Math.round(words / 2.4)}s narration · tone: ${s.tone}${s.mediaResolvedAt ? "" : " · media needs refresh"}`) : null,
      h("span", { class: "spacer" }),
      s ? h("button", { class: "btn", onclick: () => go("render") }, "Render →") : null),
    s
      ? h("div", {},
          h("div", { class: "card grid2" },
            h("label", { class: "f" }, "Film title", h("input", { value: s.title, oninput: (e) => { s.title = e.target.value; saveSoon(); } })),
            h("label", { class: "f" }, "Tagline", h("input", { value: s.tagline, oninput: (e) => { s.tagline = e.target.value; saveSoon(); } })),
            h("div", { class: "full small muted", style: "grid-column:1/-1" }, `Score: ${s.musicMood || ""}`,
              ...(s.music || []).map((m) => h("div", {}, "🎵 ", m.pageUrl ? h("a", { href: m.pageUrl, target: "_blank", rel: "noopener" }, m.title) : m.title, ` — ${m.source} (${m.license})`)),
              P.settings.music !== "none" && !(s.music || []).length ? h("div", {}, "🎵 Original ambient score will be generated") : null)),
          ...s.scenes.map((sc, i) =>
            h("div", { class: "scene" },
              h("div", { class: "hd" },
                h("b", {}, `${i + 1}.`), h("span", { class: "tag" }, sc.kind),
                h("input", { value: sc.onScreenTitle, placeholder: "On-screen title", oninput: (e) => { sc.onScreenTitle = e.target.value; saveSoon(); } }),
                h("input", { value: sc.onScreenSubtitle, placeholder: "Subtitle", oninput: (e) => { sc.onScreenSubtitle = e.target.value; saveSoon(); } }),
                h("button", { class: "btn sm danger", title: "Delete scene", onclick: () => { s.scenes.splice(i, 1); save(true); } }, "✕")),
              h("textarea", { rows: 2, oninput: (e) => { sc.narration = e.target.value; saveSoon(); } }, sc.narration),
              h("div", { class: "vis" },
                ...sc.visuals.map((v, vi) =>
                  h("div", { class: "vi" },
                    thumbFor(v),
                    h("div", { class: "cap" }, h("b", {}, v.type), " ", v.asset?.title ? `${v.asset.title.slice(0, 50)} · ${v.asset.source}` : v.ref),
                    h("div", { class: "act" },
                      v.candidates?.length > 1 ? h("button", { class: "btn sm", title: "Try the next search result", onclick: async (e) => { e.currentTarget.disabled = true; e.currentTarget.textContent = "…"; try { P = await api("POST", `api/projects/${P.id}/scripts/${scriptTab}/scenes/${sc.id}/visuals/${vi}/next`); render(); } catch (er) { toast(er.message, true); } } }, "↻ swap") : null,
                      h("button", { class: "btn sm danger", onclick: () => { sc.visuals.splice(vi, 1); save(true); } }, "✕")),
                  )),
                h("div", { class: "vi", style: "padding:8px;display:flex;flex-direction:column;gap:6px" },
                  h("select", { id: `nvT${i}` }, ...VIS_TYPES.map((t) => h("option", { value: t }, t))),
                  h("select", { id: `nvP${i}` }, h("option", { value: "" }, "(photo…)"), ...P.photos.filter((p) => p.include !== false).map((p) => h("option", { value: p.id }, (p.caption || p.originalName).slice(0, 40)))),
                  h("input", { id: `nvR${i}`, placeholder: "search phrase / place / text" }),
                  h("button", { class: "btn sm", onclick: () => {
                    const type = $(`#nvT${i}`).value;
                    const ref = type === "photo" ? $(`#nvP${i}`).value : $(`#nvR${i}`).value.trim();
                    if (!ref) return toast("Pick a photo or type a phrase", true);
                    sc.visuals.push({ type, ref, caption: "" });
                    save(true);
                  } }, "+ add visual")),
              ),
            ),
          ),
          h("div", { class: "row" }, h("button", { class: "btn sm", onclick: () => { s.scenes.push({ kind: "life", narration: "", onScreenTitle: "", onScreenSubtitle: "", year: "", place: "", transition: "fade", visuals: [{ type: "card", ref: "New scene", caption: "" }] }); save(true); } }, "+ Add scene at the end")),
          h("p", { class: "muted small" }, "Added or changed visuals are looked up when you click “Re-find media” (or automatically at render time)."),
        )
      : h("div", { class: "card muted" }, busy ? "Writing…" : "No script yet for this version."),
  );
}

// ---------- 8. render ----------
const playing = {}; // version -> film id shown in that version's player
function vRender() {
  const jobs = P.jobs || [];
  const running = jobs.find((j) => j.type === "render" && j.status === "running");
  const queuedFor = (v) => jobs.find((j) => j.type === "render" && j.version === v);
  const startRender = async (v) => {
    try {
      await flush();
      const j = await api("POST", `api/projects/${P.id}/render/${v}`);
      updateJobUI(j);
      P.jobs = [...(P.jobs || []), j];
      render();
      watchJob(j);
    } catch (e) { toast(e.message, true); }
  };
  const act = async (fn, msg) => { try { P = await fn(); render(); if (msg) toast(msg); } catch (e) { toast(e.message, true); } };

  const filmCard = (v) => {
    const s = P.scripts[v];
    const films = P.films.filter((f) => f.version === v).sort((a, b) => b.n - a.n);
    const cur = films.find((f) => f.id === playing[v]) || films[0];
    const q = queuedFor(v);
    const ep = episodes().find((e) => `ep${e.n}` === v);
    const changedAt = s?.updatedAt || s?.createdAt;
    const edited = s && cur && changedAt && new Date(changedAt) > new Date(cur.at);
    return h("div", { class: "card" },
      h("div", { class: "row" },
        h("h2", { style: "margin:0" }, vLabel(v), ep ? h("span", { class: "muted", style: "font-weight:400" }, `: ${ep.title}`) : !ep && s?.title ? h("span", { class: "muted", style: "font-weight:400" }, `: ${s.title}`) : null),
        h("span", { class: "spacer" }),
        s ? h("button", { class: "btn", onclick: () => { scriptTab = v; go("script"); } }, "✎ Edit script") : null,
        s ? h("button", { class: "btn primary", disabled: !!q, onclick: () => startRender(v) }, q ? (q.status === "queued" ? "Queued…" : "Rendering…") : films.length ? `Render v${films[0].n + 1}` : "Render")
          : h("button", { class: "btn", onclick: () => { scriptTab = v; go("script"); } }, "Write this script first")),
      cur
        ? h("div", { style: "margin-top:12px" },
            h("video", { controls: true, preload: "metadata", src: fileUrl("output", cur.file) + `?t=${encodeURIComponent(cur.at)}` },
              cur.vtt ? h("track", { kind: "captions", src: fileUrl("output", cur.vtt), srclang: P.person.language || "en", label: "Captions" }) : null),
            h("div", { class: "row", style: "margin-top:8px" },
              h("b", {}, `v${cur.n}${cur.label ? " · " + cur.label : ""}`),
              h("span", { class: "muted small" }, `${fmtDur(cur.seconds)} · ${cur.quality} · ${new Date(cur.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`),
              h("span", { class: "spacer" }),
              h("a", { class: "btn sm", href: fileUrl("output", cur.file) + "?download=1" }, "⬇ MP4"),
              h("a", { class: "btn sm", href: fileUrl("output", cur.srt) + "?download=1" }, "⬇ Captions")),
            edited && cur === films[0] ? h("p", { class: "small muted" }, "The script may have changed since this render. Render again to see your edits; this version stays.") : null,
            films.length
              ? h("table", { class: "films" },
                  h("thead", {}, h("tr", {}, h("th", {}, "Version"), h("th", {}, "Rendered"), h("th", {}, "Length"), h("th", {}, "Name / note"), h("th", {}, ""))),
                  h("tbody", {}, ...films.map((f) => h("tr", { class: f === cur ? "cur" : "" },
                    h("td", {}, h("b", {}, `v${f.n}`), f === films[0] ? h("span", { class: "muted small" }, " latest") : null),
                    h("td", {}, new Date(f.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })),
                    h("td", {}, fmtDur(f.seconds)),
                    h("td", {}, h("input", { value: f.label || "", placeholder: "e.g. sent to family", onchange: (e) => act(() => api("PATCH", `api/projects/${P.id}/films/${f.id}`, { label: e.target.value })) })),
                    h("td", {}, h("div", { class: "acts" },
                      f === cur ? h("span", { class: "muted small" }, "playing") : h("button", { class: "btn sm", onclick: () => { playing[v] = f.id; render(); } }, "▶ Play"),
                      h("a", { class: "btn sm", href: fileUrl("output", f.file) + "?download=1", title: "Download this version" }, "⬇"),
                      f.hasScript ? h("button", { class: "btn sm", title: "Put this version's script back in the editor", onclick: () => { if (confirm(`Replace the current ${vLabel(v)} script with the one used for v${f.n}? (You can undo this from File → Undo a change.)`)) act(() => api("POST", `api/projects/${P.id}/films/${f.id}/restore-script`), `v${f.n}'s script is back in the editor.`); } }, "↺ Use this script") : null,
                      h("button", { class: "btn sm danger", title: "Delete this version", onclick: () => { if (confirm(`Delete ${vLabel(v)} v${f.n}${f.label ? ` (${f.label})` : ""}? The video file is removed for good.`)) { delete playing[v]; act(() => api("DELETE", `api/projects/${P.id}/films/${f.id}`), `v${f.n} deleted.`); } } }, "🗑")))))))
              : null)
        : h("p", { class: "muted" }, s ? "Not rendered yet." : ""),
    );
  };

  const eps = episodes().map((e) => `ep${e.n}`);
  const orphans = [...new Set(P.films.map((f) => f.version))].filter((v) => !["short", "long", ...eps].includes(v));
  const unrendered = eps.filter((v) => P.scripts[v] && !P.renders[v] && !queuedFor(v)).length;
  return h("section", {},
    h("h1", {}, "Render the film"),
    h("p", { class: "lead" }, "Narration is recorded, photos get the Ken Burns treatment, maps fly to each place, newsreels and art are cut in, and the score ducks under the voice. Every render is kept as a new version (v1, v2, …) until you delete it, so you can edit the script and render again without losing anything."),
    running ? h("div", { class: "card" }, h("b", {}, running.label), h("div", { class: "progress", style: "margin:10px 0" }, h("div", { id: "renderBar", style: `width:${Math.round(running.progress * 100)}%` })), h("div", { class: "log", id: "renderLog" }, (running.log || []).join("\n"))) : null,
    filmCard("short"),
    filmCard("long"),
    eps.length
      ? h("div", {},
          h("div", { class: "group-h" },
            h("h2", { style: "margin:0" }, "📺 ", P.series.title || "Documentary series"),
            h("span", { class: "muted small" }, `${eps.length} episodes`),
            h("span", { class: "spacer" }),
            unrendered ? h("button", { class: "btn primary", onclick: async () => { try { await flush(); const r = await api("POST", `api/projects/${P.id}/series/render-all`); for (const j of r) { updateJobUI(j); watchJob(j); } P.jobs = [...(P.jobs || []), ...r]; render(); toast(`${r.length} episode(s) queued; they render one after another.`); } catch (e) { toast(e.message, true); } } }, `Render ${unrendered} unrendered episode${unrendered > 1 ? "s" : ""}`) : null),
          ...eps.map(filmCard))
      : h("div", { class: "card muted small" }, "Want a multi-episode documentary? ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); scriptTab = "series"; go("script"); } }, "Plan a series"), " on the Script step."),
    ...orphans.map(filmCard),
  );
}

// ---------- boot ----------
api("GET", "api/health").then((x) => (health = x)).catch(() => {}).finally(route);
