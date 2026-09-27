// BioPicker — AI biopic video maker. HTTP server.
// Copyright (c) 2026 ePerf. All rights reserved.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import * as ai from "./lib/ai.js";
import { geocode } from "./lib/geo.js";
import { activeJobs, getJob, startJob } from "./lib/jobs.js";
import { fetchImage, fetchVideoClip } from "./lib/media.js";
import { deletePhotoFiles, ingestPhoto } from "./lib/photos.js";
import { renderFilm, resolveMedia } from "./lib/produce.js";
import { createProject, emptyProject, loadProject, projectPath, saveProject } from "./lib/store.js";
import { castingShortlist, listVoices, synthesize } from "./lib/tts.js";
import { DATA_DIR, ROOT, ensureDir, newId, sortByDate } from "./lib/util.js";

const PORT = Number(process.env.PORT || 8095);
const HOST = process.env.HOST || "127.0.0.1";
const PASSCODE = process.env.APP_PASSCODE || "";
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "5mb" }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024, files: 200 } });

// ---------- optional passcode gate ----------
const token = PASSCODE ? crypto.createHash("sha256").update("biopicker:" + PASSCODE).digest("hex").slice(0, 32) : "";
app.post("/api/login", (req, res) => {
  if (!PASSCODE || req.body?.passcode === PASSCODE) {
    res.setHeader("Set-Cookie", `bp=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}${req.secure ? "; Secure" : ""}`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Wrong passcode" });
});
app.use((req, res, next) => {
  if (!PASSCODE) return next();
  const ok = (req.headers.cookie || "").split(/;\s*/).includes(`bp=${token}`);
  if (ok || req.path === "/" || req.path.startsWith("/assets/") || req.path === "/favicon.png") return next();
  res.status(401).json({ error: "login required", login: true });
});

app.use(express.static(path.join(ROOT, "public"), { maxAge: "1h" }));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || String(e) });
  });

const P = (req) => loadProject(req.params.id);
const publicProject = (p) => ({ ...p, jobs: activeJobs(p.id).map(jobView) });
const jobView = (j) => ({ id: j.id, type: j.type, label: j.label, status: j.status, progress: j.progress, error: j.error, log: j.log.slice(-40) });
const needAI = () => {
  if (!ai.aiConfigured()) throw Object.assign(new Error("AI is not configured on this server (ANTHROPIC_API_KEY)."), { status: 503 });
};

// ---------- meta ----------
app.get("/api/health", (req, res) => res.json({ ok: true, ai: ai.aiConfigured(), version: "1.0.0" }));

// ---------- projects ----------
app.post("/api/projects", wrap(async (req, res) => res.json(createProject(String(req.body?.name || "").slice(0, 120)))));
app.get("/api/projects/:id", wrap(async (req, res) => res.json(publicProject(P(req)))));

const PERSON_KEYS = Object.keys(emptyProject("x").person);
const SETTING_KEYS = ["tone", "quality", "shortSeconds", "longSeconds", "voice", "music", "burnCaptions", "includeArchival", "includeArt"];

app.patch("/api/projects/:id", wrap(async (req, res) => {
  const p = P(req);
  const b = req.body || {};
  if (b.person) for (const k of PERSON_KEYS) if (k in b.person) p.person[k] = String(b.person[k] ?? "").slice(0, 5000);
  if (b.settings) {
    for (const k of SETTING_KEYS) if (k in b.settings) p.settings[k] = b.settings[k];
    p.settings.shortSeconds = Math.max(30, Math.min(300, Number(p.settings.shortSeconds) || 90));
    p.settings.longSeconds = Math.max(120, Math.min(1800, Number(p.settings.longSeconds) || 360));
    if (!["serious", "humorous", "teachable"].includes(p.settings.tone)) p.settings.tone = "serious";
    if (!["480p", "720p", "1080p"].includes(p.settings.quality)) p.settings.quality = "720p";
  }
  if (Array.isArray(b.timeline)) {
    p.timeline = b.timeline.slice(0, 300).map((e) => ({
      id: e.id || newId(8),
      date: String(e.date || "").slice(0, 20),
      type: String(e.type || "other").slice(0, 30),
      title: String(e.title || "").slice(0, 200),
      place: String(e.place || "").slice(0, 200),
      description: String(e.description || "").slice(0, 3000),
      lat: Number.isFinite(e.lat) ? e.lat : null,
      lon: Number.isFinite(e.lon) ? e.lon : null,
      geoFor: e.geoFor || "",
    }));
    p.timeline.sort(sortByDate);
    geocodeTimeline(p);
  }
  if (Array.isArray(b.photos)) {
    const byId = Object.fromEntries(b.photos.map((x) => [x.id, x]));
    for (const ph of p.photos) {
      const u = byId[ph.id];
      if (!u) continue;
      for (const k of ["caption", "date", "place", "eventId"]) if (k in u) ph[k] = u[k] == null ? null : String(u[k]).slice(0, 1000);
      if ("include" in u) ph.include = !!u.include;
    }
  }
  if (Array.isArray(b.interview)) {
    const byId = Object.fromEntries(b.interview.map((x) => [x.id, x]));
    for (const q of p.interview) if (byId[q.id] && "answer" in byId[q.id]) q.answer = String(byId[q.id].answer || "").slice(0, 8000);
    const keep = new Set(b.interview.map((x) => x.id));
    p.interview = p.interview.filter((q) => keep.has(q.id));
  }
  saveProject(p);
  res.json(publicProject(p));
}));

function geocodeTimeline(p) {
  (async () => {
    let changed = false;
    for (const e of p.timeline) {
      if (!e.place || (e.geoFor === e.place && e.lat != null)) continue;
      const g = await geocode(e.place);
      e.lat = g?.lat ?? null;
      e.lon = g?.lon ?? null;
      e.geoFor = e.place;
      changed = true;
    }
    if (changed) saveProject(p);
  })().catch(() => {});
}

// ---------- photos ----------
app.post("/api/projects/:id/photos", upload.array("photos", 200), wrap(async (req, res) => {
  const p = P(req);
  const added = [];
  const errors = [];
  for (const f of req.files || []) {
    try {
      added.push(await ingestPhoto(p.id, f));
    } catch (e) {
      errors.push(e.message);
    }
  }
  p.photos.push(...added);
  saveProject(p);
  if (added.length && ai.aiConfigured()) {
    startJob({ projectId: p.id, type: "photos", label: `Analysing ${added.length} photo(s)` }, async ({ log, progress }) => {
      let n = 0;
      const ids = added.map((a) => a.id);
      await Promise.all([0, 1, 2].map(async (w) => {
        for (let i = w; i < ids.length; i += 3) {
          const ph = p.photos.find((x) => x.id === ids[i]);
          if (!ph) continue;
          try {
            ph.ai = await ai.analyzePhoto(p, ph);
            if (!ph.caption) ph.caption = ph.ai.suggestedCaption;
          } catch (e) {
            log(`${ph.originalName}: ${e.message}`);
          }
          progress(++n / ids.length);
        }
      }));
      saveProject(p);
    });
  }
  res.json({ project: publicProject(p), errors });
}));

app.delete("/api/projects/:id/photos/:pid", wrap(async (req, res) => {
  const p = P(req);
  const ph = p.photos.find((x) => x.id === req.params.pid);
  if (ph) {
    deletePhotoFiles(p.id, ph);
    p.photos = p.photos.filter((x) => x !== ph);
    saveProject(p);
  }
  res.json(publicProject(p));
}));

// ---------- documents ----------
app.post("/api/projects/:id/documents", upload.array("docs", 30), wrap(async (req, res) => {
  const p = P(req);
  const added = [];
  for (const f of req.files || []) {
    const ext = (path.extname(f.originalname).toLowerCase() || ".txt").replace(/[^.a-z0-9]/g, "");
    if (![".pdf", ".txt", ".md", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".csv", ".json", ".html", ".htm"].includes(ext)) continue;
    const doc = { id: newId(8), name: f.originalname.slice(0, 200), file: `${newId(10)}${ext}`, summary: "", events: [], facts: [], status: "pending" };
    fs.writeFileSync(projectPath(p.id, "docs", doc.file), f.buffer);
    added.push(doc);
  }
  p.documents.push(...added);
  saveProject(p);
  if (added.length && ai.aiConfigured()) {
    startJob({ projectId: p.id, type: "documents", label: `Reading ${added.length} document(s)` }, async ({ log, progress }) => {
      let n = 0;
      for (const d of added) {
        try {
          const r = await ai.extractDocument(p, d);
          Object.assign(d, r, { status: "done" });
        } catch (e) {
          d.status = "error";
          log(`${d.name}: ${e.message}`);
        }
        progress(++n / added.length);
        saveProject(p);
      }
    });
  }
  res.json(publicProject(p));
}));

app.delete("/api/projects/:id/documents/:did", wrap(async (req, res) => {
  const p = P(req);
  const d = p.documents.find((x) => x.id === req.params.did);
  if (d) {
    fs.rmSync(projectPath(p.id, "docs", d.file), { force: true });
    p.documents = p.documents.filter((x) => x !== d);
    saveProject(p);
  }
  res.json(publicProject(p));
}));

// ---------- interview ----------
app.post("/api/projects/:id/interview/next", wrap(async (req, res) => {
  needAI();
  const p = P(req);
  const { questions } = await ai.nextQuestions(p, 6);
  for (const q of questions) p.interview.push({ id: newId(8), ...q, answer: "" });
  saveProject(p);
  res.json(publicProject(p));
}));

// ---------- history ----------
app.post("/api/projects/:id/context", wrap(async (req, res) => {
  needAI();
  const p = P(req);
  if (!p.timeline.length) throw Object.assign(new Error("Add some timeline events first."), { status: 400 });
  const job = startJob({ projectId: p.id, type: "context", label: "Researching history" }, async ({ progress }) => {
    progress(0.1);
    p.context = await ai.historicalContext(p);
    p.context.createdAt = new Date().toISOString();
    saveProject(p);
  });
  res.json(jobView(job));
}));

// ---------- voices ----------
app.get("/api/voices", wrap(async (req, res) => res.json(await listVoices())));

app.post("/api/projects/:id/voice/cast", wrap(async (req, res) => {
  needAI();
  const p = P(req);
  const voices = await castingShortlist(p.person.language || "en");
  const pick = await ai.castVoice(p, voices);
  const v = voices.find((x) => x.id === pick.voiceId) || voices.find((x) => x.id === "en-US-GuyNeural");
  p.settings.voice = { provider: v.provider, id: v.id, label: v.label, rate: Math.round(pick.rate || 0), pitch: Math.round(pick.pitch || 0) };
  p.settings.voiceRationale = pick.rationale;
  saveProject(p);
  res.json(publicProject(p));
}));

const previewDir = ensureDir(path.join(DATA_DIR, "previews"));
app.post("/api/tts/preview", wrap(async (req, res) => {
  const { voice, text } = req.body || {};
  if (!voice?.id) throw Object.assign(new Error("voice required"), { status: 400 });
  const f = path.join(previewDir, `${newId(10)}.mp3`);
  await synthesize(voice, String(text || "This is the story of a remarkable life.").slice(0, 400), f);
  res.setHeader("Content-Type", "audio/mpeg");
  res.sendFile(f, () => fs.rm(f, { force: true }, () => {}));
}));

// ---------- music upload ----------
app.post("/api/projects/:id/music", upload.array("music", 5), wrap(async (req, res) => {
  const p = P(req);
  for (const f of req.files || []) {
    const ext = path.extname(f.originalname).toLowerCase();
    if (![".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"].includes(ext)) continue;
    const file = `${newId(10)}${ext}`;
    fs.writeFileSync(projectPath(p.id, "music", file), f.buffer);
    p.uploadedMusic.push({ id: newId(8), name: f.originalname.slice(0, 200), file });
  }
  saveProject(p);
  res.json(publicProject(p));
}));

app.delete("/api/projects/:id/music/:mid", wrap(async (req, res) => {
  const p = P(req);
  const m = p.uploadedMusic.find((x) => x.id === req.params.mid);
  if (m) {
    fs.rmSync(projectPath(p.id, "music", m.file), { force: true });
    p.uploadedMusic = p.uploadedMusic.filter((x) => x !== m);
    saveProject(p);
  }
  res.json(publicProject(p));
}));

// ---------- scripts ----------
const VERSIONS = ["short", "long"];
const checkVersion = (v) => {
  if (!VERSIONS.includes(v)) throw Object.assign(new Error("version must be short or long"), { status: 400 });
  return v;
};

app.post("/api/projects/:id/scripts/:version", wrap(async (req, res) => {
  needAI();
  const p = P(req);
  const version = checkVersion(req.params.version);
  const secs = version === "short" ? p.settings.shortSeconds : p.settings.longSeconds;
  const job = startJob({ projectId: p.id, type: "script", label: `Writing the ${version} version` }, async ({ log, progress }) => {
    log(`Writing a ${p.settings.tone} ${version} script (~${secs}s)…`);
    progress(0.05);
    const s = await ai.writeScript(p, version, secs);
    const { words } = ai.wordBudget(secs, p.settings.voice?.rate);
    const count = () => s.scenes.reduce((a, sc) => a + String(sc.narration).split(/\s+/).filter(Boolean).length, 0);
    for (let pass = 0; pass < 2 && count() > words * 1.1; pass++) {
      log(`Script has ${count()} words; tightening to ~${words}…`);
      await ai.tightenScript(s, words);
    }
    for (const sc of s.scenes) sc.id = newId(6);
    p.scripts[version] = { ...s, version, targetSeconds: secs, tone: p.settings.tone, createdAt: new Date().toISOString(), mediaResolvedAt: null };
    saveProject(p);
    progress(0.4);
    log("Finding public-domain footage, art and music…");
    await resolveMedia(p, version, log);
    progress(1);
  });
  res.json(jobView(job));
}));

app.put("/api/projects/:id/scripts/:version", wrap(async (req, res) => {
  const p = P(req);
  const version = checkVersion(req.params.version);
  const cur = p.scripts[version];
  if (!cur) throw Object.assign(new Error("No script"), { status: 404 });
  const b = req.body || {};
  for (const k of ["title", "tagline"]) if (k in b) cur[k] = String(b[k] || "").slice(0, 300);
  if (Array.isArray(b.scenes)) {
    const old = Object.fromEntries(cur.scenes.map((s) => [s.id, s]));
    cur.scenes = b.scenes.map((s) => {
      const o = old[s.id] || { id: newId(6), visuals: [], kind: "life", transition: "fade", eventId: "" };
      const out = { ...o };
      for (const k of ["narration", "onScreenTitle", "onScreenSubtitle", "year", "place", "kind", "transition"]) if (k in s) out[k] = String(s[k] ?? "").slice(0, 4000);
      if (Array.isArray(s.visuals)) {
        out.visuals = s.visuals.slice(0, 6).map((v, i) => {
          const prev = o.visuals.find((x) => x.type === v.type && x.ref === v.ref) || (typeof v.i === "number" ? o.visuals[v.i] : null);
          if (prev && prev.ref === v.ref && prev.type === v.type) return { ...prev, caption: v.caption ?? prev.caption };
          cur.mediaResolvedAt = null; // new/changed visual → needs media lookup
          return { type: String(v.type), ref: String(v.ref || ""), caption: String(v.caption || "") };
        });
      }
      return out;
    });
  }
  saveProject(p);
  res.json(publicProject(p));
}));

app.post("/api/projects/:id/scripts/:version/media", wrap(async (req, res) => {
  const p = P(req);
  const version = checkVersion(req.params.version);
  const job = startJob({ projectId: p.id, type: "media", label: "Finding media" }, ({ log }) => resolveMedia(p, version, log));
  res.json(jobView(job));
}));

// swap a visual to its next search candidate
app.post("/api/projects/:id/scripts/:version/scenes/:sid/visuals/:vi/next", wrap(async (req, res) => {
  const p = P(req);
  const s = p.scripts[checkVersion(req.params.version)];
  const sc = s?.scenes.find((x) => x.id === req.params.sid);
  const v = sc?.visuals[Number(req.params.vi)];
  if (!v?.candidates?.length) throw Object.assign(new Error("No alternatives for this visual."), { status: 400 });
  for (let step = 1; step <= v.candidates.length; step++) {
    const idx = (v.candIndex + step) % v.candidates.length;
    const c = v.candidates[idx];
    try {
      const base = newId(8);
      if (c.kind === "video") {
        await fetchVideoClip(c, projectPath(p.id, "media", `${base}.mp4`));
        v.asset = { kind: "video", file: `${base}.mp4`, title: c.title, source: c.source, license: c.license, credit: c.credit, pageUrl: c.pageUrl, thumb: c.thumb };
      } else {
        await fetchImage(c, projectPath(p.id, "media", `${base}.jpg`));
        v.asset = { kind: "image", file: `${base}.jpg`, title: c.title, source: c.source, license: c.license, credit: c.credit, pageUrl: c.pageUrl, thumb: c.thumb };
      }
      v.candIndex = idx;
      v.locked = true;
      break;
    } catch {}
  }
  saveProject(p);
  res.json(publicProject(p));
}));

// ---------- render ----------
app.post("/api/projects/:id/render/:version", wrap(async (req, res) => {
  const p = P(req);
  const version = checkVersion(req.params.version);
  if (!p.scripts[version]) throw Object.assign(new Error("Write the script first."), { status: 400 });
  if (activeJobs(p.id).some((j) => j.type === "render")) throw Object.assign(new Error("A render is already running for this project."), { status: 409 });
  const job = startJob({ projectId: p.id, type: "render", lane: "render", label: `Rendering the ${version} film` }, ({ log, progress }) =>
    renderFilm(p, version, { log, progress }));
  res.json(jobView(job));
}));

app.get("/api/jobs/:jid", (req, res) => {
  const j = getJob(req.params.jid);
  if (!j) return res.status(404).json({ error: "job not found" });
  res.json(jobView(j));
});

// ---------- project files ----------
const FILE_DIRS = new Set(["uploads", "thumbs", "media", "output", "docs", "music"]);
app.get("/files/:id/:dir/:file", (req, res) => {
  const { id, dir, file } = req.params;
  if (!FILE_DIRS.has(dir) || !/^[A-Za-z0-9._-]+$/.test(file)) return res.status(400).end();
  let f;
  try {
    f = projectPath(id, dir, file);
  } catch {
    return res.status(400).end();
  }
  if (!fs.existsSync(f)) return res.status(404).end();
  if (req.query.download) res.attachment(file);
  res.sendFile(f);
});

app.listen(PORT, HOST, () => {
  console.log(`BioPicker listening on http://${HOST}:${PORT} (AI ${ai.aiConfigured() ? "on" : "OFF"}, data ${DATA_DIR})`);
});
