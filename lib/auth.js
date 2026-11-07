// BioPicker — accounts: username + password + authenticator-app 2FA (TOTP), recovery codes, sessions.
// Copyright (c) 2026 ePerf
//
// Users live in DATA_DIR/users.json and sessions in DATA_DIR/sessions.json (only token hashes are stored).
// Sign-up and sign-in always take two steps: password, then a 6-digit code from an authenticator app.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import { DATA_DIR, ensureDir, newId } from "./util.js";

ensureDir(DATA_DIR);
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
export const SESSION_COOKIE = "bp_s";
const SESSION_DAYS = 90;
const ISSUER = "BioPicker";

const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// ---------- storage ----------
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJSON(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const users = readJSON(USERS_FILE, {}); // id -> user
const sessions = readJSON(SESSIONS_FILE, {}); // sha256(token) -> { userId, exp, createdAt }
const saveUsers = () => writeJSON(USERS_FILE, users);
const saveSessions = () => writeJSON(SESSIONS_FILE, sessions);

export const getUser = (id) => users[id] || null;
export const findUser = (username) => Object.values(users).find((u) => u.username === normalizeUsername(username)) || null;
export const allUsers = () => Object.values(users);
export const publicUser = (u) => u && { id: u.id, username: u.username, createdAt: u.createdAt, recoveryCodesLeft: u.recoveryCodes.length };
export function updateUser(u) {
  users[u.id] = u;
  saveUsers();
}

// ---------- validation ----------
export const normalizeUsername = (s) => String(s || "").trim().toLowerCase();
function checkUsername(s) {
  const u = normalizeUsername(s);
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(u)) throw err(400, "Usernames are 3–32 characters: letters, numbers, dots, dashes or underscores.");
  return u;
}
function checkPassword(pw, username) {
  pw = String(pw || "");
  if (pw.length < 10) throw err(400, "Use a password of at least 10 characters.");
  if (pw.length > 200) throw err(400, "That password is too long.");
  if (pw.toLowerCase().includes(username)) throw err(400, "Your password can't contain your username.");
  return pw;
}

// ---------- passwords (scrypt) ----------
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
function verifyPassword(pw, stored) {
  const [, salt, key] = String(stored || "").split("$");
  if (!salt || !key) return false;
  const want = Buffer.from(key, "base64");
  const got = crypto.scryptSync(String(pw || ""), Buffer.from(salt, "base64"), want.length, SCRYPT);
  return crypto.timingSafeEqual(want, got);
}
// spend the same time on unknown usernames so response timing doesn't reveal which exist
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString("hex"));

// ---------- TOTP (RFC 6238: SHA-1, 6 digits, 30 s) ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(buf) {
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  let bits = 0, value = 0;
  const out = [];
  for (const c of String(s).replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export function totp(secret, step = Math.floor(Date.now() / 30000)) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac("sha1", unbase32(secret)).update(msg).digest();
  const o = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}
/** Returns the matched time step (±1 step of clock drift), or null. */
function matchTotp(secret, code, notBefore = -1) {
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const now = Math.floor(Date.now() / 30000);
  for (const step of [now, now - 1, now + 1]) {
    if (step <= notBefore) continue; // each code works once
    if (crypto.timingSafeEqual(Buffer.from(totp(secret, step)), Buffer.from(c))) return step;
  }
  return null;
}

// ---------- recovery codes ----------
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const normCode = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function newRecoveryCodes() {
  const plain = Array.from({ length: 10 }, () => {
    const s = base32(crypto.randomBytes(5)).toLowerCase(); // 8 chars
    return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
  });
  return { plain, hashed: plain.map((c) => sha256(normCode(c))) };
}
function useRecoveryCode(u, code) {
  const h = sha256(normCode(code));
  const i = u.recoveryCodes.indexOf(h);
  if (i < 0) return false;
  u.recoveryCodes.splice(i, 1);
  return true;
}

/** Second factor: a fresh authenticator code, or one of the recovery codes (used up). */
function checkSecondFactor(u, code) {
  const step = matchTotp(u.totpSecret, code, u.lastTotpStep ?? -1);
  if (step != null) {
    u.lastTotpStep = step;
    return "totp";
  }
  if (normCode(code).length === 8 && useRecoveryCode(u, code)) return "recovery";
  return null;
}

// ---------- rate limiting (in memory) ----------
const failures = new Map(); // key -> [timestamps]
const WINDOW = 15 * 60 * 1000;
function limited(keys, max = 10) {
  const now = Date.now();
  for (const k of keys) {
    const list = (failures.get(k) || []).filter((t) => now - t < WINDOW);
    failures.set(k, list);
    if (list.length >= max) throw err(429, "Too many attempts. Wait 15 minutes and try again.");
  }
}
function fail(keys) {
  for (const k of keys) failures.set(k, [...(failures.get(k) || []), Date.now()]);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of failures) if (!list.some((t) => now - t < WINDOW)) failures.delete(k);
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
  let changed = false;
  for (const [k, s] of Object.entries(sessions)) if (s.exp < now) (delete sessions[k]), (changed = true);
  if (changed) saveSessions();
}, 60 * 1000).unref();

// ---------- pending steps (enrolment and sign-in challenges), short-lived, in memory ----------
const pending = new Map(); // token -> { kind: "enroll" | "challenge", ..., exp, tries }
function putPending(data, minutes) {
  const token = crypto.randomBytes(24).toString("base64url");
  pending.set(token, { ...data, exp: Date.now() + minutes * 60000, tries: 0 });
  return token;
}
function takePending(token, kind) {
  const p = pending.get(String(token || ""));
  if (!p || p.kind !== kind || p.exp < Date.now()) throw err(400, "This step expired. Start again.", { restart: true });
  if (++p.tries > 5) {
    pending.delete(token);
    throw err(429, "Too many wrong codes. Start again.", { restart: true });
  }
  return p;
}

async function enrolment(username, data) {
  const secret = base32(crypto.randomBytes(20));
  const label = encodeURIComponent(`${ISSUER}:${username}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${ISSUER}&algorithm=SHA1&digits=6&period=30`;
  const qr = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
  const token = putPending({ kind: "enroll", username, secret, ...data }, 15);
  return { enroll: token, uri, secret: secret.replace(/(.{4})/g, "$1 ").trim(), qr };
}

// ---------- sessions ----------
export function createSession(u) {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions[sha256(token)] = { userId: u.id, createdAt: Date.now(), exp: Date.now() + SESSION_DAYS * 86400000 };
  saveSessions();
  return token;
}
export function sessionUser(token) {
  if (!token) return null;
  const s = sessions[sha256(token)];
  if (!s || s.exp < Date.now()) return null;
  return users[s.userId] || null;
}
export function endSession(token) {
  if (token && sessions[sha256(token)]) {
    delete sessions[sha256(token)];
    saveSessions();
  }
}
/** Signs the user out everywhere, except (optionally) the session that asked. */
function endAllSessions(userId, keepToken) {
  const keep = keepToken ? sha256(keepToken) : null;
  for (const [k, s] of Object.entries(sessions)) if (s.userId === userId && k !== keep) delete sessions[k];
  saveSessions();
}
export function sessionCookie(token, secure, maxAgeSeconds = SESSION_DAYS * 86400) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}
export const readSessionToken = (cookieHeader) =>
  (String(cookieHeader || "").split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`)) || "").slice(SESSION_COOKIE.length + 1) || null;

// ---------- flows ----------
export const signupsOpen = () => process.env.SIGNUPS !== "closed";

/** Step 1 of sign-up: checks the name and password, returns an authenticator enrolment. Nothing is saved yet. */
export async function startSignup({ username, password, agree }, ip) {
  if (!signupsOpen()) throw err(403, "New accounts are not being accepted right now.");
  limited([`signup:${ip}`], 20);
  const name = checkUsername(username);
  checkPassword(password, name);
  if (!agree) throw err(400, "Please agree to the Terms and Privacy Policy to create an account.");
  if (findUser(name)) {
    fail([`signup:${ip}`]);
    throw err(409, "That username is taken. Try another.");
  }
  return enrolment(name, { passwordHash: hashPassword(password), agreedAt: new Date().toISOString() });
}

/** Last step of sign-up (and of setting up a new authenticator): proves the app is set up, then signs in. */
export function finishEnrolment({ enroll, code }) {
  const p = takePending(enroll, "enroll");
  const step = matchTotp(p.secret, code);
  if (step == null) throw err(400, "That code didn't match. Check the time on your phone and try the newest code.");
  pending.delete(enroll);
  let u;
  if (p.userId) {
    u = users[p.userId];
    if (!u) throw err(404, "Account not found.");
  } else {
    if (findUser(p.username)) throw err(409, "That username was just taken. Start again with another.", { restart: true });
    u = { id: newId(12), username: p.username, passwordHash: p.passwordHash, createdAt: new Date().toISOString(), agreedAt: p.agreedAt, devices: [] };
  }
  const codes = newRecoveryCodes();
  Object.assign(u, { totpSecret: p.secret, lastTotpStep: step, recoveryCodes: codes.hashed, totpSetAt: new Date().toISOString() });
  updateUser(u);
  return { user: u, recoveryCodes: codes.plain };
}

/** Step 1 of sign-in. Returns a challenge for the 6-digit code (or an enrolment if an admin reset 2FA). */
export async function startLogin({ username, password }, ip) {
  const name = normalizeUsername(username);
  limited([`login:${ip}`, `login-user:${name}`]);
  const u = findUser(name);
  const ok = verifyPassword(password, u ? u.passwordHash : DUMMY_HASH) && !!u;
  if (!ok) {
    fail([`login:${ip}`, `login-user:${name}`]);
    throw err(401, "Wrong username or password.");
  }
  if (!u.totpSecret) return enrolment(u.username, { userId: u.id });
  return { challenge: putPending({ kind: "challenge", userId: u.id }, 5) };
}

/** Step 2 of sign-in. */
export function finishLogin({ challenge, code }, ip) {
  limited([`code:${ip}`], 20);
  const p = takePending(challenge, "challenge");
  const u = users[p.userId];
  const how = u && checkSecondFactor(u, code);
  if (!how) {
    fail([`code:${ip}`]);
    throw err(401, "That code didn't match. Use the newest code from your authenticator app, or a recovery code.");
  }
  pending.delete(challenge);
  updateUser(u);
  return { user: u, usedRecoveryCode: how === "recovery" };
}

/** Forgot password: a recovery code proves who you are; you choose a new password and are signed in. */
export function recoverAccount({ username, recoveryCode, newPassword }, ip) {
  const name = normalizeUsername(username);
  limited([`recover:${ip}`, `recover-user:${name}`], 5);
  const u = findUser(name);
  if (!u || !useRecoveryCode(u, recoveryCode)) {
    fail([`recover:${ip}`, `recover-user:${name}`]);
    throw err(401, "That username and recovery code don't match.");
  }
  u.passwordHash = hashPassword(checkPassword(newPassword, u.username));
  updateUser(u);
  endAllSessions(u.id);
  return { user: u };
}

/** Re-checks password + code before a sensitive account change. */
export function reauth(u, { password, code }, ip) {
  limited([`reauth:${u.id}`, `reauth-ip:${ip}`], 8);
  if (!verifyPassword(password, u.passwordHash) || !checkSecondFactor(u, code)) {
    fail([`reauth:${u.id}`, `reauth-ip:${ip}`]);
    throw err(401, "Your password or code didn't match.");
  }
  updateUser(u);
}

export function changePassword(u, body, ip, keepToken) {
  const pw = checkPassword(body.newPassword, u.username);
  reauth(u, body, ip);
  u.passwordHash = hashPassword(pw);
  updateUser(u);
  endAllSessions(u.id, keepToken);
}

export async function startNewAuthenticator(u, body, ip) {
  reauth(u, body, ip);
  return enrolment(u.username, { userId: u.id });
}

export function regenerateRecoveryCodes(u, body, ip) {
  reauth(u, body, ip);
  const codes = newRecoveryCodes();
  u.recoveryCodes = codes.hashed;
  updateUser(u);
  return codes.plain;
}

export function deleteUser(u) {
  endAllSessions(u.id);
  delete users[u.id];
  saveUsers();
}

/** Admin: forces a new authenticator set-up at the next sign-in (password still required). */
export function resetTwoFactor(u) {
  Object.assign(u, { totpSecret: null, recoveryCodes: [], lastTotpStep: -1 });
  updateUser(u);
  endAllSessions(u.id);
}

// ---------- push-notification devices ----------
export function addDevice(u, token, environment) {
  if (!/^[0-9a-f]{64,200}$/i.test(String(token || ""))) throw err(400, "Bad device token.");
  const env = environment === "development" ? "development" : "production";
  // a device belongs to whoever signed in on it last
  for (const other of Object.values(users)) if (other.devices?.some((d) => d.token === token)) other.devices = other.devices.filter((d) => d.token !== token);
  u.devices = [...(u.devices || []), { token, env, at: new Date().toISOString() }].slice(-10);
  saveUsers();
}
export function removeDevice(token) {
  let changed = false;
  for (const u of Object.values(users)) {
    const before = u.devices?.length || 0;
    u.devices = (u.devices || []).filter((d) => d.token !== token);
    if (u.devices.length !== before) changed = true;
  }
  if (changed) saveUsers();
}
