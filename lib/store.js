// BioPicker — project persistence (one JSON file per project). Copyright (c) 2026 EPerf
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDir, newId } from "./util.js";

const PROJECTS_DIR = ensureDir(path.join(DATA_DIR, "projects"));
const cache = new Map();

export const projectDir = (id) => {
  if (!/^[A-Za-z0-9]{6,32}$/.test(id)) throw Object.assign(new Error("Bad project id"), { status: 400 });
  return path.join(PROJECTS_DIR, id);
};
export const projectPath = (id, ...parts) => path.join(projectDir(id), ...parts);

export function emptyProject(id, name) {
  return {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    person: {
      name: name || "",
      preferredName: "",
      born: "",
      birthplace: "",
      died: "",
      nationality: "",
      occupation: "",
      claimToFame: "",
      personality: "",
      family: "",
      legacy: "",
      notes: "",
      language: "en",
    },
    photos: [],
    documents: [],
    timeline: [],
    interview: [], // {id, question, why, category, answer}
    context: null, // historical overlays
    settings: {
      tone: "serious", // serious | humorous | teachable
      quality: "720p",
      shortSeconds: 90,
      longSeconds: 360,
      voice: null, // {provider, id, rate, pitch, label}
      voiceRationale: "",
      music: "auto", // auto | upload | none | generated
      burnCaptions: false,
      includeArchival: true,
      includeArt: true,
      episodeCount: 0, // documentary series: 0 = let the AI choose
      episodeSeconds: 600,
    },
    uploadedMusic: [],
    scripts: {}, // version (short | long | ep1..ep20) -> script
    renders: {}, // version -> latest film of that version (derived from films)
    films: [], // every rendered film, kept until deleted: {id, version, n, file, srt, vtt, seconds, at, quality, label, title, scriptSnapshot}
    series: null, // documentary series plan: {title, episodes: [{n, title, logline, from, to, eventIds}], createdAt}
    archivedAt: null, // archived biopics are hidden from the main list but otherwise untouched
    ownerId: null, // the account that owns it; biopics without an owner are hidden until claimed (scripts/admin.js claim)
    public: false, // public biopics can be watched by anyone with the link: latest films + photo thumbnails only
    publishedAt: null,
  };
}

export function createProject(name, ownerId) {
  const id = newId(12);
  ensureDir(projectDir(id));
  for (const d of ["uploads", "thumbs", "docs", "media", "work", "output", "music"]) ensureDir(projectPath(id, d));
  const p = emptyProject(id, name);
  p.ownerId = ownerId;
  saveProject(p);
  return p;
}

export function loadProject(id) {
  if (cache.has(id)) return cache.get(id);
  const file = projectPath(id, "project.json");
  if (!fs.existsSync(file)) throw Object.assign(new Error("Project not found"), { status: 404 });
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  // films (version history) arrived after the first release: adopt older single renders as v1
  if (!Array.isArray(p.films)) {
    p.films = Object.entries(p.renders || {}).map(([version, r]) => ({ id: newId(8), version, n: 1, label: "", title: p.scripts?.[version]?.title || "", scriptSnapshot: null, ...r }));
  }
  // forward-fill any settings added after the project was created
  const base = emptyProject(id);
  p.person = { ...base.person, ...p.person };
  p.settings = { ...base.settings, ...p.settings };
  for (const k of Object.keys(base)) if (p[k] === undefined) p[k] = base[k];
  syncRenders(p);
  cache.set(id, p);
  return p;
}

// ---------- film versions ----------
export const VERSION_RE = /^(short|long|ep([1-9]|1[0-9]|20))$/;
export const nextFilmNumber = (p, version) => 1 + Math.max(0, ...p.films.filter((f) => f.version === version).map((f) => f.n || 0));
/** p.renders[version] always points at the newest film of that version. */
export function syncRenders(p) {
  p.renders = {};
  for (const f of p.films) if (!p.renders[f.version] || (f.n || 0) > (p.renders[f.version].n || 0)) p.renders[f.version] = f;
}

// ---------- snapshots (undo for bulk changes such as a Word upload) ----------
export function snapshotProject(p, reason) {
  const dir = ensureDir(projectPath(p.id, "history"));
  const at = new Date().toISOString();
  const file = `${at.replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ reason, at, project: p }));
  const all = fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 20))) fs.rmSync(path.join(dir, old), { force: true });
  return { file, reason, at };
}
export function listSnapshots(id) {
  const dir = projectPath(id, "history");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort().reverse().map((file) => {
    try {
      const { reason, at } = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      return { file, reason, at };
    } catch {
      return null;
    }
  }).filter(Boolean);
}
/** Brings back the inputs and scripts saved in a snapshot. Films rendered since are kept. */
export function restoreSnapshot(p, file) {
  if (!/^[\w-]+\.json$/.test(file)) throw Object.assign(new Error("Bad snapshot"), { status: 400 });
  const full = projectPath(p.id, "history", file);
  if (!fs.existsSync(full)) throw Object.assign(new Error("That undo point no longer exists."), { status: 404 });
  const old = JSON.parse(fs.readFileSync(full, "utf8")).project;
  for (const k of ["person", "photos", "timeline", "interview", "settings", "scripts", "series"]) p[k] = old[k];
  const onDisk = new Set(fs.readdirSync(projectPath(p.id, "uploads")));
  p.photos = (p.photos || []).filter((ph) => onDisk.has(ph.file));
  saveProject(p);
  return p;
}

export function saveProject(p) {
  p.updatedAt = new Date().toISOString();
  cache.set(p.id, p);
  const file = projectPath(p.id, "project.json");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, file);
  return p;
}

// ---------- listing, backup & restore ----------
const SUBDIRS = ["uploads", "thumbs", "docs", "media", "work", "output", "music", "history"];
const BACKUP_DIRS = SUBDIRS.filter((d) => d !== "work"); // work/ is scratch that renders regenerate

/** Every biopic on disk (all owners). */
export function allProjects() {
  const out = [];
  for (const id of fs.readdirSync(PROJECTS_DIR)) {
    if (!/^[A-Za-z0-9]{6,32}$/.test(id) || !fs.existsSync(projectPath(id, "project.json"))) continue;
    try {
      out.push(loadProject(id));
    } catch {}
  }
  return out;
}

/** One owner's biopics, newest first. */
export function listProjects(ownerId) {
  const out = [];
  for (const p of allProjects()) {
    if (p.ownerId !== ownerId) continue;
    const id = p.id;
    try {
      const cover = p.photos.find((ph) => ph.include !== false) || p.photos[0];
      out.push({
        id,
        name: p.person.name || "Untitled",
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        archivedAt: p.archivedAt || null,
        public: !!p.public,
        cover: cover ? cover.file : null,
        counts: {
          photos: p.photos.length,
          events: p.timeline.length,
          answers: p.interview.filter((q) => q.answer).length,
          scripts: Object.keys(p.scripts).length,
          films: p.films.length,
          episodes: p.series?.episodes?.length || 0,
        },
      });
    } catch {}
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function exportProject(id) {
  const p = loadProject(id);
  const entries = [{ name: "project.json", data: Buffer.from(JSON.stringify(p, null, 2)) }];
  for (const d of BACKUP_DIRS) {
    const dir = projectPath(id, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      if (st.isFile()) entries.push({ name: `${d}/${f}`, data: fs.readFileSync(full), mtime: st.mtime });
    }
  }
  return { project: p, entries };
}

/** Restores a backup. Keeps its id when that id is free here; otherwise restores as a new copy (never overwrites). */
export function importProject(entries, ownerId) {
  const pj = entries.find((e) => e.name === "project.json");
  if (!pj) throw Object.assign(new Error("This is not a BioPicker backup (no project.json inside)."), { status: 400 });
  let p;
  try {
    p = JSON.parse(pj.data.toString("utf8"));
  } catch {
    throw Object.assign(new Error("The backup's project.json is damaged."), { status: 400 });
  }
  if (!p || typeof p !== "object" || !p.person) throw Object.assign(new Error("This is not a BioPicker backup."), { status: 400 });
  let id = typeof p.id === "string" && /^[A-Za-z0-9]{6,32}$/.test(p.id) ? p.id : null;
  let copy = false;
  if (!id || fs.existsSync(projectDir(id))) {
    copy = !!id;
    id = newId(12);
  }
  ensureDir(projectDir(id));
  for (const d of SUBDIRS) ensureDir(projectPath(id, d));
  for (const e of entries) {
    const m = e.name.match(/^([a-z]+)\/([A-Za-z0-9._-]+)$/);
    if (!m || !BACKUP_DIRS.includes(m[1])) continue;
    fs.writeFileSync(projectPath(id, m[1], m[2]), e.data);
  }
  p.id = id;
  p.ownerId = ownerId;
  p.public = false;
  p.publishedAt = null;
  if (copy) p.person.name = `${p.person.name || "Untitled"} (restored copy)`;
  saveProject(p);
  cache.delete(id); // reload from disk so older backups get today's fields (film versions, series…)
  return { project: loadProject(id), copy };
}

// ---------- delete (to "Recently deleted"), restore, purge ----------
const TRASH_DIR = ensureDir(path.join(DATA_DIR, "trash"));
export const TRASH_DAYS = 30;
const trashPath = (id) => {
  if (!/^[A-Za-z0-9]{6,32}$/.test(id)) throw Object.assign(new Error("Bad project id"), { status: 400 });
  return path.join(TRASH_DIR, id);
};

/** Moves a biopic (everything: photos, scripts, films) out of the list into the trash. */
export function deleteProject(id) {
  const p = loadProject(id);
  if (fs.existsSync(trashPath(id))) fs.rmSync(trashPath(id), { recursive: true, force: true });
  fs.renameSync(projectDir(id), trashPath(id));
  cache.delete(id);
  const meta = { id, ownerId: p.ownerId || null, name: p.person.name || "Untitled", deletedAt: new Date().toISOString(), films: p.films.length, photos: p.photos.length };
  fs.writeFileSync(path.join(trashPath(id), "deleted.json"), JSON.stringify(meta));
  return meta;
}

/** Recently deleted biopics; pass an owner to see only theirs. */
export function listTrash(ownerId) {
  const out = [];
  for (const id of fs.readdirSync(TRASH_DIR)) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(trashPath(id), "deleted.json"), "utf8"));
      if (ownerId !== undefined && (meta.ownerId || null) !== ownerId) continue;
      out.push({ ...meta, purgeAt: new Date(Date.parse(meta.deletedAt) + TRASH_DAYS * 86400000).toISOString() });
    } catch {}
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export function restoreFromTrash(id) {
  if (!fs.existsSync(trashPath(id))) throw Object.assign(new Error("That biopic is no longer in Recently deleted."), { status: 404 });
  if (fs.existsSync(projectDir(id))) throw Object.assign(new Error("A biopic with the same id already exists."), { status: 409 });
  fs.rmSync(path.join(trashPath(id), "deleted.json"), { force: true });
  fs.renameSync(trashPath(id), projectDir(id));
  cache.delete(id);
  return loadProject(id);
}

export function purgeFromTrash(id) {
  if (!fs.existsSync(trashPath(id))) throw Object.assign(new Error("That biopic is no longer in Recently deleted."), { status: 404 });
  fs.rmSync(trashPath(id), { recursive: true, force: true });
}

export const trashOwner = (id) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(trashPath(id), "deleted.json"), "utf8")).ownerId || null;
  } catch {
    return undefined; // not in the trash
  }
};

/** Erases every biopic an account owns, including its Recently deleted (account deletion). */
export function eraseOwner(ownerId) {
  let n = 0;
  for (const p of allProjects()) {
    if (p.ownerId !== ownerId) continue;
    fs.rmSync(projectDir(p.id), { recursive: true, force: true });
    cache.delete(p.id);
    n++;
  }
  for (const t of listTrash(ownerId)) fs.rmSync(trashPath(t.id), { recursive: true, force: true });
  return n;
}

/** Admin: gives every biopic without an owner (from before accounts existed) to one account. */
export function claimUnowned(ownerId) {
  const claimed = [];
  for (const p of allProjects()) {
    if (p.ownerId) continue;
    p.ownerId = ownerId;
    saveProject(p);
    claimed.push(p.person.name || p.id);
  }
  for (const id of fs.readdirSync(TRASH_DIR)) {
    const f = path.join(TRASH_DIR, id, "deleted.json");
    try {
      const meta = JSON.parse(fs.readFileSync(f, "utf8"));
      if (meta.ownerId) continue;
      meta.ownerId = ownerId;
      fs.writeFileSync(f, JSON.stringify(meta));
      const pj = path.join(TRASH_DIR, id, "project.json");
      const tp = JSON.parse(fs.readFileSync(pj, "utf8"));
      tp.ownerId = ownerId;
      fs.writeFileSync(pj, JSON.stringify(tp, null, 2));
    } catch {}
  }
  return claimed;
}

/** Permanently removes biopics deleted more than TRASH_DAYS ago. */
export function purgeExpiredTrash() {
  const now = Date.now();
  for (const t of listTrash()) if (Date.parse(t.purgeAt) < now) fs.rmSync(trashPath(t.id), { recursive: true, force: true });
}
