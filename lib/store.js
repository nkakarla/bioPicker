// BioPicker — project persistence (one JSON file per project). Copyright (c) 2026 ePerf
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
      pronouns: "they/them",
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
    },
    uploadedMusic: [],
    scripts: {}, // version -> script
    renders: {}, // version -> {file, srt, at, seconds}
  };
}

export function createProject(name) {
  const id = newId(12);
  ensureDir(projectDir(id));
  for (const d of ["uploads", "thumbs", "docs", "media", "work", "output", "music"]) ensureDir(projectPath(id, d));
  const p = emptyProject(id, name);
  saveProject(p);
  return p;
}

export function loadProject(id) {
  if (cache.has(id)) return cache.get(id);
  const file = projectPath(id, "project.json");
  if (!fs.existsSync(file)) throw Object.assign(new Error("Project not found"), { status: 404 });
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  // forward-fill any settings added after the project was created
  const base = emptyProject(id);
  p.person = { ...base.person, ...p.person };
  p.settings = { ...base.settings, ...p.settings };
  for (const k of Object.keys(base)) if (p[k] === undefined) p[k] = base[k];
  cache.set(id, p);
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
const SUBDIRS = ["uploads", "thumbs", "docs", "media", "work", "output", "music"];
const BACKUP_DIRS = SUBDIRS.filter((d) => d !== "work"); // work/ is scratch that renders regenerate

export function listProjects() {
  const out = [];
  for (const id of fs.readdirSync(PROJECTS_DIR)) {
    if (!/^[A-Za-z0-9]{6,32}$/.test(id) || !fs.existsSync(projectPath(id, "project.json"))) continue;
    try {
      const p = loadProject(id);
      const cover = p.photos.find((ph) => ph.include !== false) || p.photos[0];
      out.push({
        id,
        name: p.person.name || "Untitled",
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        cover: cover ? cover.file : null,
        counts: {
          photos: p.photos.length,
          events: p.timeline.length,
          answers: p.interview.filter((q) => q.answer).length,
          scripts: Object.keys(p.scripts).length,
          films: Object.keys(p.renders).length,
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
export function importProject(entries) {
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
  if (copy) p.person.name = `${p.person.name || "Untitled"} (restored copy)`;
  cache.delete(id);
  saveProject(p);
  return { project: loadProject(id), copy };
}
