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
