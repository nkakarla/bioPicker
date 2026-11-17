// Admin alerts: free spots running out (email + admin panel banner), and people turned away when they are full.
// Email goes out over SMTP (e.g. Gmail with an app password). Without SMTP_HOST the email is logged as "simulated".
import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import * as auth from "./auth.js";
import * as usage from "./usage.js";
import { DATA_DIR } from "./util.js";

const STATE_FILE = path.join(DATA_DIR, "alerts.json");
const SMTP = {
  host: process.env.SMTP_HOST || "",
  port: Number(process.env.SMTP_PORT || 587),
  user: process.env.SMTP_USER || "",
  pass: process.env.SMTP_PASS || "",
  from: process.env.EMAIL_FROM || "",
};
const mailer = SMTP.host
  ? nodemailer.createTransport({ host: SMTP.host, port: SMTP.port, secure: SMTP.port === 465, auth: SMTP.user ? { user: SMTP.user, pass: SMTP.pass } : undefined })
  : null;
const SITE = (process.env.PUBLIC_URL || "https://biopicker.eperflabs.com").replace(/\/+$/, "");

let state = { notifiedCount: 0, awayDay: "", awayCount: 0, awayEmailed: "", log: [] };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
} catch {}
function saveState() {
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}
const today = () => new Date().toISOString().slice(0, 10);

export function emailStatus() {
  return { ready: !!mailer, from: SMTP.from || SMTP.user || "", host: SMTP.host, log: state.log.slice(-10).reverse() };
}

/** Sends one email to the admin. Never throws: failures are logged and kept for the admin panel. */
export async function sendEmail(to, subject, text) {
  const entry = { at: new Date().toISOString(), to, subject };
  if (!to) entry.result = "no alert email address set";
  else if (!mailer) {
    entry.result = "simulated (SMTP not set up)";
    console.log(`[alert] email simulated (SMTP_HOST not set) to ${to}: ${subject}`);
  } else {
    try {
      await mailer.sendMail({ from: SMTP.from || SMTP.user, to, subject, text });
      entry.result = "sent";
      console.log(`[alert] emailed ${to}: ${subject}`);
    } catch (e) {
      entry.result = `failed: ${e.message}`.slice(0, 300);
      console.error(`[alert] email to ${to} failed: ${e.message}`);
    }
  }
  state.log = [...state.log, entry].slice(-30);
  saveState();
  return entry;
}

/** Free-spot numbers and whether they're at the warning level. */
export function freeSpots(users = auth.allUsers()) {
  const s = usage.getBilling().signups;
  const used = usage.freeAccounts(users).length;
  return {
    used,
    max: s.freeMax,
    alertAt: s.alertAt ?? null,
    warning: s.alertAt != null && used >= s.alertAt,
    full: s.freeMax != null && used >= s.freeMax,
    turnedAwayToday: state.awayDay === today() ? state.awayCount : 0,
  };
}

/** Banner lines for the admin panel. */
export function adminAlerts() {
  const f = freeSpots();
  const s = usage.getBilling().signups;
  const out = [];
  if (f.full) {
    const away = f.turnedAwayToday ? ` ${f.turnedAwayToday} ${f.turnedAwayToday === 1 ? "person was" : "people were"} turned away today.` : "";
    out.push({ level: "warn", tab: "plans", text: `All ${f.max} free spots are used. ${s.whenFull === "paid" ? "New accounts must choose a paid plan." : "New sign-ups are stopped."}${away}` });
  } else if (f.warning) {
    out.push({ level: "warn", tab: "plans", text: f.max != null ? `${f.used} of ${f.max} free spots are used (${f.max - f.used} left).` : `${f.used} free accounts are in use (no cap set).` });
  }
  return out;
}

const describe = (u) => {
  if (!u) return "";
  const su = u.signup || {};
  const place = su.place ? [su.place.city, su.place.region, su.place.country].filter(Boolean).join(", ") : "";
  return `Newest account: ${u.username}${place ? `, from ${place}` : ""}${su.device ? ` (${su.device})` : ""}.`;
};

/** After an account is added or the settings change: email once per new free account at or above the warning level. */
export async function checkFreeSpots(newUser = null) {
  const s = usage.getBilling().signups;
  const f = freeSpots();
  if (!f.warning) {
    if (state.notifiedCount) {
      state.notifiedCount = 0; // dropped below the level: warn again next time it's reached
      saveState();
    }
    return null;
  }
  if (f.used <= (state.notifiedCount || 0)) return null;
  state.notifiedCount = f.used;
  saveState();
  const subject = f.full ? `BioPicker: all ${f.max} free spots are used` : f.max != null ? `BioPicker: ${f.used} of ${f.max} free spots used` : `BioPicker: ${f.used} free accounts`;
  const next = f.full
    ? s.whenFull === "paid" ? "New accounts can still sign up, but must choose a paid plan." : "New sign-ups are now stopped, and people see your \"free spots are full\" message."
    : f.max != null ? `${f.max - f.used} left. When all ${f.max} are used, ${s.whenFull === "paid" ? "new accounts must choose a paid plan" : "new sign-ups stop"}.` : "There's no cap on free accounts.";
  const text = [
    `${f.max != null ? `${f.used} of ${f.max}` : f.used} free accounts on BioPicker are now in use (you asked to hear from ${f.alertAt}).`,
    describe(newUser),
    next,
    "",
    `Change the cap or the warning level: ${SITE}/admin.html?tab=plans`,
    `See the accounts: ${SITE}/admin.html?tab=accounts`,
  ].filter((l) => l !== "").join("\n");
  return sendEmail(s.alertEmail, subject, text);
}

/** Someone was refused because the free spots are full: counted per day, emailed at most once a day. */
export async function turnedAway() {
  const d = today();
  if (state.awayDay !== d) {
    state.awayDay = d;
    state.awayCount = 0;
  }
  state.awayCount++;
  saveState();
  if (state.awayEmailed === d) return null;
  state.awayEmailed = d;
  saveState();
  const s = usage.getBilling().signups;
  return sendEmail(s.alertEmail, "BioPicker: someone couldn't sign up (free spots full)",
    `Someone tried to create a BioPicker account today, but all ${s.freeMax} free spots are used, so they saw your message instead.\n` +
    `You'll get at most one of these emails a day; the admin panel shows how many were turned away.\n\n` +
    `Raise the cap, or let people sign up and pay: ${SITE}/admin.html?tab=plans`);
}

/** A film was held by the content check: email the admin (every new hold; a held film isn't re-checked until it changes). */
export async function contentHeld({ projectId, name, owner, version, categories, reason }) {
  const s = usage.getBilling().signups;
  return sendEmail(s.alertEmail, `BioPicker: a film is waiting for review (${categories.join(", ")})`,
    `The content check held a film before it was rendered.\n\n` +
    `Biopic: ${name || "Untitled"} (${version})\nAccount: ${owner || "(none)"}\nWhy: ${reason || "(no reason given)"}\n\n` +
    `Look at it, and allow it if it's fine: ${SITE}/admin.html?tab=biopic&id=${encodeURIComponent(projectId)}`);
}

export async function testEmail() {
  const s = usage.getBilling().signups;
  if (!s.alertEmail) throw Object.assign(new Error("Enter the alert email address and save first."), { status: 400 });
  const f = freeSpots();
  return sendEmail(s.alertEmail, "BioPicker: test alert",
    `This is a test from the BioPicker admin panel. Alerts about free spots will come to this address.\n\n` +
    `Free spots in use now: ${f.used}${f.max != null ? ` of ${f.max}` : ""}. You'll be emailed from ${f.alertAt ?? "(not set)"}.\n${SITE}/admin.html?tab=plans`);
}

// a periodic look, so a warning missed while email was down (or reached by an admin change) still goes out
setInterval(() => checkFreeSpots().catch(() => {}), 60 * 60 * 1000).unref();
setTimeout(() => checkFreeSpots().catch(() => {}), 10_000).unref();
