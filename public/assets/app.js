// BioPicker front end — © 2026 EPerf
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

// replaceChildren() would print null/false slots as text; skip them like h() does
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((c) => c != null && c !== false));

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
    ME = null;
    showAuth("signin");
    throw new Error("Please sign in.");
  }
  // a plan limit: offer the plans (when people can subscribe here) or the admin's upgrade link
  if (r.status === 402 && data?.paywall && (data.plans || data.upgradeUrl)) limitDialog(data);
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
// a documentary starts from the maker's own script and pictures; the AI adds the history around it
const DOC_STEPS = [
  ["story", "Your story"],
  ["media", "Pictures"],
  ["history", "Background"],
  ["style", "Style, length & voice"],
  ["script", "Script & media"],
  ["render", "Render film"],
];
const isDoc = () => P?.kind === "documentary";
const steps = () => (isDoc() ? DOC_STEPS : STEPS);
const firstStep = (kind) => (kind === "documentary" ? "story" : "person");

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
  if (!ME) return showAuth("signin");
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
/** Folds a new edit into the unsaved ones without losing either: sections merge by field, and the lists that
 *  carry only changed records (photos, research picks) merge by id. Whole lists (timeline, interview) replace. */
const MERGE_BY_ID = new Set(["photos", "researchPicks"]);
function mergePending(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const was = out[k];
    if (MERGE_BY_ID.has(k) && Array.isArray(v) && Array.isArray(was)) {
      const byId = new Map(was.map((x) => [x.id, x]));
      for (const x of v) byId.set(x.id, { ...(byId.get(x.id) || {}), ...x });
      out[k] = [...byId.values()];
    } else if (v && was && typeof v === "object" && typeof was === "object" && !Array.isArray(v) && !Array.isArray(was)) out[k] = { ...was, ...v };
    else out[k] = v;
  }
  return out;
}

function patch(body, delay = 500) {
  clearTimeout(saveTimer);
  const id = P.id;
  if (Object.keys(body).length) patch.pending = mergePending(patch.pending || {}, body);
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
          patch.pending = mergePending(b, patch.pending || {});
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
    if (!isDirty()) toast("All changes saved. You can close this tab and continue later from “All films”.");
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
      // the Word round trip is laid out for biopics (person, timeline, interview), so documentaries skip it
      isDoc() ? null : item("Download Word document", "Everything you've entered, the photos and the scripts, to edit in Word", downloadWord),
      isDoc() ? null : item("Update from Word…", "Upload the edited .docx; changes are applied and can be undone", () => wordInput.click()),
      item("Undo a change…", isDoc() ? "Go back to before a script restore" : "Go back to before a Word upload or script restore", showHistory),
      h("hr"),
      item(P.public ? "🌐 Public link…" : "Make public…", P.public ? "Anyone with the link can watch the films" : "Let anyone with a link watch the finished films", publicDialog),
      item("Copy link", "Continue this biopic in another browser or device", copyLink),
      item("Download backup (.zip)", "Everything, including films, to restore on any BioPicker", downloadBackup),
      h("hr"),
      P.archivedAt
        ? item("Unarchive", "Put this biopic back in your main list", () => setArchived(P.id, false, render))
        : item("Archive", "Hide from the main list; nothing is changed or deleted", () => setArchived(P.id, true, render)),
      item(isDoc() ? "Delete documentary…" : "Delete biopic…", "Move to Recently deleted (restorable for 30 days)", () => deleteBiopic({ id: P.id, name: P.person.name, archivedAt: P.archivedAt, counts: { films: P.films.length } }))),
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
      if (j.status === "error") toast(j.held ? "Your film is waiting for a review before it's made. See the Render step." : `${j.label}: ${j.error}`, !j.held);
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
  fill(box, 
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
  fill(bar);
  if (!P) return;
  bar.append(
    h("span", { class: "muted small" }, isDoc() ? "Documentary" : "Biopic of"),
    h("b", {}, P.person.name || "Untitled"),
    h("span", { id: "saveStat", class: "savestat ok", role: "status", "aria-live": "polite" }),
    h("button", { class: "btn sm", onclick: saveNow, title: "Save everything now (edits also save automatically as you type)" }, "Save now"),
    fileMenu(),
    h("button", { class: "btn sm ghost", onclick: () => (location.hash = "") }, "All films"),
  );
  updateSaveUI();
}

function renderSteps() {
  const nav = $("#steps");
  fill(nav);
  if (!P) return;
  const done = {
    person: !!P.person.name,
    story: !!P.story?.text?.trim(),
    media: P.photos.length > 0,
    timeline: P.timeline.length > 0,
    interview: P.interview.some((q) => q.answer),
    history: isDoc() ? !!P.research : !!P.context,
    style: !!P.settings.voice,
    script: Object.keys(P.scripts).length > 0,
    render: Object.keys(P.renders).length > 0,
  };
  steps().forEach(([k, label], i) =>
    nav.append(
      h("button", { class: (k === step ? "on " : "") + (done[k] ? "done" : ""), onclick: () => go(k), "aria-current": k === step ? "step" : null },
        h("span", { class: "n" }, done[k] && k !== step ? "✓" : i + 1), label),
    ),
  );
}

function render() {
  // a step from the other kind of project (e.g. a link to "The person" on a documentary) opens the first step
  if (P && !steps().some(([k]) => k === step)) step = firstStep(P.kind);
  renderProjBar();
  renderSteps();
  if (!P) return;
  const views = isDoc()
    ? { story: vStory, media: vMedia, history: vResearch, style: vStyle, script: vScript, render: vRender }
    : { person: vPerson, media: vMedia, timeline: vTimeline, interview: vInterview, history: vHistory, style: vStyle, script: vScript, render: vRender };
  const scrollY = window.scrollY;
  const active = document.activeElement?.id;
  fill(main, 
    P.archivedAt ? h("div", { class: "banner" }, "🗄 This biopic is archived, so it's hidden from your main list. You can still view and edit it.", h("button", { class: "btn sm", onclick: () => setArchived(P.id, false, render) }, "Unarchive")) : null,
    h("div", { id: "jobs", class: "jobs" }),
    views[step]());
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
  fill(main, 
    h("div", { class: "hero" },
      h("h1", {}, "Every life is a film."),
      h("p", {}, "Make a biopic of someone's life, or a documentary from your own story. BioPicker researches the history around it, casts a narrator, and cuts a Ken Burns–style film with your pictures, public-domain newsreels, maps and music."),
      h("div", { class: "starts" },
        h("div", { class: "start" },
          h("b", {}, "A biopic"),
          h("span", { class: "small muted" }, "Someone's life, from photos, documents and an interview."),
          h("div", { class: "row" },
            h("input", { id: "newName", placeholder: "Whose story? e.g. Grandma Rose Alvarez" }),
            h("button", { class: "btn primary", onclick: () => newProject("biopic") }, "Start a biopic"))),
        h("div", { class: "start" },
          h("b", {}, "A documentary"),
          h("span", { class: "small muted" }, "Your own script and pictures, with the history around them."),
          h("div", { class: "row" },
            h("input", { id: "newDocName", placeholder: "Working title, e.g. The Summer of '65" }),
            h("button", { class: "btn primary", onclick: () => newProject("documentary") }, "Start a documentary")))),
      h("p", { class: "small muted rules-note" }, "Films are for telling real stories. Please follow our ", h("a", { href: "terms.html#rules", target: "_blank" }, "content rules"), ": nothing sexual, hateful, violent or meant to hurt someone."),
      h("div", { class: "recent", id: "projList" }, h("p", { class: "muted small" }, "Loading your saved biopics…")),
      h("div", { class: "restore" },
        h("label", { class: "btn sm ghost" }, "Restore a backup (.zip)…",
          h("input", { type: "file", accept: ".zip,application/zip", hidden: true, onchange: (e) => restoreBackup(e.target.files[0]) }))),
    ),
  );
  Promise.all([api("GET", "api/projects"), api("GET", "api/trash").catch(() => [])])
    .then(([list, trash]) => drawProjects(list, trash))
    .catch(() => drawProjects(recent().map((x) => ({ id: x.id, name: x.name, updatedAt: new Date(x.at).toISOString() })), []));
  $("#newName").addEventListener("keydown", (e) => e.key === "Enter" && newProject("biopic"));
  $("#newDocName").addEventListener("keydown", (e) => e.key === "Enter" && newProject("documentary"));
}

function drawProjects(list, trash = []) {
  const box = document.getElementById("projList");
  if (!box) return;
  const ago = (t) => {
    const d = new Date(t);
    return isNaN(d) ? "" : d.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  };
  const bits = (c) => c ? [c.photos && `${c.photos} picture${c.photos > 1 ? "s" : ""}`, c.events && `${c.events} event${c.events > 1 ? "s" : ""}`, c.answers && `${c.answers} answer${c.answers > 1 ? "s" : ""}`, c.scripts && "script ready", c.films && "film rendered"].filter(Boolean).join(" · ") : "";
  const row = (x) => h("div", { class: "projitem" + (x.archivedAt ? " archived" : "") },
    h("a", { href: `#p=${x.id}`, class: "projrow" },
      x.cover ? h("img", { src: `files/${x.id}/thumbs/${encodeURIComponent(x.cover)}`, alt: "", loading: "lazy" }) : h("span", { class: "ph" }, "🎬"),
      h("span", { class: "meta" }, h("b", {}, x.name, x.kind === "documentary" ? h("span", { class: "tag" }, " Documentary") : null, x.public ? h("span", { class: "tag ok", title: "Anyone with the link can watch" }, " 🌐 Public") : null), h("span", { class: "muted small" }, [x.archivedAt ? `Archived ${ago(x.archivedAt)}` : `Last saved ${ago(x.updatedAt)}`, bits(x.counts)].filter(Boolean).join(" · "))),
      h("span", { class: "go" }, x.archivedAt ? "Open →" : "Continue →")),
    x.counts
      ? h("div", { class: "rowacts" },
          h("button", { class: "btn sm ghost", title: x.archivedAt ? "Move back to your films" : "Hide from this list; nothing is changed or deleted", onclick: () => setArchived(x.id, !x.archivedAt, renderHome) }, x.archivedAt ? "Unarchive" : "Archive"),
          h("button", { class: "btn sm ghost danger", title: "Delete this film project", onclick: () => deleteBiopic(x, renderHome) }, "Delete"))
      : null);
  const active = list.filter((x) => !x.archivedAt);
  const archived = list.filter((x) => x.archivedAt);
  fill(box, 
    ...(active.length
      ? [h("h3", {}, "Your saved films — pick up where you left off"), ...active.map(row)]
      : [h("p", { class: "muted small" }, archived.length ? "No active films. Your archived ones are below." : "No saved films yet.")]),
    archived.length ? h("details", { class: "fold", open: !active.length }, h("summary", {}, `Archived (${archived.length})`), ...archived.map(row)) : null,
    trash.length
      ? h("details", { class: "fold" }, h("summary", {}, `Recently deleted (${trash.length})`),
          h("p", { class: "muted small" }, `Deleted films are kept for ${30} days, then removed for good.`),
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

async function newProject(kind = "biopic") {
  const name = $(kind === "documentary" ? "#newDocName" : "#newName").value.trim();
  try {
    const p = await api("POST", "api/projects", { name, kind });
    P = p;
    remember(P);
    location.hash = `p=${p.id}&s=${firstStep(p.kind)}`;
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- accounts: sign in, sign up ----------
let ME = null; // signed-in user: { username, createdAt }

function showAuth(mode = "signin", data = {}) {
  P = null;
  renderProjBar();
  renderSteps();
  renderAcct();
  const views = { signin: authSignIn, signup: authSignUp, recover: authRecover };
  fill(main, h("div", { class: "hero auth" }, (views[mode] || authSignIn)(data)));
  main.querySelector("input")?.focus();
}

const authForm = (onSubmit, ...kids) => {
  const f = h("form", { class: "authform", novalidate: true }, ...kids);
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = f.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await onSubmit(new FormData(f));
    } catch (er) {
      toast(er.message, true);
    } finally {
      btn.disabled = false;
    }
  });
  return f;
};
function authInput(label, name, attrs = {}) {
  const input = h("input", { name, ...attrs });
  if (attrs.type !== "password") return h("label", { class: "f" }, label, input);
  // every password field gets an eye that shows/hides what was typed
  const eye = h("button", { type: "button", class: "pw-eye", "aria-label": "Show password", title: "Show password", onclick: () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    eye.textContent = show ? "🙈" : "👁";
    eye.setAttribute("aria-label", show ? "Hide password" : "Show password");
    eye.title = eye.getAttribute("aria-label");
    input.focus();
  } }, "👁");
  return h("label", { class: "f" }, label, h("span", { class: "pw-wrap" }, input, eye));
}
const authLinks = (...links) => h("p", { class: "small muted authlinks" }, ...links.flatMap((l, i) => (i ? [" · ", l] : [l])));
const linkTo = (label, mode) => h("a", { href: "#", onclick: (e) => { e.preventDefault(); showAuth(mode); } }, label);

function authSignIn() {
  return [
    h("h1", {}, "Every life is a film."),
    h("p", {}, "Sign in to your BioPicker studio."),
    authForm(async (fd) => {
      const r = await api("POST", "api/auth/login", { username: fd.get("username"), password: fd.get("password") });
      signedIn(r.user);
    },
      authInput("Username", "username", { autocomplete: "username", autocapitalize: "none", spellcheck: "false", required: true }),
      authInput("Password", "password", { type: "password", autocomplete: "current-password", required: true }),
      h("button", { class: "btn primary", type: "submit" }, "Sign in")),
    authLinks(linkTo("Create an account", "signup"), linkTo("Forgot password?", "recover")),
  ];
}

function authSignUp() {
  return [
    h("h1", {}, "Create your account"),
    h("p", {}, "Your biopics, photos and films are private to your account unless you choose to share a film."),
    authForm(async (fd) => {
      if (fd.get("password") !== fd.get("password2")) throw new Error("The passwords don't match.");
      const r = await api("POST", "api/auth/signup", { username: fd.get("username"), password: fd.get("password"), agree: fd.get("agree") === "on", ...arrival() });
      signedIn(r.user);
    },
      authInput("Username", "username", { autocomplete: "username", autocapitalize: "none", spellcheck: "false", placeholder: "3–32 letters or numbers", required: true }),
      authInput("Password", "password", { type: "password", autocomplete: "new-password", placeholder: "At least 8 characters", required: true }),
      authInput("Confirm password", "password2", { type: "password", autocomplete: "new-password", required: true }),
      h("label", { class: "agree small" }, h("input", { type: "checkbox", name: "agree" }),
        h("span", {}, "I agree to the ", h("a", { href: "terms.html", target: "_blank" }, "Terms"), " and ", h("a", { href: "privacy.html", target: "_blank" }, "Privacy Policy"),
          ", including that the photos, documents and details I add are processed by AI services (Anthropic's Claude) to write my biopic.")),
      h("button", { class: "btn primary", type: "submit" }, "Create account")),
    authLinks(h("span", {}, "Have an account? "), linkTo("Sign in", "signin")),
  ];
}

function authRecover() {
  return [
    h("h1", {}, "Forgot your password?"),
    h("p", {}, "Email ", h("a", { href: "mailto:support@eperf.com?subject=BioPicker%20password" }, "support@eperf.com"), " with your username and we will help you get back in. Your biopics stay exactly as they are. Once you are signed in with a new password, change it under Account settings."),
    authLinks(linkTo("Back to sign in", "signin")),
  ];
}

function signedIn(user) {
  ME = user;
  renderAcct();
  native?.({ type: "signedIn" });
  route();
}

async function signOut() {
  try { await api("POST", "api/auth/logout", { deviceToken: window.bpNative.deviceToken || undefined }); } catch {}
  ME = null;
  P = null;
  try { localStorage.removeItem("bp_recent"); } catch {}
  history.replaceState(null, "", location.pathname);
  showAuth("signin");
}

// ---------- account menu & settings ----------
function renderAcct() {
  const box = $("#acct");
  if (!box) return;
  if (!ME) return fill(box);
  const menu = h("details", { class: "menu" });
  menu.append(
    h("summary", { class: "btn sm ghost", title: "Your account" }, `👤 ${ME.username} ▾`),
    h("div", { class: "pop" },
      h("button", { onclick: () => { menu.open = false; accountDialog(); } }, h("b", {}, "Account settings"), h("span", {}, "Your plan, change password, delete account")),
      ME.admin ? h("button", { onclick: () => { menu.open = false; location.href = "admin.html"; } }, h("b", {}, "Admin panel"), h("span", {}, "Accounts, usage and cost, plans and paywall")) : null,
      h("button", { onclick: () => { menu.open = false; signOut(); } }, h("b", {}, "Sign out"), h("span", {}, "Sign out on this device"))));
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) menu.open = false; });
  fill(box, menu);
}

// where this visitor came from (the external page that linked here, and the first page they opened), sent with sign-up
(() => {
  try {
    if (sessionStorage.getItem("bp_arrival")) return;
    const ref = document.referrer && new URL(document.referrer).host !== location.host ? document.referrer : "";
    sessionStorage.setItem("bp_arrival", JSON.stringify({ referrer: ref.slice(0, 300), landing: (location.pathname + location.search).slice(0, 300) }));
  } catch {}
})();
function arrival() {
  try {
    return JSON.parse(sessionStorage.getItem("bp_arrival") || "{}");
  } catch {
    return {};
  }
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString([], { dateStyle: "medium" }) : "");
/** One line about a paid subscription: how it's paid and when it renews or ends. */
function subLine(sub) {
  if (!sub) return null;
  const how = sub.provider === "apple" ? "through the App Store" : "by card";
  return sub.cancelAtPeriodEnd ? `Paid ${how}; ends ${fmtDate(sub.periodEnd)} (won't renew).` : `Paid ${how}; renews ${fmtDate(sub.periodEnd)}.`;
}

/** This month's plan allowance, as a short summary for Account settings. */
function planSummary(u) {
  if (!u) return null;
  if (u.plan.id === "none") {
    return h("div", { class: "card plansum" },
      h("b", {}, "No plan yet"),
      h("p", { class: "small muted" }, u.plans ? "BioPicker's free spots were full when you joined. Choose a plan to start making films." : "BioPicker's free spots were full when you joined. You'll be able to make films once you're given a plan."),
      u.plans ? h("div", { class: "row" }, h("button", { class: "btn sm primary", onclick: () => plansDialog() }, "See plans")) : null);
  }
  const renders = u.renders.limit == null ? `${u.renders.used} film render${u.renders.used === 1 ? "" : "s"} this month (no limit)` : `${u.renders.used} of ${u.renders.limit} film renders used this month`;
  const ai = u.aiShare == null ? null : `${Math.round(u.aiShare * 100)}% of this month's AI allowance used`;
  return h("div", { class: "card plansum" },
    h("div", { class: "row" }, h("b", {}, `Plan: ${u.plan.name}`), u.plan.priceMonthly ? h("span", { class: "muted small" }, ` $${u.plan.priceMonthly.toFixed(2)}/month`) : null),
    u.plan.description ? h("p", { class: "small muted" }, u.plan.description) : null,
    h("div", { class: "small" }, renders),
    u.renders.limit ? h("div", { class: "progress", title: renders }, h("div", { style: `width:${Math.min(100, (100 * u.renders.used) / u.renders.limit)}%` })) : null,
    ai ? h("div", { class: "small" }, ai) : null,
    u.aiShare != null ? h("div", { class: "progress", title: ai }, h("div", { style: `width:${Math.round(u.aiShare * 100)}%` })) : null,
    u.series ? null : h("div", { class: "small muted" }, "Documentary series aren't included in this plan."),
    u.sub ? h("div", { class: "small muted" }, subLine(u.sub)) : null,
    u.plans ? h("div", { class: "row" }, h("button", { class: "btn sm primary", onclick: () => plansDialog() }, u.sub ? "Change or cancel plan" : "See plans"))
      : u.upgrade?.url ? h("div", { class: "row" }, h("a", { class: "btn sm primary", href: u.upgrade.url, target: "_blank", rel: "noopener" }, "Upgrade")) : null);
}

// ---------- paid plans: Stripe on the web, Apple In-App Purchase in the iPhone app ----------
const inApp = () => !!native;
async function plansDialog(reason) {
  let info;
  try {
    info = await api("GET", "api/pay/plans");
  } catch (e) {
    return toast(e.message, true);
  }
  // in the app, prices come from the App Store (in the person's currency); on the web, from the plan
  let storePrices = {};
  const appleIds = info.plans.map((p) => p.appleProductId).filter(Boolean);
  if (inApp() && appleIds.length) {
    try {
      storePrices = JSON.parse((await native({ type: "products", ids: appleIds })) || "{}");
    } catch {}
  }
  const sub = info.sub?.active ? info.sub : null;
  const buyable = (p) => (inApp() ? !!(p.appleProductId && storePrices[p.appleProductId]) : p.web);
  const price = (p) => (p.free ? "Free" : inApp() && storePrices[p.appleProductId] ? `${storePrices[p.appleProductId]} / month` : `${Number(p.priceMonthly).toFixed(2)} / month`);
  const features = (p) => [
    p.rendersPerMonth == null ? "Unlimited film renders" : `${p.rendersPerMonth} film render${p.rendersPerMonth === 1 ? "" : "s"} a month`,
    p.series ? "Documentary series" : null,
  ].filter(Boolean).join(" · ");
  const choose = async (p, btn) => {
    btn.disabled = true;
    try {
      if (inApp()) await buyInApp(p);
      else {
        const r = await api("POST", "api/pay/stripe/checkout", { planId: p.id });
        location.href = r.url;
        return;
      }
      d.close();
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  };
  // someone paying on one platform manages it there
  const elsewhere = sub && ((inApp() && sub.provider === "stripe") || (!inApp() && sub.provider === "apple"));
  const cards = info.plans.map((p) => {
    const current = info.current.planId === p.id;
    let action = null;
    if (current) action = h("span", { class: "tag ok" }, "Your plan");
    else if (!p.free && buyable(p) && !elsewhere) {
      const btn = h("button", { class: "btn sm primary", onclick: () => choose(p, btn) }, sub ? "Switch" : "Choose");
      action = btn;
    }
    return h("div", { class: `card plancard${current ? " current" : ""}` },
      h("div", { class: "row" }, h("b", {}, p.name), h("span", { class: "spacer" }), h("span", {}, price(p))),
      p.description ? h("p", { class: "small muted" }, p.description) : null,
      h("div", { class: "row" }, h("span", { class: "small" }, features(p)), h("span", { class: "spacer" }), action));
  });
  // in the app with nothing for sale on the App Store (no product ids yet, or an older app build): say so plainly.
  // No pointer to the website here: App Review rule 3.1.1 limits steering people to outside purchases.
  const appSale = !inApp() || info.plans.some((p) => !p.free && buyable(p));
  const manage = sub ? (
    elsewhere
      ? h("p", { class: "small muted" }, sub.provider === "apple" ? "You subscribe through the App Store. Change or cancel it in the BioPicker iPhone app, or in Settings › your name › Subscriptions." : "You subscribe on the BioPicker website. Sign in there in a web browser to change or cancel.")
      : inApp()
        ? h("p", { class: "small" }, h("a", { href: "https://apps.apple.com/account/subscriptions", target: "_blank" }, "Manage or cancel in your App Store subscriptions"))
        : h("p", { class: "small" }, h("a", { href: "#", onclick: async (e) => { e.preventDefault(); try { location.href = (await api("POST", "api/pay/stripe/portal")).url; } catch (x) { toast(x.message, true); } } }, "Manage, change card or cancel"))
  ) : null;
  const d = showDialog(reason ? "You've reached a plan limit" : "Plans",
    reason ? h("p", {}, reason) : null,
    sub ? h("p", { class: "small muted" }, subLine(sub)) : null,
    ...cards,
    manage,
    !appSale ? h("p", { class: "small muted" }, "Paid plans can't be bought in the iPhone app yet.")
    : inApp() ? h("p", { class: "small muted" }, "Subscriptions renew monthly until cancelled, and are charged to your Apple ID. Cancel any time in your App Store subscriptions, at least 24 hours before the renewal date. ",
      h("a", { href: "terms.html", target: "_blank" }, "Terms"), " · ", h("a", { href: "privacy.html", target: "_blank" }, "Privacy")) : h("p", { class: "small muted" }, "Plans renew monthly until cancelled. Payments are handled by Stripe; BioPicker never sees your card. ", h("a", { href: "terms.html", target: "_blank" }, "Terms")),
    h("div", { class: "row end" },
      inApp() && appSale ? h("button", { class: "btn", onclick: () => restoreInApp() }, "Restore purchases") : null,
      h("button", { class: "btn", onclick: () => d.close() }, "Close")));
}

/** iPhone: buy through StoreKit; the app returns Apple's signed transaction and the server checks it. */
async function buyInApp(p) {
  const { accountToken } = await api("GET", "api/pay/apple/token");
  const res = await native({ type: "buy", productId: p.appleProductId, accountToken });
  if (!res) return; // cancelled, or waiting for approval (Ask to Buy): it arrives later through bpNative.applePurchase
  const { jws, id } = JSON.parse(res);
  const r = await api("POST", "api/pay/apple/purchase", { transaction: jws });
  native({ type: "finish", id }).catch(() => {}); // recorded: the App Store can stop re-sending it
  toast(`You're on ${r.plan.name}. Thank you!`);
  renderAcct();
}
async function restoreInApp() {
  try {
    const list = JSON.parse((await native({ type: "restore" })) || "[]");
    if (!list.length) return toast("No App Store subscriptions to restore on this Apple ID.");
    const r = await api("POST", "api/pay/apple/purchase", { transactions: list });
    toast(`Restored. You're on ${r.plan.name}.`);
    document.querySelector("dialog.bp")?.close();
  } catch (e) {
    toast(e.message, true);
  }
}

/** Shown when a plan limit stops something: the plans to choose from, or the admin's upgrade link. */
function limitDialog(data) {
  if (data.plans) return plansDialog(data.error);
  const d = showDialog("You've reached a plan limit",
    h("p", {}, data.error),
    h("div", { class: "row end" },
      h("button", { class: "btn", onclick: () => d.close() }, "Not now"),
      h("a", { class: "btn primary", href: data.upgradeUrl, target: "_blank", rel: "noopener", onclick: () => d.close() }, "See plans")));
}

async function accountDialog() {
  try { ME = (await api("GET", "api/auth/me")).user || ME; } catch {}
  let mine = null;
  try { mine = await api("GET", "api/account/usage"); } catch {}
  const d = showDialog("Account",
    h("p", {}, "Signed in as ", h("b", {}, ME.username), h("span", { class: "muted small" }, ` · member since ${new Date(ME.createdAt).toLocaleDateString([], { dateStyle: "medium" })}`)),
    planSummary(mine),
    h("div", { class: "acctacts" },
      h("button", { class: "btn", onclick: () => reauthDialog("Change password", "Choose a new password. You'll stay signed in here; other devices are signed out.", [["New password", "newPassword", "password", "new-password"], ["Confirm new password", "newPassword2", "password", "new-password"]], async (body) => {
        if (body.newPassword !== body.newPassword2) throw new Error("The passwords don't match.");
        await api("POST", "api/account/password", body);
        toast("Password changed.");
      }) }, "Change password"),
      h("button", { class: "btn danger", onclick: () => reauthDialog("Delete your account?", "This permanently erases your account and every biopic in it: photos, documents, scripts and films, including Recently deleted and any public links. It can't be undone. Download backups first if you want to keep anything.", [], async (body) => {
        await api("POST", "api/account/delete", body);
        ME = null;
        try { localStorage.removeItem("bp_recent"); } catch {}
        history.replaceState(null, "", location.pathname);
        showAuth("signin");
        toast("Your account and everything in it has been deleted.");
      }, "Delete account forever") }, "Delete account…")),
    h("div", { class: "row end" }, h("button", { class: "btn", onclick: () => d.close() }, "Close")));
}

/** Asks for the current password before a sensitive change, then runs it. */
function reauthDialog(title, text, extra, run, submitLabel = "Confirm") {
  const fields = [["Current password", "password", "password", "current-password"], ...extra];
  const f = authForm(async (fd) => {
    await run(Object.fromEntries(fd.entries()));
    d.close();
  },
    h("p", { class: "small" }, text),
    ...fields.map(([label, name, type, ac]) => authInput(label, name, { type, autocomplete: ac, required: true })),
    h("div", { class: "row end" }, h("button", { class: "btn", type: "button", onclick: () => d.close() }, "Cancel"), h("button", { class: submitLabel.startsWith("Delete") ? "btn primary danger-fill" : "btn primary", type: "submit" }, submitLabel)));
  const d = showDialog(title, f);
  f.querySelector("input")?.focus();
}

// ---------- sharing a biopic publicly ----------
const watchUrl = (id) => new URL(`watch/${id}`, location.href.split("#")[0]).href;
function publicDialog() {
  const set = async (pub) => {
    try {
      P = { ...(await api("POST", `api/projects/${P.id}/visibility`, { public: pub })), jobs: P.jobs };
      d.close();
      render();
      if (pub) publicDialog();
      else toast("This biopic is private again. The old link no longer works.");
    } catch (e) {
      toast(e.message, true);
    }
  };
  const url = watchUrl(P.id);
  const d = showDialog(P.public ? "This biopic is public" : "Make this biopic public?",
    h("p", {}, P.public
      ? "Anyone with this link can watch the latest version of each film and see the photo thumbnails. They can't see or change anything else."
      : "Anyone with the link will be able to watch the latest version of each film and see thumbnails of the included photos. Documents, original photos, the interview and scripts stay private, and only you can edit."),
    P.public ? h("div", { class: "row" }, h("input", { value: url, readonly: true, onclick: (e) => e.target.select() }),
      h("button", { class: "btn", onclick: () => (navigator.share ? navigator.share({ title: P.person.name, url }).catch(() => {}) : navigator.clipboard.writeText(url).then(() => toast("Link copied."))) }, navigator.share ? "Share…" : "Copy link"),
      h("a", { class: "btn", href: url, target: "_blank" }, "Open")) : null,
    h("p", { class: "small muted" }, "Only share films of people who agreed to it, and only with media you have the right to share."),
    h("div", { class: "row end" },
      h("button", { class: "btn", onclick: () => d.close() }, P.public ? "Close" : "Cancel"),
      P.public ? h("button", { class: "btn danger", onclick: () => set(false) }, "Make private") : h("button", { class: "btn primary", onclick: () => set(true) }, "Make public")));
}

// ---------- native iOS app bridge (absent in browsers) ----------
const nativeHandler = window.webkit?.messageHandlers?.bpNative;
const native = nativeHandler ? (msg) => nativeHandler.postMessage(msg) : null;
window.bpNative = {
  deviceToken: null,
  toast: (msg, err) => toast(msg, err),
  open: (hash) => { if (ME) location.hash = hash; },
  async registerDevice(token, environment) {
    window.bpNative.deviceToken = token;
    if (ME) await api("POST", "api/account/devices", { token, environment }).catch(() => {});
  },
  // renewals and purchases finished outside the dialog (e.g. approved by a parent later) arrive here
  async applePurchase(jws) {
    if (!ME) return false;
    try {
      await api("POST", "api/pay/apple/purchase", { transaction: jws });
      return true;
    } catch {
      return false;
    }
  },
};

/** iPhone: the native picker keeps each photo's date and place and converts HEIC to JPEG before upload. */
async function pickPhotosNative() {
  try {
    const res = await native({ type: "pickPhotos", uploadUrl: new URL(`api/projects/${P.id}/photos`, location.href.split("#")[0]).href });
    if (!res) return;
    const r = JSON.parse(res);
    if (r.errors?.length) toast(r.errors.join("; "), true);
    if (r.project) {
      P = r.project;
      render();
      watchJobs();
      if (!r.errors?.length) toast(`${r.added} photo${r.added === 1 ? "" : "s"} added.`);
    }
  } catch (e) {
    toast(e.message, true);
  }
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
      field("Goes by (optional)", "preferredName", { ph: "Grandma Rose" }),
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

// ---------- documentary: 1. your story ----------
/** A row of choice tiles (the same look as the tone picker). */
function tiles(options, current, onPick) {
  return h("div", { class: "tones", role: "radiogroup" },
    ...options.map(([k, t, d]) => h("div", {
      class: "tone" + (current === k ? " on" : ""), tabindex: 0, role: "radio", "aria-checked": current === k,
      onclick: () => onPick(k), onkeydown: (e) => e.key === "Enter" && onPick(k),
    }, h("div", { class: "t" }, t), h("div", { class: "d" }, d))));
}

function vStory() {
  const st = P.story;
  const set = (obj, now) => { Object.assign(P.story, obj); return patch({ story: obj }, now ? 0 : 500); };
  const wc = (t) => String(t || "").split(/\s+/).filter(Boolean).length;
  const count = h("span", { class: "muted small", id: "storyCount" }, `${wc(st.text)} words`);
  const fileIn = h("input", { id: "storyFile", type: "file", accept: ".docx,.txt,.md,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain", hidden: true, onchange: async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    if (st.text.trim() && !confirm("Replace the script below with the text of this file?")) return;
    try {
      await flush();
      const fd = new FormData();
      fd.append("file", f);
      P = await api("POST", `api/projects/${P.id}/story/file`, fd, true);
      render();
      toast(`Loaded ${f.name}`);
    } catch (er) { toast(er.message, true); }
  } });
  const sfield = (label, key, ph) => h("label", { class: "f" }, label,
    h("input", { id: `st_${key}`, value: st[key] || "", placeholder: ph, oninput: (e) => set({ [key]: e.target.value }) }));
  return h("section", {},
    h("h1", {}, "Your story"),
    h("p", { class: "lead" }, "Paste or upload your script. It can be finished narration or rough notes. BioPicker keeps your memories as you tell them, then researches the history around them and weaves it in."),
    aiWarn(),
    h("div", { class: "card grid2" },
      h("label", { class: "f" }, "Working title",
        h("input", { id: "st_title", value: P.person.name || "", placeholder: "The Summer of '65", oninput: (e) => { P.person.name = e.target.value; patch({ person: { name: e.target.value } }); } })),
      sfield("What it's about, in a line", "about", "Two young brothers near the border in Ferozepur during the 1965 India–Pakistan war"),
      sfield("When", "period", "1963–1966"),
      sfield("Where", "place", "Ferozepur, Punjab, India"),
    ),
    h("div", { class: "card", style: "margin-top:14px" },
      h("div", { class: "row" }, h("h2", { style: "margin:0" }, "Your script"), count, h("span", { class: "spacer" }),
        h("button", { class: "btn sm", onclick: () => fileIn.click() }, "Upload Word or text file…"), fileIn),
      h("textarea", { id: "storyText", rows: 16, style: "margin-top:10px", placeholder: "What happened, in your own words. Notes are fine: dates, places, who was there, what you saw and felt.",
        oninput: (e) => { set({ text: e.target.value }); count.textContent = `${wc(e.target.value)} words`; } }, st.text || ""),
      h("p", { class: "small muted", style: "margin-bottom:0" }, "Notes meant for an illustrator (like “render multiple panels…”) are left out of the narration automatically."),
    ),
    h("h2", { style: "margin-top:18px" }, "Who tells it?"),
    tiles([
      ["first", "Me, with a narrator", "Your memories in the first person (“I”, “my brother”), with a narrator for the history. You can give each its own voice."],
      ["third", "A narrator", "One narrator tells your story and the history in the third person."],
    ], st.telling, (k) => { set({ telling: k }, true); render(); }),
    h("h2", { style: "margin-top:18px" }, "Your words"),
    tiles([
      ["keep", "Keep my words", "Your sentences as written (spelling fixed, notes left out). The film runs as long as it needs to."],
      ["polish", "Polish them", "Your voice, facts and best lines, smoothed into narration that fits the length. Recommended for notes."],
      ["notes", "Write from my notes", "Fresh narration written from your notes, keeping every fact."],
    ], st.wording, (k) => { set({ wording: k }, true); render(); }),
    h("p", { class: "small muted rules-note" }, "Every film is checked against our ", h("a", { href: "terms.html#rules", target: "_blank" }, "content rules"), " before it's made. War, hardship and hard history are fine to tell."),
    nextBtn("media"),
  );
}

// ---------- documentary: 3. background ----------
function vResearch() {
  const r = P.research;
  const pick = (e, on) => { e.include = on; patch({ researchPicks: [{ id: e.id, include: on }] }); };
  const busy = (P.jobs || []).some((j) => j.type === "research");
  const ready = !!P.story?.text?.trim();
  const chosen = r ? r.events.filter((e) => e.include !== false).length : 0;
  return h("section", {},
    h("h1", {}, "Background"),
    h("p", { class: "lead" }, "The history around your story: the big picture, what happened near you, life on the home front, and how it ended. Untick anything you don't want in the film. The narrator's commentary is written from what's ticked."),
    aiWarn(),
    h("div", { class: "row", style: "margin-bottom:14px" },
      h("button", { class: "btn primary", disabled: busy || !health.ai || !ready, onclick: async () => { await flush(); try { const j = await api("POST", `api/projects/${P.id}/research`); watchJob(j); updateJobUI(j); } catch (e) { toast(e.message, true); } } },
        r ? "Research again" : "Research the background"),
      ready ? null : h("span", { class: "muted small" }, "Add your script on the Your story step first."),
      r ? h("span", { class: "muted small" }, `${chosen} of ${r.events.length} events chosen · AI-researched, so double-check anything you'll publish.`) : null),
    r
      ? h("div", { class: "hist" },
          h("div", { class: "card" }, h("h3", {}, "Overview"), h("p", {}, r.overview)),
          r.factChecks?.length
            ? h("div", { class: "card factchecks" },
                h("h3", {}, "Worth a second look in your script"),
                h("p", { class: "small muted" }, "Places where historians tell it a little differently. Your memories are yours; these are only about the general history. The narrator won't repeat a claim as fact, but you may want to adjust your wording."),
                h("ul", {}, ...r.factChecks.map((f) => h("li", {}, h("b", {}, `“${f.claim}”`), " ", f.note))))
            : null,
          ...r.events.map((e) =>
            h("label", { class: "m pick" + (e.include === false ? " off" : "") },
              h("input", { type: "checkbox", checked: e.include !== false, onchange: (ev) => { pick(e, ev.target.checked); ev.target.closest(".m").classList.toggle("off", !ev.target.checked); } }),
              h("div", {},
                h("h3", {}, `${e.date} · ${e.title} `, h("span", { class: "tag" }, e.scope)),
                h("p", {}, e.description),
                e.relevance ? h("p", { class: "inf" }, e.relevance) : null,
                h("div", { class: "small muted" }, [e.archivalQuery && `🎞 footage: “${e.archivalQuery}”`, e.stillQuery && `📷 photo: “${e.stillQuery}”`, e.mapPlace && `🗺 ${e.mapPlace}`].filter(Boolean).join("   "))))))
      : h("div", { class: "card muted" }, busy ? "Researching…" : "No research yet."),
    h("div", { style: "height:14px" }),
    nextBtn("style"),
  );
}

// ---------- 2. media ----------
function dropZone(label, accept, multiple, onFiles, id, onPick) {
  const input = h("input", { type: "file", accept, multiple, hidden: true, id });
  input.addEventListener("change", () => input.files.length && onFiles([...input.files]));
  const pick = onPick || (() => input.click());
  const z = h("div", { class: "drop", tabindex: 0, role: "button", onclick: pick, onkeydown: (e) => (e.key === "Enter" || e.key === " ") && pick() }, label, input,
    onPick ? h("div", { class: "small muted", style: "margin-top:6px" }, h("a", { href: "#", onclick: (e) => { e.preventDefault(); e.stopPropagation(); input.click(); } }, "or choose from Files")) : null);
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
  const doc = isDoc();
  return h("section", {},
    h("h1", {}, doc ? "Pictures" : "Photos & documents"),
    h("p", { class: "lead" }, doc
      ? "Add the pictures for your film: illustrations you made from memory (for example with sketchArtist) and any real photographs. Pictures marked as illustrations carry a small “Illustration from memory” label in the film, so nobody mistakes them for photographs."
      : "Drop in photos (dates and GPS are read from their metadata) and documents — résumés, diplomas, obituaries, letters, articles (PDF, image or text). The AI reads them and suggests timeline events."),
    h("div", { class: doc ? "" : "grid2" },
      dropZone(native ? "📷  Tap to choose photos — their dates and places come along" : "📷  Drop photos here or click to choose (JPEG, PNG, WebP, HEIC)", "image/*", true, (f) => uploadFiles(`api/projects/${P.id}/photos`, "photos", f).catch((e) => toast(e.message, true)), "photoInput", native ? pickPhotosNative : null),
      doc ? null : dropZone("📄  Drop documents here (PDF, image scans, .txt)", ".pdf,.txt,.md,.csv,.json,.html,image/*", true, (f) => uploadFiles(`api/projects/${P.id}/documents`, "docs", f).catch((e) => toast(e.message, true)), "docInput"),
    ),
    h("p", { class: "small muted rules-note" }, "Only add photos and documents you have the right to use. No sexual, hateful, violent or harassing material; every film is checked against our ", h("a", { href: "terms.html#rules", target: "_blank" }, "content rules"), " before it's made."),
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
          h("div", { class: "row" }, h("h2", {}, `${doc ? "Pictures" : "Photos"} (${P.photos.length})`), h("span", { class: "spacer" }),
            dated.length && !doc ? h("button", { class: "btn sm", onclick: () => photosToEvents() }, "Suggest timeline events from photo dates") : null),
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
                  doc
                    ? h("label", { class: "small row", title: "Shows “Illustration from memory” on this picture in the film" }, h("input", { type: "checkbox", checked: !!ph.illustration, onchange: (e) => photoPatch(ph.id, { illustration: e.target.checked }) }), "Illustration, not a real photo")
                    : h("select", { onchange: (e) => photoPatch(ph.id, { eventId: e.target.value || null }) },
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
    nextBtn(doc ? "history" : "timeline"),
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
      fill(voiceBox, h("span", { class: "muted" }, "Loading voices…"));
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
    // documentaries told in the first person: the maker's memories can be read by a second voice
    const two = isDoc() && P.story?.telling !== "third";
    const sv = s.storyVoice || {};
    const storySel = two ? h("select", { id: "storyVoiceSel", onchange: (e) => { const v = voices.find((x) => x.id === e.target.value); set({ storyVoice: v ? { provider: v.provider, id: v.id, label: v.label, rate: sv.rate || 0, pitch: sv.pitch || 0 } : null }, true); } },
      h("option", { value: "" }, "— same as the narrator —"),
      ...list.map((v) => h("option", { value: v.id, selected: v.id === sv.id }, `${v.label} · ${v.gender} · ${v.locale}${v.personality ? " · " + v.personality : ""}`))) : null;
    fill(voiceBox, 
      h("div", { class: "grid2" },
        h("label", { class: "f full" }, two ? "Narrator voice (the history and background)" : "Narrator voice", sel),
        two ? h("label", { class: "f full" }, "Voice for your memories (the “I” parts)", storySel) : null,
        h("label", { class: "f" }, h("span", {}, "Pace ", rl), rate),
        h("label", { class: "f" }, h("span", {}, "Pitch ", pl), pitch),
        h("label", { class: "f" }, "Show", h("select", { id: "vfilter", onchange: drawVoices }, h("option", { value: "lang", selected: filter === "lang" }, "Voices for the narration language"), h("option", { value: "all", selected: filter === "all" }, "All voices (300+)"))),
        h("label", { class: "f" }, "Preview line", h("input", { id: "pvText", value: isDoc() ? "It was the summer everything changed." : `This is the story of ${P.person.preferredName || P.person.name || "a remarkable life"}.` })),
      ),
      h("div", { class: "row", style: "margin-top:10px" },
        h("button", { class: "btn", disabled: !s.voice?.id, onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true;
          try { const blob = await api("POST", "api/tts/preview", { voice: P.settings.voice, text: $("#pvText").value }); const a = new Audio(URL.createObjectURL(blob)); a.play(); } catch (er) { toast(er.message, true); }
          b.disabled = false;
        } }, "▶ Preview voice"),
        two ? h("button", { class: "btn", disabled: !s.storyVoice?.id, onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true;
          try { const blob = await api("POST", "api/tts/preview", { voice: P.settings.storyVoice, text: $("#pvText").value }); const a = new Audio(URL.createObjectURL(blob)); a.play(); } catch (er) { toast(er.message, true); }
          b.disabled = false;
        } }, "▶ Preview memories voice") : null,
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
    fill(musicUp, 
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
    isDoc() ? null : h("h2", { style: "margin-top:18px" }, "Documentary series"),
    isDoc() ? null : h("div", { class: "card" },
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
    isDoc() ? null : h("span", { class: "sep" }),
    isDoc() ? null : h("button", { class: scriptTab === "series" ? "on" : "", onclick: () => { scriptTab = "series"; render(); } }, "📺 Series plan"),
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
  if (isDoc() && !["short", "long"].includes(scriptTab)) scriptTab = "short";
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
  const twoVoices = isDoc() && P.story?.telling !== "third";
  const words = s ? s.scenes.reduce((a, sc) => a + (sc.narration || "").split(/\s+/).filter(Boolean).length, 0) : 0;
  return h("section", {},
    h("h1", {}, "Script & media"),
    h("p", { class: "lead" }, isDoc()
      ? "Claude builds the film from your script and the background you chose: your memories, the narrator's history between them, your pictures, maps, and public-domain newsreels and photos. Edit any line, switch who reads it, swap any clip, then render."
      : "Claude writes the narration and picks the pictures: your photos, maps of each place, and public-domain newsreels, historic photos and art. Edit any line, swap any clip, then render."),
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
                twoVoices ? h("select", { class: "who", title: "Who reads this scene", onchange: (e) => { sc.voice = e.target.value; saveSoon(); } },
                  h("option", { value: "story", selected: sc.voice === "story" }, "🗣 Me"),
                  h("option", { value: "narrator", selected: sc.voice !== "story" }, "🎙 Narrator")) : null,
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
          h("div", { class: "row" }, h("button", { class: "btn sm", onclick: () => { s.scenes.push({ kind: isDoc() ? "memory" : "life", voice: "narrator", narration: "", onScreenTitle: "", onScreenSubtitle: "", year: "", place: "", transition: "fade", visuals: [{ type: "card", ref: "New scene", caption: "" }] }); save(true); } }, "+ Add scene at the end")),
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
      native?.({ type: "wantNotifications" });
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
      P.held?.[v] && !q
        ? h("div", { class: "notice held", role: "status" },
            h("b", {}, "⏸ Waiting for a review. "),
            `This film may break our `, h("a", { href: "terms.html#rules", target: "_blank" }, "content rules"),
            P.held[v].reason ? `: ${P.held[v].reason} ` : ". ",
            "Someone at EPerf will look at it soon, and if it's fine you can render it. It didn't use up a render. If you change the script, rendering checks it again. Questions: ",
            h("a", { href: "mailto:support@eperf.com" }, "support@eperf.com"), ".")
        : null,
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
            unrendered ? h("button", { class: "btn primary", onclick: async () => { try { await flush(); const r = await api("POST", `api/projects/${P.id}/series/render-all`); native?.({ type: "wantNotifications" }); for (const j of r) { updateJobUI(j); watchJob(j); } P.jobs = [...(P.jobs || []), ...r]; render(); toast(`${r.length} episode(s) queued; they render one after another.`); } catch (e) { toast(e.message, true); } } }, `Render ${unrendered} unrendered episode${unrendered > 1 ? "s" : ""}`) : null),
          ...eps.map(filmCard))
      : h("div", { class: "card muted small" }, "Want a multi-episode documentary? ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); scriptTab = "series"; go("script"); } }, "Plan a series"), " on the Script step."),
    ...orphans.map(filmCard),
  );
}

// ---------- boot ----------
api("GET", "api/health").then((x) => (health = x)).catch(() => {}).finally(async () => {
  try { ME = (await api("GET", "api/auth/me")).user; } catch {}
  if (!ME) return showAuth("signin");
  renderAcct();
  native?.({ type: "signedIn" });
  // back from Stripe Checkout
  const paid = new URLSearchParams(location.search).get("paid");
  if (paid) {
    history.replaceState(null, "", location.pathname + location.hash);
    toast(paid === "1" ? "Thank you! Your plan updates as soon as the payment is confirmed (usually a few seconds)." : "No payment was made.");
  }
  route();
});
