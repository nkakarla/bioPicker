// BioPicker — AI biopic video maker. HTTP server.
// Copyright (c) 2026 EPerf. All rights reserved.
import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import * as ai from "./lib/ai.js";
import { geocode } from "./lib/geo.js";
import * as auth from "./lib/auth.js";
import { activeJobs, getJob, onJobFinished, startJob } from "./lib/jobs.js";
import { fetchImage, fetchVideoClip } from "./lib/media.js";
import { deletePhotoFiles, ingestPhoto } from "./lib/photos.js";
import { renderFilm, resolveMedia } from "./lib/produce.js";
import { notify, pushConfigured } from "./lib/push.js";
import {
  VERSION_RE, allProjects, createProject, deleteProject, eraseOwner, trashOwner, emptyProject, exportProject, importProject, listProjects, listSnapshots, listTrash,
  loadProject, projectPath, purgeExpiredTrash, purgeFromTrash, restoreFromTrash, restoreSnapshot, saveProject, snapshotProject, syncRenders,
} from "./lib/store.js";
import { applyDocx, buildDocx, parseDocx, versionLabel } from "./lib/word.js";
import { readZip, writeZip } from "./lib/zip.js";
import {
  castingShortlist, cloneVoice, deleteClonedVoice, listVoices, ownVoiceQuota, ownVoiceReady, spokenText, synthesize, voiceAllowed,
} from "./lib/tts.js";
import { LANGS, baseOf, langOf, langVersion } from "./lib/langs.js";
import { translateScript } from "./lib/translate.js";
import * as usage from "./lib/usage.js";
import * as pay from "./lib/payments.js";
import * as visits from "./lib/visits.js";
import * as alerts from "./lib/alerts.js";
import * as safety from "./lib/safety.js";
import { DATA_DIR, ROOT, ensureDir, ffmpeg, newId, probeDuration, sortByDate } from "./lib/util.js";

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

const PORT = Number(process.env.PORT || 8095);
const HOST = process.env.HOST || "127.0.0.1";
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

// ---------- payment webhooks (raw body for signature checks, so before the JSON parser) ----------
app.post("/api/pay/stripe/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  if (!pay.verifyStripeSignature(raw, req.get("stripe-signature"))) return res.status(400).json({ error: "bad signature" });
  try {
    await pay.stripeEvent(JSON.parse(raw));
    res.json({ received: true });
  } catch (e) {
    console.error("[pay] Stripe webhook:", e.message);
    res.status(500).json({ error: "could not apply the event; Stripe will retry" });
  }
});
app.post("/api/pay/apple/notifications", express.json({ limit: "1mb" }), (req, res) => {
  try {
    res.json(pay.appleNotification(req.body?.signedPayload));
  } catch (e) {
    console.error("[pay] Apple notification:", e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.use(express.json({ limit: "5mb" }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024, files: 200 } });

// ---------- accounts ----------
// Every request carries the signed-in user (if any). The API needs an account, except sign-in itself,
// health, and public biopics. Each biopic belongs to one account; others get 404 for it.
const ip = (req) => req.ip || "?";
const secure = (req) => req.secure;
app.use((req, res, next) => {
  req.sessionToken = auth.readSessionToken(req.headers.cookie);
  req.user = auth.sessionUser(req.sessionToken);
  // "last seen" (time, address, place, device): at most every 6 hours per account
  if (req.user && req.path.startsWith("/api/")) auth.touchSeen(req.user, visits.visit(req));
  next();
});
// AI calls and jobs started by this request are charged to this account (and biopic, set below)
app.use(usage.usageMiddleware);
const signIn = (req, res, u) => res.setHeader("Set-Cookie", auth.sessionCookie(auth.createSession(u), secure(req)));
/** The signed-in account as the browser sees it. */
const me = (u) => u && { ...auth.publicUser(u), admin: usage.isAdmin(u) };
const OPEN_API = /^\/api\/(health|auth\/|public\/|pay\/(stripe\/webhook|apple\/notifications)$)/;
app.use("/api", (req, res, next) => {
  if (req.user || OPEN_API.test(req.originalUrl)) return next();
  res.status(401).json({ error: "Please sign in.", login: true });
});

const owns = (req, p) => !!req.user && p.ownerId === req.user.id;
const notFound = () => Object.assign(new Error("Project not found"), { status: 404 });
/** Loads a biopic the signed-in user owns (404 otherwise, so ids of other people's biopics stay unknown). */
function ownedProject(req, id = req.params.id) {
  const p = loadProject(id);
  if (!owns(req, p)) throw notFound();
  return p;
}
app.use("/api/projects/:id", (req, res, next) => {
  if (req.params.id === "import") return next();
  try {
    ownedProject(req);
    usage.setUsage({ projectId: req.params.id });
    next();
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// app code revalidates on every load (cheap 304s) so a deploy shows up without a hard refresh
app.use(express.static(path.join(ROOT, "public"), {
  maxAge: "1h",
  setHeaders: (res, file) => { if (/\.(html|js|css)$/.test(file)) res.setHeader("Cache-Control", "no-cache"); },
}));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    if (!e.status || e.status >= 500) console.error(e);
    // 402 = a plan limit; the page can offer the upgrade link
    const limit = e.status === 402 ? { paywall: !!e.paywall, upgradeUrl: e.upgradeUrl || "", plans: !!e.plans, plan: e.plan || "" } : {};
    res.status(e.status || 500).json({ error: e.message || String(e), ...limit });
  });

const P = (req) => ownedProject(req);
// films carry a full script snapshot each; the browser only needs to know one exists
const publicFilm = ({ scriptSnapshot, ...f }) => ({ ...f, hasScript: !!scriptSnapshot });
const publicProject = (p) => ({
  ...p,
  films: p.films.map(publicFilm),
  renders: Object.fromEntries(Object.entries(p.renders).map(([v, f]) => [v, publicFilm(f)])),
  jobs: activeJobs(p.id).map(jobView),
  safety: undefined, // reviewer notes stay in the admin panel; the maker sees only why a film is waiting
  held: safety.heldForOwner(p),
});
const jobView = (j) => ({ id: j.id, type: j.type, version: j.version, label: j.label, status: j.status, progress: j.progress, error: j.error, held: !!j.held, log: j.log.slice(-40) });
/** AI is set up, and the account still has AI allowance this month (and series in its plan, when asked). */
const needAI = (req, opts) => {
  if (!ai.aiConfigured()) throw Object.assign(new Error("AI is not configured on this server (ANTHROPIC_API_KEY)."), { status: 503 });
  usage.checkAI(req.user, opts);
};
/** Background photo/document reading is skipped for an account that has used its AI allowance. */
const aiAllowed = (p) => {
  try {
    usage.checkAI(auth.getUser(p.ownerId));
    return true;
  } catch {
    return false;
  }
};
/** Renders queued or running across all of an account's biopics (they count toward the monthly limit). */
const activeRenders = (u) => listProjects(u.id).reduce((n, x) => n + activeJobs(x.id).filter((j) => j.type === "render").length, 0);

// ---------- meta ----------
app.get("/api/health", (req, res) => res.json({ ok: true, ai: ai.aiConfigured(), version: VERSION, accounts: true, signups: auth.signupsOpen(), push: pushConfigured() }));

// ---------- sign-up, sign-in ----------
app.get("/api/auth/me", (req, res) => res.json({ user: me(req.user) }));
app.post("/api/auth/signup", wrap(async (req, res) => {
  let user;
  try {
    user = auth.signup(req.body || {}, ip(req), usage.signupGate);
  } catch (e) {
    if (e.signupsFull) alerts.turnedAway().catch(() => {});
    throw e;
  }
  auth.recordVisit(user, visits.visit(req, { referrer: visits.referrerOf(req.body, req), landing: visits.landingOf(req.body) }), "signup");
  signIn(req, res, user);
  res.json({ user: me(user) });
  alerts.checkFreeSpots(user).catch(() => {}); // email the admin when the free spots reach the warning level
}));
app.post("/api/auth/login", wrap(async (req, res) => {
  const user = auth.login(req.body || {}, ip(req));
  auth.recordVisit(user, visits.visit(req), "login");
  signIn(req, res, user);
  res.json({ user: me(user) });
}));
app.post("/api/auth/logout", (req, res) => {
  if (req.body?.deviceToken) auth.removeDevice(String(req.body.deviceToken));
  auth.endSession(req.sessionToken);
  res.setHeader("Set-Cookie", auth.sessionCookie("", secure(req), 0));
  res.json({ ok: true });
});

// ---------- account settings (current password required for each change) ----------
app.post("/api/account/password", wrap(async (req, res) => {
  auth.changePassword(req.user, req.body || {}, ip(req), req.sessionToken);
  res.json({ ok: true });
}));
app.post("/api/account/delete", wrap(async (req, res) => {
  auth.reauth(req.user, req.body || {}, ip(req));
  const mine = listProjects(req.user.id);
  const busy = mine.flatMap((x) => activeJobs(x.id));
  if (busy.length) throw Object.assign(new Error(`Wait for “${busy[0].label}” to finish, then delete your account.`), { status: 409 });
  // stop a web subscription before the account goes (fails the deletion if Stripe can't be reached, so nobody keeps being charged)
  await pay.cancelForDeletion(req.user);
  const erased = eraseOwner(req.user.id);
  await forgetOwnVoices(req.user);
  auth.deleteUser(req.user);
  res.setHeader("Set-Cookie", auth.sessionCookie("", secure(req), 0));
  res.json({ ok: true, erased });
}));
app.post("/api/account/devices", wrap(async (req, res) => {
  auth.addDevice(req.user, req.body?.token, req.body?.environment);
  res.json({ ok: true });
}));
/** The account's plan and how much of this month's allowance is used (no dollar amounts: those are for the admin). */
app.get("/api/account/usage", wrap(async (req, res) => {
  const m = usage.monthUsage(req.user, activeRenders(req.user));
  const pw = usage.getBilling().paywall;
  const sub = usage.activeSub(req.user);
  res.json({
    month: m.month,
    plan: { id: m.plan.id, name: m.plan.name, priceMonthly: m.plan.priceMonthly, description: m.plan.description },
    source: usage.planSource(req.user),
    sub: sub && { provider: sub.provider, periodEnd: sub.periodEnd, cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd, status: sub.status },
    renders: { used: m.rendersUsed, limit: m.limits.rendersPerMonth },
    aiShare: m.aiShare,
    series: m.limits.series,
    plans: pay.canSubscribe(),
    upgrade: pw.enabled && pw.upgradeUrl ? { message: pw.message, url: pw.upgradeUrl } : null,
  });
}));

// ---------- paying for a plan ----------
// The address Stripe sends people back to: PUBLIC_URL if set, else the address this request came in on.
const origin = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
app.get("/api/pay/plans", wrap(async (req, res) => res.json(pay.plansFor(req.user))));
app.post("/api/pay/stripe/checkout", wrap(async (req, res) => res.json({ url: await pay.stripeCheckout(req.user, String(req.body?.planId || ""), origin(req)) })));
app.post("/api/pay/stripe/portal", wrap(async (req, res) => res.json({ url: await pay.stripePortal(req.user, origin(req)) })));
app.get("/api/pay/apple/token", wrap(async (req, res) => res.json({ accountToken: pay.appleAccountToken(req.user) })));
app.post("/api/pay/apple/purchase", wrap(async (req, res) => {
  // one signed transaction (after a purchase) or several (restore)
  const list = Array.isArray(req.body?.transactions) ? req.body.transactions.slice(0, 20) : [req.body?.transaction];
  let applied = 0;
  let last = null;
  for (const jws of list.filter(Boolean)) {
    try {
      pay.applePurchase(req.user, String(jws));
      applied++;
    } catch (e) {
      last = e;
    }
  }
  if (!applied && last) throw last;
  const plan = usage.planOf(req.user);
  res.json({ applied, plan: { id: plan.id, name: plan.name } });
}));

// ---------- usage: every finished render is logged with its account, level, film length and render time ----------
onJobFinished((job) => {
  if (job.type !== "render" || job.held) return; // a film held for review was never rendered
  let filmSeconds = 0;
  if (job.status === "done") {
    try {
      filmSeconds = loadProject(job.projectId).renders[job.version]?.seconds || 0;
    } catch {}
  }
  usage.recordRender({
    projectId: job.projectId,
    version: job.version,
    status: job.status === "done" ? "done" : "error",
    filmSeconds,
    wallSeconds: job.startedAt ? (job.finishedAt - job.startedAt) / 1000 : 0,
    error: job.error,
  });
});

// ---------- push: tell the owner when a film finishes rendering ----------
onJobFinished(async (job) => {
  if (job.type !== "render" || !pushConfigured()) return;
  let p;
  try {
    p = loadProject(job.projectId);
  } catch {
    return;
  }
  const u = p.ownerId && auth.getUser(p.ownerId);
  if (!u?.devices?.length) return;
  const name = p.person.name || "Your biopic";
  const ok = job.status === "done";
  await notify(u.devices, {
    title: ok ? "Your film is ready" : job.held ? "Your film is waiting for a review" : "Render didn't finish",
    body: ok ? `${name}: ${versionLabel(job.version)} is ready to watch.` : job.held ? `${name}: ${versionLabel(job.version)} will be looked at before it's made.` : `${name}: ${versionLabel(job.version)} — ${job.error || "something went wrong"}`,
    data: { projectId: p.id, step: "render" },
  }, (gone) => auth.removeDevice(gone));
});

// ---------- public biopics: anyone with the link can watch the latest films ----------
const PUBLIC_DIRS = new Set(["output", "thumbs"]);
function publicView(p) {
  const films = Object.values(p.renders).sort((a, b) => String(a.version).localeCompare(String(b.version), "en", { numeric: true }));
  return {
    id: p.id,
    name: p.person.name || "Untitled",
    preferredName: p.person.preferredName || "",
    born: p.person.born || "",
    died: p.person.died || "",
    claimToFame: p.person.claimToFame || "",
    series: p.series?.title || "",
    films: films.map((f) => ({ version: f.version, label: versionLabel(f.version), title: p.scripts[f.version]?.title || f.title || "", tagline: p.scripts[f.version]?.tagline || "", file: f.file, vtt: f.vtt || null, seconds: f.seconds, at: f.at, n: f.n })),
    photos: p.photos.filter((ph) => ph.include !== false).slice(0, 60).map((ph) => ({ file: ph.file, caption: ph.caption || "", date: ph.date || "" })),
    publishedAt: p.publishedAt,
  };
}
const publicProjectOr404 = (id) => {
  let p;
  try {
    p = loadProject(id);
  } catch {
    throw notFound();
  }
  if (!p.public) throw notFound();
  return p;
};
app.get("/api/public/:id", wrap(async (req, res) => res.json(publicView(publicProjectOr404(req.params.id)))));
const REPORTS_FILE = path.join(DATA_DIR, "reports.jsonl");
const reportTimes = new Map();
app.post("/api/public/:id/report", wrap(async (req, res) => {
  const p = publicProjectOr404(req.params.id);
  const recent = (reportTimes.get(ip(req)) || []).filter((t) => Date.now() - t < 3600000);
  if (recent.length >= 5) throw Object.assign(new Error("Thanks — we already have your reports."), { status: 429 });
  reportTimes.set(ip(req), [...recent, Date.now()]);
  const reason = String(req.body?.reason || "").slice(0, 2000);
  fs.appendFileSync(REPORTS_FILE, JSON.stringify({ at: new Date().toISOString(), projectId: p.id, name: p.person.name, ownerId: p.ownerId, reason, ip: ip(req), by: req.user?.username || null }) + "\n");
  console.warn(`[report] ${p.id} “${p.person.name}”: ${reason.slice(0, 200)}`);
  res.json({ ok: true });
}));
app.get("/watch/:id", (req, res) => res.sendFile(path.join(ROOT, "public", "watch.html")));

app.post("/api/projects/:id/visibility", wrap(async (req, res) => {
  const p = P(req);
  const pub = req.body?.public === true;
  if (pub && !p.films.length) throw Object.assign(new Error("Render a film before making this biopic public."), { status: 400 });
  p.public = pub;
  p.publishedAt = pub ? p.publishedAt || new Date().toISOString() : null;
  saveProject(p);
  res.json(publicProject(p));
}));

// ---------- projects ----------
app.get("/api/projects", wrap(async (req, res) => res.json(listProjects(req.user.id))));
app.post("/api/projects", wrap(async (req, res) => res.json(createProject(String(req.body?.name || "").slice(0, 120), req.user.id, req.body?.kind === "documentary" ? "documentary" : "biopic"))));

// archive (hide from the main list) and delete (to Recently deleted for 30 days, then gone)
app.post("/api/projects/:id/archive", wrap(async (req, res) => {
  const p = P(req);
  p.archivedAt = req.body?.archived === false ? null : new Date().toISOString();
  saveProject(p);
  res.json(publicProject(p));
}));
app.delete("/api/projects/:id", wrap(async (req, res) => {
  const p = P(req);
  const busy = activeJobs(p.id);
  if (busy.length) throw Object.assign(new Error(`Wait for “${busy[0].label}” to finish before deleting this biopic.`), { status: 409 });
  res.json(deleteProject(p.id));
}));
app.get("/api/trash", wrap(async (req, res) => res.json(listTrash(req.user.id))));
const ownTrash = (req) => {
  if (trashOwner(req.params.id) !== req.user.id) throw Object.assign(new Error("That biopic is no longer in Recently deleted."), { status: 404 });
};
app.post("/api/trash/:id/restore", wrap(async (req, res) => {
  ownTrash(req);
  const p = restoreFromTrash(req.params.id);
  res.json({ id: p.id, name: p.person.name });
}));
app.delete("/api/trash/:id", wrap(async (req, res) => {
  ownTrash(req);
  purgeFromTrash(req.params.id);
  res.json({ ok: true });
}));
purgeExpiredTrash();
setInterval(() => { try { purgeExpiredTrash(); } catch (e) { console.error("trash purge", e); } }, 6 * 3600 * 1000).unref();

// backup (download everything as one .zip) and restore (upload that .zip here or on another BioPicker)
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024, files: 1 } });
app.get("/api/projects/:id/export", wrap(async (req, res) => {
  const { project, entries } = exportProject(P(req).id);
  const slug = (project.person.name || "biopic").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "biopic";
  res.attachment(`biopicker-${slug}-${new Date().toLocaleDateString("en-CA")}.zip`);
  res.type("application/zip").send(writeZip(entries));
}));
app.post("/api/projects/import", importUpload.single("backup"), wrap(async (req, res) => {
  if (!req.file) throw Object.assign(new Error("Choose a BioPicker backup (.zip) to restore."), { status: 400 });
  const { project, copy } = importProject(readZip(req.file.buffer), req.user.id);
  res.json({ id: project.id, name: project.person.name, copy });
}));
app.get("/api/projects/:id", wrap(async (req, res) => res.json(publicProject(P(req)))));

const PERSON_KEYS = Object.keys(emptyProject("x").person);
const SETTING_KEYS = ["tone", "quality", "shortSeconds", "longSeconds", "music", "burnCaptions", "includeArchival", "includeArt", "episodeCount", "episodeSeconds"];
/** A voice choice from the browser: a free voice, or one of the project owner's own copied voices. */
const cleanVoice = (v, owner) => {
  if (!v?.id) return null;
  const out = { provider: v.provider === "elevenlabs" ? "elevenlabs" : "edge", id: String(v.id).slice(0, 100), label: String(v.label || "").slice(0, 100), rate: Math.max(-30, Math.min(30, Math.round(Number(v.rate) || 0))), pitch: Math.max(-20, Math.min(20, Math.round(Number(v.pitch) || 0))) };
  if (!voiceAllowed(out, owner)) throw Object.assign(new Error("That voice belongs to another account."), { status: 403 });
  return out;
};
/** "How to say names": [{ word, say }] the voices read instead of the written spelling. */
const cleanPronounce = (list) =>
  (Array.isArray(list) ? list : [])
    .map((x) => ({ word: String(x?.word || "").trim().slice(0, 60), say: String(x?.say || "").trim().slice(0, 80) }))
    .filter((x) => x.word || x.say)
    .slice(0, 40);
const STORY_LIMITS = { about: 300, period: 100, place: 200, text: 60000, telling: 10, wording: 10 };

app.patch("/api/projects/:id", wrap(async (req, res) => {
  const p = P(req);
  const b = req.body || {};
  if (b.person) for (const k of PERSON_KEYS) if (k in b.person) p.person[k] = String(b.person[k] ?? "").slice(0, 5000);
  if (b.story && typeof b.story === "object") {
    for (const [k, max] of Object.entries(STORY_LIMITS)) if (k in b.story) p.story[k] = String(b.story[k] ?? "").slice(0, max);
    if (!["first", "third"].includes(p.story.telling)) p.story.telling = "first";
    if (!["keep", "polish", "notes"].includes(p.story.wording)) p.story.wording = "polish";
  }
  // documentary background: the maker ticks which researched events go into the film
  if (Array.isArray(b.researchPicks) && p.research) {
    const pick = Object.fromEntries(b.researchPicks.map((x) => [x.id, !!x.include]));
    for (const e of p.research.events) if (e.id in pick) e.include = pick[e.id];
  }
  if (b.settings) {
    for (const k of SETTING_KEYS) if (k in b.settings) p.settings[k] = b.settings[k];
    if ("pronounce" in b.settings) p.settings.pronounce = cleanPronounce(b.settings.pronounce);
    const owner = auth.getUser(p.ownerId);
    for (const k of ["voice", "storyVoice"]) if (k in b.settings) p.settings[k] = cleanVoice(b.settings[k], owner);
    // voices for translated films: { te: { voice, storyVoice } }; an empty choice means "automatic"
    if (b.settings.langVoices && typeof b.settings.langVoices === "object") {
      const lv = {};
      for (const [l, x] of Object.entries(b.settings.langVoices)) if (LANGS[l] && x) lv[l] = { voice: cleanVoice(x.voice, owner), storyVoice: cleanVoice(x.storyVoice, owner) };
      p.settings.langVoices = lv;
    }
    p.settings.shortSeconds = Math.max(30, Math.min(300, Number(p.settings.shortSeconds) || 90));
    p.settings.longSeconds = Math.max(120, Math.min(1800, Number(p.settings.longSeconds) || 360));
    p.settings.episodeCount = Math.max(0, Math.min(20, Math.round(Number(p.settings.episodeCount) || 0)));
    p.settings.episodeSeconds = Math.max(180, Math.min(1800, Number(p.settings.episodeSeconds) || 600));
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
      if ("illustration" in u) ph.illustration = !!u.illustration;
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
  // documentaries are mostly illustrated from memory; each picture can be switched to "real photo" after upload
  if (p.kind === "documentary") for (const a of added) a.illustration = true;
  p.photos.push(...added);
  saveProject(p);
  analyzePhotos(p, added);
  res.json({ project: publicProject(p), errors });
}));

/** Background AI look at newly added photos (description, caption, focal point). */
function analyzePhotos(p, added) {
  if (!added.length || !ai.aiConfigured() || !aiAllowed(p)) return;
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
  if (added.length && ai.aiConfigured() && aiAllowed(p)) {
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
  needAI(req);
  const p = P(req);
  const { questions } = await ai.nextQuestions(p, 6);
  for (const q of questions) p.interview.push({ id: newId(8), ...q, answer: "" });
  saveProject(p);
  res.json(publicProject(p));
}));

// ---------- history ----------
app.post("/api/projects/:id/context", wrap(async (req, res) => {
  needAI(req);
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

// ---------- documentaries: the maker's script and the background research ----------
const xmlText = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&");
/** Plain text of an uploaded script: .txt / .md as is, .docx paragraph by paragraph. */
function scriptText(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if ([".txt", ".md", ".text"].includes(ext)) return file.buffer.toString("utf8").replace(/^﻿/, "");
  if (ext === ".docx") {
    let xml;
    try {
      xml = readZip(file.buffer).find((e) => e.name === "word/document.xml")?.data?.toString("utf8");
    } catch {}
    if (!xml) throw Object.assign(new Error("That file isn't a Word .docx document."), { status: 400 });
    const body = xml.replace(/<w:tab\/>/g, "\t").replace(/<w:br[^>]*\/>/g, "\n").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "");
    return xmlText(body).replace(/\n{3,}/g, "\n\n").trim();
  }
  throw Object.assign(new Error("Upload the script as a Word (.docx) or text (.txt) file. For a PDF, copy its text and paste it in."), { status: 400 });
}

app.post("/api/projects/:id/story/file", upload.single("file"), wrap(async (req, res) => {
  const p = P(req);
  if (!req.file) throw Object.assign(new Error("No file"), { status: 400 });
  const text = scriptText(req.file).slice(0, STORY_LIMITS.text);
  if (!text.trim()) throw Object.assign(new Error("That file has no text in it."), { status: 400 });
  p.story.text = text;
  saveProject(p);
  res.json(publicProject(p));
}));

app.post("/api/projects/:id/research", wrap(async (req, res) => {
  needAI(req);
  const p = P(req);
  if (!p.story.text.trim()) throw Object.assign(new Error("Add your script first."), { status: 400 });
  if (busyWith(p, "research")) throw Object.assign(new Error("The research is already running."), { status: 409 });
  const job = startJob({ projectId: p.id, type: "research", label: "Researching the background" }, async ({ progress }) => {
    progress(0.1);
    const r = await ai.researchTopic(p);
    // keep the maker's earlier ticks for events that come back with the same title
    const was = Object.fromEntries((p.research?.events || []).map((e) => [e.title, e.include]));
    r.events = r.events.map((e) => ({ id: newId(6), ...e, include: was[e.title] ?? true }));
    p.research = { ...r, createdAt: new Date().toISOString() };
    saveProject(p);
  });
  res.json(jobView(job));
}));

// ---------- voices ----------
app.get("/api/voices", wrap(async (req, res) => res.json(await listVoices(req.user))));
app.get("/api/langs", (req, res) => res.json(Object.entries(LANGS).map(([code, l]) => ({ code, name: l.name, native: l.native }))));

app.post("/api/projects/:id/voice/cast", wrap(async (req, res) => {
  needAI(req);
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
  const { text, pronounce } = req.body || {};
  const voice = cleanVoice(req.body?.voice, req.user);
  if (!voice) throw Object.assign(new Error("voice required"), { status: 400 });
  const lang = LANGS[req.body?.lang] ? req.body.lang : "";
  const say = String(text || "This is the story of a remarkable life.").slice(0, 400);
  const f = path.join(previewDir, `${newId(10)}.mp3`);
  await synthesize(voice, lang ? say : spokenText(say, cleanPronounce(pronounce)), f, { lang });
  res.setHeader("Content-Type", "audio/mpeg");
  res.sendFile(f, () => fs.rm(f, { force: true }, () => {}));
}));

// ---------- your own voice (a copy made from your recordings, ElevenLabs) ----------
// Who may make one: admins, plus anyone named in OWN_VOICE_USERS or on a plan in OWN_VOICE_PLANS
// (comma lists). The ElevenLabs plan is shared, so this is off for everyone else by default.
const csvSet = (s) => new Set(String(s || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
const mayOwnVoice = (u) =>
  !!u && (usage.isAdmin(u) || csvSet(process.env.OWN_VOICE_USERS).has(u.username) || csvSet(process.env.OWN_VOICE_PLANS).has(String(usage.planOf(u)?.id || "").toLowerCase()));
const MAX_OWN_VOICES = 3;
const voiceDir = (u) => path.join(DATA_DIR, "voices", u.id);
/** What the maker says first, so every copied voice starts with its owner's permission on record. */
const consentLine = (name) => `My name is ${name || "…"}. This is my own voice, and I agree to BioPicker making a copy of it for my films.`;
const ownVoiceView = async (u) => ({
  ready: ownVoiceReady(),
  allowed: mayOwnVoice(u),
  max: MAX_OWN_VOICES,
  voices: (u.voices || []).map((v) => ({ id: v.id, name: v.name, at: v.at, seconds: v.seconds })),
  consent: consentLine(""),
  quota: usage.isAdmin(u) ? await ownVoiceQuota() : null,
});
async function forgetOwnVoices(u) {
  for (const v of u.voices || []) await deleteClonedVoice(v.id).catch((e) => console.error("[voice] delete", v.id, e.message));
  fs.rmSync(voiceDir(u), { recursive: true, force: true });
}

app.get("/api/my-voices", wrap(async (req, res) => res.json(await ownVoiceView(req.user))));

app.post("/api/my-voices", upload.array("sample", 3), wrap(async (req, res) => {
  const u = req.user;
  if (!ownVoiceReady()) throw Object.assign(new Error("Own voices aren't set up on this server yet."), { status: 503 });
  if (!mayOwnVoice(u)) throw Object.assign(new Error("Your own voice isn't part of your plan yet."), { status: 403 });
  if ((u.voices || []).length >= MAX_OWN_VOICES) throw Object.assign(new Error(`You can keep ${MAX_OWN_VOICES} voices. Delete one to make another.`), { status: 400 });
  if (req.body?.consent !== "yes") throw Object.assign(new Error("Tick the box to confirm this is your own voice."), { status: 400 });
  const name = String(req.body?.name || "").trim().slice(0, 60);
  if (!name) throw Object.assign(new Error("Give the voice a name, e.g. your own name."), { status: 400 });
  const files = (req.files || []).filter((f) => /^(audio|video)\//.test(f.mimetype) || /\.(mp3|m4a|wav|webm|ogg|aac|mp4|caf|flac)$/i.test(f.originalname));
  if (!files.length) throw Object.assign(new Error("Record or choose a recording of your voice."), { status: 400 });
  const id = newId(8);
  const dir = ensureDir(path.join(voiceDir(u), id));
  try {
    // every recording becomes a clean mono mp3 (phones record m4a/webm); at most 5 minutes in all is used
    const mp3s = [];
    let seconds = 0;
    for (const [i, f] of files.entries()) {
      const raw = path.join(dir, `raw${i}${path.extname(f.originalname).toLowerCase() || ".bin"}`);
      fs.writeFileSync(raw, f.buffer);
      const out = path.join(dir, `sample${i + 1}.mp3`);
      try {
        await ffmpeg(["-i", raw, "-vn", "-ac", "1", "-ar", "44100", "-t", String(Math.max(10, 300 - seconds)), "-b:a", "192k", out]);
      } catch {
        throw Object.assign(new Error(`“${f.originalname}” isn't a recording BioPicker can read.`), { status: 400 });
      } finally {
        fs.rmSync(raw, { force: true });
      }
      seconds += await probeDuration(out);
      mp3s.push(out);
      if (seconds >= 300) break;
    }
    if (seconds < 30) throw Object.assign(new Error(`That's ${Math.round(seconds)} seconds of speech. Record at least 30 seconds; one to two minutes works best.`), { status: 400 });
    const voiceId = await cloneVoice({ name: `BioPicker ${u.username} · ${name}`, files: mp3s, description: `Own voice of BioPicker account ${u.username}, made with their recorded consent.` });
    u.voices = [...(u.voices || []), { id: voiceId, name, at: new Date().toISOString(), seconds: Math.round(seconds), dir: id, consent: consentLine(name), ip: ip(req) }];
    auth.updateUser(u);
    res.json(await ownVoiceView(u));
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}));

app.delete("/api/my-voices/:vid", wrap(async (req, res) => {
  const u = req.user;
  const v = (u.voices || []).find((x) => x.id === req.params.vid);
  if (!v) throw Object.assign(new Error("That voice is already gone."), { status: 404 });
  await deleteClonedVoice(v.id);
  u.voices = u.voices.filter((x) => x !== v);
  auth.updateUser(u);
  if (v.dir) fs.rmSync(path.join(voiceDir(u), v.dir), { recursive: true, force: true });
  res.json(await ownVoiceView(u));
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
// versions: "short", "long", or a documentary-series episode "ep1".."ep20"
const checkVersion = (v) => {
  if (!VERSION_RE.test(v)) throw Object.assign(new Error("version must be short, long or ep1..ep20"), { status: 400 });
  return v;
};
const episodeOf = (p, v) => (baseOf(v).startsWith("ep") ? p.series?.episodes?.find((e) => e.n === Number(baseOf(v).slice(2))) || null : null);
const secondsFor = (p, v) => (baseOf(v) === "short" ? p.settings.shortSeconds : baseOf(v) === "long" ? p.settings.longSeconds : p.settings.episodeSeconds);
const busyWith = (p, type, version) => activeJobs(p.id).some((j) => j.type === type && (!version || j.version === version));

/** Writes (or rewrites) one version's script and finds its media. AI usage is charged to that version's level. */
const writeVersionScript = (p, version, opts) => usage.withUsage({ version }, () => writeVersionScriptNow(p, version, opts));
async function writeVersionScriptNow(p, version, { log, progress = () => {} }) {
  const episode = episodeOf(p, version);
  if (version.startsWith("ep") && !episode) throw new Error(`Episode ${version.slice(2)} isn't in the series plan.`);
  const secs = secondsFor(p, version);
  log(`Writing a ${p.settings.tone} script for ${versionLabel(version)}${episode ? ` "${episode.title}"` : ""} (~${Math.round(secs / 60)} min)…`);
  const doc = p.kind === "documentary";
  if (doc && !p.story.text.trim()) throw new Error("Add your script on the Your story step first.");
  const s = doc ? await ai.writeDocumentary(p, version, secs) : await ai.writeScript(p, version, secs, episode);
  if (doc) for (const sc of s.scenes) sc.voice = sc.voice === "story" && p.story.telling !== "third" ? "story" : "narrator";
  const { words } = ai.wordBudget(secs, p.settings.voice?.rate);
  const count = () => s.scenes.reduce((a, sc) => a + String(sc.narration).split(/\s+/).filter(Boolean).length, 0);
  // a documentary that keeps the maker's own sentences is never machine-shortened
  for (let pass = 0; pass < 2 && !ai.keepsWording(p) && count() > words * 1.1; pass++) {
    log(`Script has ${count()} words; tightening to ~${words}…`);
    await ai.tightenScript(s, words);
  }
  for (const sc of s.scenes) sc.id = newId(6);
  p.scripts[version] = { ...s, version, targetSeconds: secs, tone: p.settings.tone, createdAt: new Date().toISOString(), mediaResolvedAt: null };
  saveProject(p);
  progress(0.4);
  log("Finding public-domain footage, art and music…");
  await resolveMedia(p, version, log);
}

app.post("/api/projects/:id/scripts/:version", wrap(async (req, res) => {
  const p = P(req);
  const version = checkVersion(req.params.version);
  if (langOf(version)) throw Object.assign(new Error("A translated script is made from the English one: use Translate."), { status: 400 });
  needAI(req, { series: version.startsWith("ep") });
  if (version.startsWith("ep") && !episodeOf(p, version)) throw Object.assign(new Error("Plan the series first."), { status: 400 });
  if (busyWith(p, "script", version)) throw Object.assign(new Error(`${versionLabel(version)} is already being written.`), { status: 409 });
  const job = startJob({ projectId: p.id, type: "script", version, label: `Writing ${versionLabel(version)}` }, async ({ log, progress }) => {
    progress(0.05);
    await writeVersionScript(p, version, { log, progress });
    progress(1);
  });
  res.json(jobView(job));
}));

// ---------- documentary series ----------
app.post("/api/projects/:id/series/plan", wrap(async (req, res) => {
  needAI(req, { series: true });
  const p = P(req);
  if (!p.timeline.length && !p.interview.some((q) => q.answer)) throw Object.assign(new Error("Add some timeline events or interview answers first, so there is a story to split into episodes."), { status: 400 });
  if (busyWith(p, "series")) throw Object.assign(new Error("The series is already being planned."), { status: 409 });
  const job = startJob({ projectId: p.id, type: "series", label: "Planning the documentary series" }, async ({ log, progress }) => {
    const count = p.settings.episodeCount;
    log(`Planning ${count || "the right number of"} episodes of ~${Math.round(p.settings.episodeSeconds / 60)} min…`);
    progress(0.1);
    const plan = await ai.planSeries(p, count, p.settings.episodeSeconds);
    const episodes = plan.episodes.slice(0, 20).map((e, i) => ({ n: i + 1, title: e.title, logline: e.logline, from: e.from, to: e.to, eventIds: e.eventIds }));
    p.series = { title: plan.title, episodes, createdAt: new Date().toISOString() };
    saveProject(p);
    log(`Planned ${episodes.length} episodes: ${episodes.map((e) => e.title).join(" · ")}`);
    progress(1);
  });
  res.json(jobView(job));
}));

app.put("/api/projects/:id/series", wrap(async (req, res) => {
  const p = P(req);
  const b = req.body || {};
  if (!p.series) p.series = { title: "", episodes: [], createdAt: new Date().toISOString() };
  if ("title" in b) p.series.title = String(b.title || "").slice(0, 200);
  if (Array.isArray(b.episodes)) {
    // edit titles/loglines, or append/remove at the end (episode numbers stay stable for existing scripts)
    p.series.episodes = b.episodes.slice(0, 20).map((e, i) => {
      const o = p.series.episodes[i] || { eventIds: [], from: "", to: "" };
      return { ...o, n: i + 1, title: String(e.title ?? o.title ?? "").slice(0, 200), logline: String(e.logline ?? o.logline ?? "").slice(0, 1000), from: String(e.from ?? o.from ?? "").slice(0, 20), to: String(e.to ?? o.to ?? "").slice(0, 20) };
    });
    // scripts of removed episodes go too; their rendered films stay until deleted
    for (const v of Object.keys(p.scripts)) if (v.startsWith("ep") && Number(baseOf(v).slice(2)) > p.series.episodes.length) delete p.scripts[v];
  }
  saveProject(p);
  res.json(publicProject(p));
}));

app.post("/api/projects/:id/series/write-all", wrap(async (req, res) => {
  needAI(req, { series: true });
  const p = P(req);
  const eps = p.series?.episodes || [];
  const todo = eps.filter((e) => req.body?.all || !p.scripts[`ep${e.n}`]).map((e) => `ep${e.n}`);
  if (!todo.length) throw Object.assign(new Error(eps.length ? "Every episode already has a script." : "Plan the series first."), { status: 400 });
  if (busyWith(p, "script")) throw Object.assign(new Error("A script is already being written; try again when it finishes."), { status: 409 });
  const job = startJob({ projectId: p.id, type: "script", label: `Writing ${todo.length} episode script(s)` }, async ({ log, progress }) => {
    for (const [i, v] of todo.entries()) {
      await writeVersionScript(p, v, { log, progress: (x) => progress((i + x) / todo.length) });
      progress((i + 1) / todo.length);
    }
    log(`All ${todo.length} episode scripts written.`);
  });
  res.json(jobView(job));
}));

app.post("/api/projects/:id/series/render-all", wrap(async (req, res) => {
  const p = P(req);
  const todo = (p.series?.episodes || []).map((e) => `ep${e.n}`).filter((v) => p.scripts[v] && !busyWith(p, "render", v) && (req.body?.all || !p.renders[v]));
  if (!todo.length) throw Object.assign(new Error("No episodes to render: write the episode scripts first (already-rendered ones are skipped)."), { status: 400 });
  usage.checkRender(req.user, todo, activeRenders(req.user));
  res.json(todo.map((v) => renderJob(p, v)).map(jobView));
}));

// ---------- translation: the same film in another language ----------
app.post("/api/projects/:id/translate/:version", wrap(async (req, res) => {
  const p = P(req);
  const base = checkVersion(req.params.version);
  const lang = String(req.body?.lang || "");
  if (langOf(base)) throw Object.assign(new Error("Translate from the English script."), { status: 400 });
  if (!LANGS[lang]) throw Object.assign(new Error("Choose a language."), { status: 400 });
  if (!p.scripts[base]) throw Object.assign(new Error("Write the English script first."), { status: 400 });
  needAI(req, { series: base.startsWith("ep") });
  const target = langVersion(base, lang);
  if (busyWith(p, "translate", target) || busyWith(p, "script", base)) throw Object.assign(new Error(`${versionLabel(target)} is already being made.`), { status: 409 });
  const job = startJob({ projectId: p.id, type: "translate", version: target, label: `Translating into ${LANGS[lang].name}` }, ({ log, progress }) =>
    usage.withUsage({ version: target }, async () => {
      log(`Translating ${versionLabel(base)} into ${LANGS[lang].name} (${p.scripts[base].scenes.length} scenes)…`);
      progress(0.1);
      const copy = await translateScript(p, base, lang, { log });
      if (p.scripts[target]) snapshotProject(p, `Before translating ${versionLabel(base)} into ${LANGS[lang].name} again`);
      p.scripts[target] = copy;
      saveProject(p);
      log(`Done: ${versionLabel(target)} is ready to read and edit.`);
      progress(1);
    }));
  res.json(jobView(job));
}));

/** Queues one render. Its first step is the content check, so a held film costs no render time and no render from the plan. */
function renderJob(p, version) {
  return startJob({ projectId: p.id, type: "render", lane: "render", version, label: `Rendering ${versionLabel(version)}` }, async ({ log, progress }) => {
    await safety.checkFilm(p, version, {
      log,
      save: () => saveProject(p),
      onHeld: (c) => alerts.contentHeld({ projectId: p.id, name: p.person.name, owner: auth.getUser(p.ownerId)?.username, version: versionLabel(version), categories: c.categories, reason: c.reason }),
    });
    const owner = auth.getUser(p.ownerId);
    return renderFilm(p, version, { log, progress, voiceOk: (v) => voiceAllowed(v, owner) && (v.provider !== "elevenlabs" || ownVoiceReady()) });
  });
}

app.put("/api/projects/:id/scripts/:version", wrap(async (req, res) => {
  const p = P(req);
  const version = checkVersion(req.params.version);
  const cur = p.scripts[version];
  if (!cur) throw Object.assign(new Error("No script"), { status: 404 });
  const b = req.body || {};
  cur.updatedAt = new Date().toISOString();
  for (const k of ["title", "tagline"]) if (k in b) cur[k] = String(b[k] || "").slice(0, 300);
  if (Array.isArray(b.scenes)) {
    const old = Object.fromEntries(cur.scenes.map((s) => [s.id, s]));
    cur.scenes = b.scenes.map((s) => {
      const o = old[s.id] || { id: newId(6), visuals: [], kind: "life", transition: "fade", eventId: "" };
      const out = { ...o };
      for (const k of ["narration", "onScreenTitle", "onScreenSubtitle", "year", "place", "kind", "transition"]) if (k in s) out[k] = String(s[k] ?? "").slice(0, 4000);
      if ("voice" in s) out.voice = s.voice === "story" ? "story" : "narrator";
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
  const job = startJob({ projectId: p.id, type: "media", version, label: "Finding media" }, ({ log }) => resolveMedia(p, version, log));
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
  if (busyWith(p, "render", version)) throw Object.assign(new Error(`${versionLabel(version)} is already rendering or queued.`), { status: 409 });
  usage.checkRender(req.user, [version], activeRenders(req.user));
  res.json(jobView(renderJob(p, version)));
}));

// ---------- film versions (every render is kept until deleted) ----------
const filmOf = (p, fid) => {
  const f = p.films.find((x) => x.id === fid);
  if (!f) throw Object.assign(new Error("That film version no longer exists."), { status: 404 });
  return f;
};
app.patch("/api/projects/:id/films/:fid", wrap(async (req, res) => {
  const p = P(req);
  const f = filmOf(p, req.params.fid);
  if ("label" in (req.body || {})) f.label = String(req.body.label || "").slice(0, 120);
  saveProject(p);
  res.json(publicProject(p));
}));
app.delete("/api/projects/:id/films/:fid", wrap(async (req, res) => {
  const p = P(req);
  const f = filmOf(p, req.params.fid);
  p.films = p.films.filter((x) => x !== f);
  const stillUsed = new Set(p.films.flatMap((x) => [x.file, x.srt, x.vtt]));
  for (const file of [f.file, f.srt, f.vtt]) if (file && !stillUsed.has(file)) fs.rmSync(projectPath(p.id, "output", file), { force: true });
  syncRenders(p);
  saveProject(p);
  res.json(publicProject(p));
}));
/** Puts a film version's script back into the editor (the current script is kept as an undo point). */
app.post("/api/projects/:id/films/:fid/restore-script", wrap(async (req, res) => {
  const p = P(req);
  const f = filmOf(p, req.params.fid);
  if (!f.scriptSnapshot) throw Object.assign(new Error("This version was rendered before scripts were saved with films, so its script can't be restored."), { status: 400 });
  snapshotProject(p, `Before restoring the ${versionLabel(f.version)} v${f.n} script`);
  p.scripts[f.version] = { ...JSON.parse(JSON.stringify(f.scriptSnapshot)), restoredFrom: f.n, updatedAt: new Date().toISOString() };
  saveProject(p);
  res.json(publicProject(p));
}));

// ---------- Word round trip ----------
app.get("/api/projects/:id/word", wrap(async (req, res) => {
  const p = P(req);
  const slug = (p.person.name || "biopic").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "biopic";
  res.attachment(`biopicker-${slug}-${new Date().toLocaleDateString("en-CA")}.docx`);
  res.type("application/vnd.openxmlformats-officedocument.wordprocessingml.document").send(await buildDocx(p));
}));
app.post("/api/projects/:id/word", importUpload.single("doc"), wrap(async (req, res) => {
  const p = P(req);
  if (!req.file) throw Object.assign(new Error("Choose the edited Word document (.docx)."), { status: 400 });
  const tables = parseDocx(req.file.buffer);
  const undo = snapshotProject(p, `Before uploading ${req.file.originalname}`);
  const result = await applyDocx(p, tables, { ingest: (file) => ingestPhoto(p.id, file) });
  if (!result.changes.length) {
    fs.rmSync(projectPath(p.id, "history", undo.file), { force: true });
    return res.json({ project: publicProject(p), changes: [], warnings: result.warnings, undo: null });
  }
  saveProject(p);
  if (result.timelineChanged) geocodeTimeline(p);
  analyzePhotos(p, result.newPhotos);
  res.json({ project: publicProject(p), changes: result.changes, warnings: result.warnings, undo });
}));

// ---------- undo points ----------
app.get("/api/projects/:id/history", wrap(async (req, res) => res.json(listSnapshots(P(req).id))));
app.post("/api/projects/:id/history/:file/restore", wrap(async (req, res) => {
  const p = P(req);
  if (!listSnapshots(p.id).some((s) => s.file === req.params.file)) throw Object.assign(new Error("That undo point no longer exists."), { status: 404 });
  snapshotProject(p, "Before undo");
  restoreSnapshot(p, req.params.file);
  res.json(publicProject(p));
}));

app.get("/api/jobs/:jid", (req, res) => {
  const j = getJob(req.params.jid);
  let mine = false;
  try {
    mine = !!j && owns(req, loadProject(j.projectId));
  } catch {}
  if (!mine) return res.status(404).json({ error: "job not found" });
  res.json(jobView(j));
});

// ---------- admin panel: accounts, usage & cost, plans & paywall ----------
// Only accounts named in ADMIN_USERS (default: nkakarla). Everyone else gets 404, as if it didn't exist.
app.use("/api/admin", (req, res, next) => (usage.isAdmin(req.user) ? next() : res.status(404).json({ error: "Not found" })));

const MONTH_RE = /^\d{4}-\d{2}$/;
const monthParam = (req) => (MONTH_RE.test(String(req.query.month || "")) ? String(req.query.month) : req.query.month === "all" ? null : usage.thisMonth());
const byUser = () => {
  const m = new Map();
  for (const e of usage.allEvents()) {
    if (!m.has(e.userId)) m.set(e.userId, []);
    m.get(e.userId).push(e);
  }
  return m;
};
const lastAt = (list) => list.reduce((a, e) => (e.at > a ? e.at : a), "");
const accountUser = (id) => auth.getUser(id) || (() => { throw Object.assign(new Error("No such account."), { status: 404 }); })();

const placeText = (p) => visits.placeText(p);
const SOURCE_NAMES = { admin: "Set by admin", subscription: "Paying", waiting: "Waiting for a plan", default: "Free spot" };
function subText(s) {
  if (!s) return "";
  const end = s.periodEnd ? new Date(s.periodEnd).toISOString().slice(0, 10) : "";
  const prov = s.provider === "apple" ? `Apple${s.environment === "Sandbox" ? " (sandbox)" : ""}` : `Stripe${s.live === false ? " (test)" : ""}`;
  const refund = s.refund ? ` · refunded $${(s.refund.amountCents / 100).toFixed(2)}` : "";
  return `${prov} · ${s.status}${s.cancelAtPeriodEnd ? " · cancels" : ""}${end ? ` · ${end}` : ""}${refund}`;
}
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};
function accountRow(u, events, projects, month) {
  const plan = usage.planOf(u);
  const lim = usage.limitsOf(u);
  const inMonth = events.filter((e) => usage.monthOf(e.at) === (month || usage.thisMonth()));
  const m = usage.totals(inMonth);
  const all = usage.totals(events);
  return {
    id: u.id,
    username: u.username,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
    lastActivity: lastAt(events) || null,
    plan: plan.id,
    planName: plan.name,
    custom: !!(u.plan || (u.limits && Object.keys(u.limits).length)),
    source: usage.isAdmin(u) && usage.planSource(u) === "default" ? "Admin plan" : SOURCE_NAMES[usage.planSource(u)],
    payment: subText(u.sub),
    paying: !!usage.activeSub(u),
    signupPlace: placeText(u.signup?.place),
    signupCountry: u.signup?.place?.country || "",
    signupIp: u.signup?.ip || "",
    signupDevice: u.signup?.device || "",
    referrer: u.signup?.referrer ? hostOf(u.signup.referrer) : "",
    lastIp: u.lastSeen?.ip || u.logins?.[0]?.ip || "",
    lastPlace: placeText(u.lastSeen?.place || u.logins?.[0]?.place),
    lastDevice: u.lastSeen?.device || u.logins?.[0]?.device || "",
    lastSeenAt: u.lastSeen?.at || null,
    admin: usage.isAdmin(u),
    status: u.disabled ? "Turned off" : "Active",
    biopics: projects.length,
    films: projects.reduce((n, p) => n + p.films.length, 0),
    rendersMonth: m.renders,
    renderLimit: lim.rendersPerMonth,
    aiCostMonth: m.aiCost,
    aiBudget: lim.aiBudgetMonthly,
    aiCostTotal: all.aiCost,
    tokensTotal: all.tokensIn + all.tokensOut + all.cacheRead + all.cacheWrite,
    rendersTotal: all.renders,
    devices: (u.devices || []).length,
  };
}

app.get("/api/admin/overview", wrap(async (req, res) => {
  const month = monthParam(req);
  const events = usage.allEvents();
  const scoped = month ? events.filter((e) => usage.monthOf(e.at) === month) : events;
  const projects = allProjects();
  const users = auth.allUsers();
  const paying = users.filter((u) => usage.activeSub(u));
  const b = usage.getBilling();
  res.json({
    month: month || "all",
    thisMonth: usage.thisMonth(),
    since: events[0]?.at || null,
    model: ai.currentModel(),
    paying: { count: paying.length, monthly: paying.reduce((n, u) => n + (usage.planOf(u).priceMonthly || 0), 0) },
    freeSpots: { ...alerts.freeSpots(users), waiting: users.filter((u) => usage.planSource(u) === "waiting").length },
    totals: usage.totals(scoped),
    accounts: { total: users.length, turnedOff: users.filter((u) => u.disabled).length, activeInScope: new Set(scoped.map((e) => e.userId).filter(Boolean)).size },
    biopics: projects.length,
    byLevel: usage.groupTotals(scoped, (e) => e.level),
    byTask: usage.groupTotals(scoped.filter((e) => e.t === "ai"), (e) => e.task || "other"),
    byModel: usage.groupTotals(scoped.filter((e) => e.t === "ai"), (e) => e.model),
    byMonth: usage.groupTotals(events, (e) => usage.monthOf(e.at)).sort((a, b) => b.key.localeCompare(a.key)),
    unpriced: usage.unpricedModels(),
  });
}));

app.get("/api/admin/accounts", wrap(async (req, res) => {
  const month = monthParam(req);
  const ev = byUser();
  const projects = allProjects();
  res.json(auth.allUsers().map((u) => accountRow(u, ev.get(u.id) || [], projects.filter((p) => p.ownerId === u.id), month)));
}));

app.get("/api/admin/accounts/:uid", wrap(async (req, res) => {
  const u = accountUser(req.params.uid);
  const events = usage.allEvents().filter((e) => e.userId === u.id);
  const projects = allProjects().filter((p) => p.ownerId === u.id);
  const names = Object.fromEntries(projects.map((p) => [p.id, p.person.name || "Untitled"]));
  res.json({
    account: accountRow(u, events, projects, null),
    planChoice: u.plan || "",
    needsPlan: !!u.needsPlan,
    sub: u.sub ? { ...u.sub, text: subText(u.sub), active: !!usage.activeSub(u) } : null,
    signup: u.signup ? { ...u.signup, placeText: placeText(u.signup.place) } : null,
    logins: (u.logins || []).map((l) => ({ ...l, placeText: placeText(l.place) })),
    lastSeen: u.lastSeen ? { ...u.lastSeen, placeText: placeText(u.lastSeen.place) } : null,
    limits: u.limits || {},
    biopics: projects.map((p) => {
      const pe = events.filter((e) => e.projectId === p.id);
      const lv = Object.fromEntries(usage.LEVELS.map((l) => [l, usage.totals(pe.filter((e) => e.level === l))]));
      const t = usage.totals(pe);
      return {
        id: p.id, name: names[p.id], archived: !!p.archivedAt, public: !!p.public, films: p.films.length,
        aiCost: t.aiCost, tokens: t.tokensIn + t.tokensOut + t.cacheRead + t.cacheWrite, renders: t.renders, rendersFailed: t.rendersFailed,
        shortCost: lv.short.aiCost, longCost: lv.long.aiCost, episodeCost: lv.episode.aiCost, setupCost: lv.setup.aiCost,
        filmMinutes: t.filmSeconds / 60, renderMinutes: t.renderSeconds / 60,
        updatedAt: p.updatedAt,
      };
    }),
    byMonth: usage.groupTotals(events, (e) => usage.monthOf(e.at)).sort((a, b) => b.key.localeCompare(a.key)),
    // the most recent 500 events; the CSV export has everything
    events: events.slice(-500).reverse().map((e) => ({ ...e, biopic: names[e.projectId] || (e.projectId ? "(deleted)" : ""), cost: usage.costOf(e) })),
    plans: usage.getBilling().plans.map((p) => ({ id: p.id, name: p.name })),
  });
}));

app.patch("/api/admin/accounts/:uid", wrap(async (req, res) => {
  const u = accountUser(req.params.uid);
  const b = req.body || {};
  if ("plan" in b) {
    const plan = String(b.plan || "");
    if (plan && !usage.getBilling().plans.some((p) => p.id === plan)) throw Object.assign(new Error("Unknown plan."), { status: 400 });
    if (plan) u.plan = plan;
    else delete u.plan;
  }
  if (b.limits && typeof b.limits === "object") {
    // each limit is "plan" (use the plan's), "" (no limit) or a number
    const out = {};
    for (const k of ["rendersPerMonth", "aiBudgetMonthly"]) {
      const v = b.limits[k];
      if (v === undefined || v === "plan") continue;
      if (v === "" || v === null) out[k] = null;
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error("Limits must be a number of 0 or more, blank for no limit, or the plan's."), { status: 400 });
        out[k] = n;
      }
    }
    if (b.limits.series === true || b.limits.series === false) out.series = b.limits.series;
    u.limits = out;
  }
  if (b.needsPlan === false) delete u.needsPlan; // "give a free spot"
  if ("disabled" in b) {
    if (b.disabled && u.id === req.user.id) throw Object.assign(new Error("You can't turn off your own account."), { status: 400 });
    u.disabled = !!b.disabled;
  }
  auth.updateUser(u);
  res.json({ ok: true });
}));
// ---------- admin: what people are making (every biopic, private ones too; see the Privacy Policy) ----------
const ADMIN_VIEWS_FILE = path.join(DATA_DIR, "admin-views.jsonl");
function reportsByProject() {
  const out = {};
  try {
    for (const line of fs.readFileSync(REPORTS_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      (out[r.projectId] ||= []).push({ at: r.at, reason: r.reason, by: r.by || null });
    }
  } catch {}
  return out;
}
/** Every film a biopic has: the kept ones and the latest render of each version, newest first. */
function filmsOf(p) {
  const seen = new Set();
  return [...p.films, ...Object.values(p.renders || {})]
    .filter((f) => f?.file && !seen.has(f.file) && seen.add(f.file))
    .map((f) => ({ version: f.version, label: versionLabel(f.version), title: f.title || p.scripts[f.version]?.title || "", file: f.file, vtt: f.vtt || null, seconds: f.seconds || 0, at: f.at || null, quality: f.quality || "", kept: p.films.some((k) => k.file === f.file) }))
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
}
app.get("/api/admin/biopics", wrap(async (req, res) => {
  const users = Object.fromEntries(auth.allUsers().map((u) => [u.id, u.username]));
  const reports = reportsByProject();
  const cost = {};
  for (const e of usage.allEvents()) if (e.projectId) cost[e.projectId] = (cost[e.projectId] || 0) + usage.costOf(e);
  res.json(allProjects().map((p) => {
    const films = filmsOf(p);
    return {
      id: p.id,
      name: p.person.name || "Untitled",
      owner: users[p.ownerId] || "(no account)",
      ownerId: p.ownerId || null,
      kind: p.kind || "biopic",
      occupation: p.kind === "documentary" ? `Documentary${p.story?.about ? ": " + p.story.about : ""}` : p.person.occupation || "",
      born: p.person.born || "",
      died: p.person.died || "",
      language: p.person.language || "",
      tone: p.settings?.tone || "",
      photos: p.photos.length,
      documents: p.documents.length,
      films: films.length,
      filmMinutes: films.reduce((n, f) => n + f.seconds, 0) / 60,
      lastFilmAt: films[0]?.at || null,
      status: p.archivedAt ? "Archived" : p.public ? "Public" : "Private",
      reports: (reports[p.id] || []).length,
      check: safety.checkStatus(p),
      held: safety.pendingHolds(p).length,
      aiCost: cost[p.id] || 0,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }));
}));
app.get("/api/admin/biopics/:id", wrap(async (req, res) => {
  let p;
  try {
    p = loadProject(req.params.id);
  } catch {
    throw notFound();
  }
  // each look at someone's biopic is written down (who, when, whose)
  fs.appendFileSync(ADMIN_VIEWS_FILE, JSON.stringify({ at: new Date().toISOString(), admin: req.user.username, projectId: p.id, ownerId: p.ownerId || null }) + "\n");
  const owner = p.ownerId ? auth.getUser(p.ownerId) : null;
  const clip = (s, n = 4000) => String(s || "").slice(0, n);
  const placeName = (pl) => (typeof pl === "string" ? pl : pl?.name || pl?.display || [pl?.city, pl?.country].filter(Boolean).join(", ") || "");
  res.json({
    id: p.id,
    owner: owner ? { id: owner.id, username: owner.username } : null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    status: p.archivedAt ? "Archived" : p.public ? "Public" : "Private",
    publishedAt: p.publishedAt || null,
    person: Object.fromEntries(Object.entries(p.person).map(([k, v]) => [k, clip(v, 2000)])),
    kind: p.kind || "biopic",
    story: p.kind === "documentary" ? { ...p.story, text: clip(p.story?.text, 60000) } : null,
    settings: { tone: p.settings?.tone || "", quality: p.settings?.quality || "", music: p.settings?.music || "" },
    films: filmsOf(p),
    scripts: Object.entries(p.scripts || {}).map(([version, s]) => ({ version, label: versionLabel(version), title: s.title || "", tagline: s.tagline || "", scenes: (s.scenes || []).map((sc) => ({ year: sc.year || "", place: placeName(sc.place), title: sc.onScreenTitle || "", narration: clip(sc.narration, 2000) })) })),
    photos: p.photos.slice(0, 200).map((ph) => ({ file: ph.file, caption: clip(ph.caption, 300), date: ph.date || "", place: placeName(ph.place), include: ph.include !== false, concern: ph.ai?.concern || "" })),
    flaggedPhotos: p.photos.filter((ph) => ph.ai?.concern).length,
    photoCount: p.photos.length,
    documents: p.documents.map((d) => ({ name: d.name || "", summary: clip(d.summary, 1000) })),
    timeline: p.timeline.slice(0, 300).map((t) => ({ date: t.date || "", title: clip(t.title, 300), place: placeName(t.place), description: clip(t.description, 1000) })),
    interview: p.interview.filter((q) => q.answer).map((q) => ({ question: clip(q.question, 500), answer: clip(q.answer) })),
    reports: reportsByProject()[p.id] || [],
    checks: [...(p.safety?.checks || [])].reverse().slice(0, 30).map((c) => ({ ...c, label: versionLabel(c.version), pending: !!(c.result === "held" && !c.allowedBy && safety.pendingHolds(p).includes(c)) })),
  });
}));
// let a film the content check held be rendered (the maker then renders it again)
app.post("/api/admin/biopics/:id/checks/:cid/allow", wrap(async (req, res) => {
  let p;
  try {
    p = loadProject(req.params.id);
  } catch {
    throw notFound();
  }
  const c = safety.allow(p, req.params.cid, req.user.username);
  saveProject(p);
  fs.appendFileSync(ADMIN_VIEWS_FILE, JSON.stringify({ at: c.allowedAt, admin: req.user.username, projectId: p.id, ownerId: p.ownerId || null, action: "allowed", check: c.id, version: c.version }) + "\n");
  res.json({ ok: true });
}));
/** Admin banner lines for films waiting for review. */
function heldAlerts() {
  const held = allProjects().filter((p) => safety.pendingHolds(p).length);
  if (!held.length) return [];
  const names = held.slice(0, 3).map((p) => `“${p.person.name || "Untitled"}”`).join(", ") + (held.length > 3 ? ` and ${held.length - 3} more` : "");
  return [{ level: "warn", tab: "biopics", text: `${held.length === 1 ? "A film is" : `${held.length} biopics have films`} waiting for review after the content check: ${names}.` }];
}

// end a web subscription now and refund part of this month's payment (the admin chooses the amount)
app.get("/api/admin/accounts/:uid/refund", wrap(async (req, res) => res.json(await pay.refundQuote(accountUser(req.params.uid)))));
app.post("/api/admin/accounts/:uid/refund", wrap(async (req, res) => {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount)) throw Object.assign(new Error("Enter the refund as an amount, e.g. 6.07."), { status: 400 });
  res.json(await pay.refundAndEnd(accountUser(req.params.uid), { amountCents: Math.round(amount * 100) }));
}));

app.post("/api/admin/accounts", wrap(async (req, res) => {
  const u = auth.adminCreateUser(req.body?.username, req.body?.password);
  if (req.body?.plan) {
    u.plan = String(req.body.plan);
    auth.updateUser(u);
  }
  res.json({ id: u.id, username: u.username });
}));

app.post("/api/admin/accounts/:uid/password", wrap(async (req, res) => {
  auth.adminSetPassword(accountUser(req.params.uid), req.body?.password);
  res.json({ ok: true });
}));

app.get("/api/admin/billing", wrap(async (req, res) => {
  const seen = [...new Set(usage.allEvents().filter((e) => e.t === "ai").map((e) => e.model))];
  const users = auth.allUsers();
  res.json({
    billing: usage.getBilling(),
    model: ai.currentModel(),
    defaultModel: ai.defaultModel,
    modelsSeen: seen,
    payments: pay.status(),
    freeSpots: { ...alerts.freeSpots(users), waiting: users.filter((u) => usage.planSource(u) === "waiting").length },
    email: alerts.emailStatus(),
    webhooks: { stripe: `${origin(req)}/api/pay/stripe/webhook`, apple: `${origin(req)}/api/pay/apple/notifications` },
    geo: visits.geoReady(),
  });
}));
app.put("/api/admin/billing", wrap(async (req, res) => {
  const billing = usage.saveBilling(req.body || {});
  res.json({ billing });
  alerts.checkFreeSpots().catch(() => {}); // a lower warning level may already be reached
}));
app.get("/api/admin/alerts", wrap(async (req, res) => res.json({ alerts: [...alerts.adminAlerts(), ...heldAlerts()] })));
app.post("/api/admin/alerts/test", wrap(async (req, res) => res.json(await alerts.testEmail())));

const csvCell = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
app.get("/api/admin/usage.csv", wrap(async (req, res) => {
  const month = monthParam(req);
  const names = Object.fromEntries(allProjects().map((p) => [p.id, p.person.name || "Untitled"]));
  const users = Object.fromEntries(auth.allUsers().map((u) => [u.id, u.username]));
  const head = ["time", "account", "biopic", "version", "level", "kind", "task_or_status", "model", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd", "film_seconds", "render_seconds"];
  const rows = usage.allEvents().filter((e) => !month || usage.monthOf(e.at) === month).map((e) => [
    e.at, users[e.userId] || e.userId || "", names[e.projectId] || e.projectId || "", e.version || "", e.level, e.t === "ai" ? "ai" : "render",
    e.t === "ai" ? e.task : e.status, e.model || "", e.in ?? "", e.out ?? "", e.cr ?? "", e.cw ?? "", e.t === "ai" ? usage.costOf(e).toFixed(6) : "", e.filmSeconds ?? "", e.wallSeconds ?? "",
  ]);
  res.attachment(`biopicker-usage-${month || "all"}.csv`);
  res.type("text/csv").send([head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n");
}));

// ---------- project files ----------
const FILE_DIRS = new Set(["uploads", "thumbs", "media", "output", "docs", "music"]);
app.get("/files/:id/:dir/:file", (req, res) => {
  const { id, dir, file } = req.params;
  if (!FILE_DIRS.has(dir) || !/^[A-Za-z0-9._-]+$/.test(file)) return res.status(400).end();
  let f;
  try {
    const p = loadProject(id);
    // owners see everything; anyone may see a public biopic's films and photo thumbnails; admins may see any biopic's
    // films and thumbnails to review what is being made
    if (!owns(req, p) && !((p.public || usage.isAdmin(req.user)) && PUBLIC_DIRS.has(dir))) return res.status(404).end();
    f = projectPath(id, dir, file);
  } catch {
    return res.status(404).end();
  }
  if (!fs.existsSync(f)) return res.status(404).end();
  if (req.query.download) res.attachment(file);
  res.sendFile(f);
});

app.listen(PORT, HOST, () => {
  const unowned = allProjects().filter((p) => !p.ownerId).length;
  if (unowned) console.warn(`${unowned} biopic(s) from before accounts have no owner and are hidden. Assign them with: node scripts/admin.js claim <username>`);
  console.log(`BioPicker listening on http://${HOST}:${PORT} (AI ${ai.aiConfigured() ? "on" : "OFF"}, data ${DATA_DIR})`);
});
