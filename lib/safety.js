// BioPicker — content check before a film is rendered, against the content rules in the Terms.
// The script, on-screen text and the photos it uses are read by Claude; a clear breach holds the render
// until an admin allows it (admin panel → Biopics). Without an AI key the check is skipped ("simulated").
// Copyright (c) 2026 EPerf
import crypto from "node:crypto";
import * as ai from "./ai.js";
import { newId } from "./util.js";

// bump when the rules or the prompt change, so films are checked again under the new rules
const RULES_VERSION = 1;
const KEEP = 60;

const placeName = (pl) => (typeof pl === "string" ? pl : pl?.name || pl?.display || [pl?.city, pl?.country].filter(Boolean).join(", ") || "");

/** The text the check reads for one film version, and the photos it uses. */
export function filmMaterial(p, version) {
  const s = p.scripts[version];
  if (!s) throw new Error("No script for this version.");
  const photoIds = new Set();
  const lines = [
    "## THE PERSON",
    `Name: ${p.person.name || ""}`,
    p.person.claimToFame ? `Known for: ${p.person.claimToFame}` : "",
    p.person.occupation ? `Occupation: ${p.person.occupation}` : "",
    `Tone chosen: ${p.settings?.tone || "serious"}`,
    "",
    "## THE FILM'S SCRIPT",
    `Title: ${s.title || ""}`,
    s.tagline ? `Tagline: ${s.tagline}` : "",
  ];
  for (const [i, sc] of (s.scenes || []).entries()) {
    const head = [sc.year, placeName(sc.place), sc.onScreenTitle, sc.onScreenSubtitle].filter(Boolean).join(" | ");
    lines.push("", `Scene ${i + 1}${head ? ` (${head})` : ""}`, `Narration: ${sc.narration || ""}`);
    for (const v of sc.visuals || []) {
      if (v.type === "photo") photoIds.add(v.ref);
      else lines.push(`Shows ${v.type}: ${v.ref || ""}${v.caption ? ` — caption "${v.caption}"` : ""}`);
    }
  }
  const photos = p.photos.filter((ph) => photoIds.has(ph.id));
  lines.push("", "## PHOTOS IN THE FILM (the maker's caption, then an automatic description)");
  if (!photos.length) lines.push("(none)");
  for (const ph of photos) {
    lines.push(`- ${ph.caption || ph.originalName || ph.id}${ph.ai?.description ? ` — ${ph.ai.description}` : ""}${ph.ai?.concern ? ` — FLAGGED WHEN UPLOADED: ${ph.ai.concern}` : ""}`);
  }
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  const hash = crypto.createHash("sha256").update(`${RULES_VERSION}\n${text}`).digest("hex").slice(0, 32);
  return { text, hash, photoIds: photos.map((ph) => ph.id), flaggedPhotos: photos.filter((ph) => ph.ai?.concern).map((ph) => ph.id) };
}

const checksOf = (p) => (p.safety ||= { checks: [] }).checks;

/** The newest check of each version, when it is held and not yet allowed (a newer check of changed content replaces it). */
export function pendingHolds(p) {
  const latest = {};
  for (const c of p.safety?.checks || []) latest[c.version] = c; // checks are oldest first
  return Object.values(latest).filter((c) => c.result === "held" && !c.allowedBy);
}

/** One line for the admin list: Held, Allowed, Passed, Skipped or Not checked. */
export function checkStatus(p) {
  const checks = p.safety?.checks || [];
  if (pendingHolds(p).length) return "Held";
  const last = checks[checks.length - 1];
  if (!last) return "Not checked";
  return last.result === "held" ? "Allowed" : last.result === "passed" ? "Passed" : "Skipped";
}

/** What the film's maker sees: why a version is waiting (no reviewer notes). */
export function heldForOwner(p) {
  return Object.fromEntries(pendingHolds(p).map((c) => [c.version, { at: c.at, reason: c.reason }]));
}

export const heldMessage = (reason) =>
  `This film is waiting for a quick review before it's made, because it may break BioPicker's content rules${reason ? `: ${reason}` : "."} ` +
  "Someone at EPerf will look at it soon; if it's fine, you'll be able to render it. This didn't use up a render. Questions: support@eperf.com";

/**
 * Checks one film version before it renders. Returns the check; throws an error with .held = true when the film is held.
 * onHeld(check) is called once for each new hold (to tell the admin). Failures of the checker itself let the render go ahead.
 */
export async function checkFilm(p, version, { log = () => {}, onHeld = () => {}, save = () => {} } = {}) {
  const m = filmMaterial(p, version);
  const checks = checksOf(p);
  const prior = [...checks].reverse().find((c) => c.hash === m.hash && c.result !== "skipped");
  if (prior?.result === "passed") {
    log("Content check: this script passed before.");
    return prior;
  }
  if (prior?.result === "held") {
    if (prior.allowedBy) {
      log("Content check: allowed after review.");
      return prior;
    }
    throw Object.assign(new Error(heldMessage(prior.reason)), { held: true, check: prior });
  }
  const c = { id: newId(8), at: new Date().toISOString(), version, hash: m.hash, result: "passed", categories: [], reason: "", notes: "", photoIds: m.flaggedPhotos };
  const record = () => {
    checks.push(c);
    if (checks.length > KEEP) checks.splice(0, checks.length - KEEP);
    save();
  };
  if (!ai.aiConfigured()) {
    console.log(`[safety] content check simulated (no AI key) for ${p.id} ${version}`);
    log("Content check skipped (simulated: AI isn't set up on this server).");
    c.result = "skipped";
    c.notes = "simulated: no AI key";
    record();
    return c;
  }
  log("Checking the script against BioPicker's content rules…");
  try {
    const r = await ai.reviewContent(m.text);
    c.model = ai.currentModel();
    c.notes = String(r.notes || "").slice(0, 1000);
    if (r.hold) {
      c.result = "held";
      c.categories = (r.categories || []).map((x) => String(x).toLowerCase().trim()).filter((x) => ai.CONTENT_CATEGORIES.includes(x));
      if (!c.categories.length) c.categories = ["other"];
      c.reason = String(r.reason || "").slice(0, 600);
    }
  } catch (e) {
    if (e.refusal) {
      // the checker wouldn't even read it: treat it as a hold for a person to look at
      c.result = "held";
      c.categories = ["other"];
      c.reason = "The automatic check couldn't review this material.";
    } else {
      console.error(`[safety] check failed for ${p.id} ${version}: ${e.message}`);
      log(`Content check couldn't run (${e.message}); rendering anyway.`);
      c.result = "skipped";
      c.notes = `checker error: ${e.message}`.slice(0, 300);
      record();
      return c;
    }
  }
  record();
  if (c.result === "held") {
    console.warn(`[safety] held ${p.id} ${version} [${c.categories.join(",")}]: ${c.reason}`);
    try {
      await onHeld(c);
    } catch (e) {
      console.error("[safety] onHeld", e);
    }
    throw Object.assign(new Error(heldMessage(c.reason)), { held: true, check: c });
  }
  log("Content check passed.");
  return c;
}

/** An admin lets a held film be rendered. */
export function allow(p, checkId, admin) {
  const c = (p.safety?.checks || []).find((x) => x.id === checkId);
  if (!c || c.result !== "held") throw Object.assign(new Error("That check isn't waiting for review."), { status: 404 });
  c.allowedBy = admin;
  c.allowedAt = new Date().toISOString();
  return c;
}
