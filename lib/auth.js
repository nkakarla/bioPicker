// BioPicker — accounts: username + password, sessions, iPhone push devices.
// Copyright (c) 2026 ePerf
//
// Users live in DATA_DIR/users.json and sessions in DATA_DIR/sessions.json (only token hashes are stored).
// Forgotten passwords are reset by whoever runs the server: node scripts/admin.js reset-password <user> <pw>.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDir, newId } from "./util.js";

ensureDir(DATA_DIR);
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
export const SESSION_COOKIE = "bp_s";
const SESSION_DAYS = 90;

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
export const publicUser = (u) => u && { id: u.id, username: u.username, createdAt: u.createdAt };
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
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

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
  let changed = false;
  for (const [k, s] of Object.entries(sessions)) if (s.exp < now) (delete sessions[k]), (changed = true);
  if (changed) saveSessions();
}, 60 * 1000).unref();

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

/** Sign-up: checks the name and password, creates the account. The caller signs it in. */
export function signup({ username, password, agree }, ip) {
  if (!signupsOpen()) throw err(403, "New accounts are not being accepted right now.");
  limited([`signup:${ip}`], 20);
  const name = checkUsername(username);
  checkPassword(password, name);
  if (!agree) throw err(400, "Please agree to the Terms and Privacy Policy to create an account.");
  if (findUser(name)) {
    fail([`signup:${ip}`]);
    throw err(409, "That username is taken. Try another.");
  }
  const u = { id: newId(12), username: name, passwordHash: hashPassword(password), createdAt: new Date().toISOString(), agreedAt: new Date().toISOString(), devices: [] };
  updateUser(u);
  return u;
}

/** Sign-in with username and password. */
export function login({ username, password }, ip) {
  const name = normalizeUsername(username);
  limited([`login:${ip}`, `login-user:${name}`]);
  const u = findUser(name);
  const ok = verifyPassword(password, u ? u.passwordHash : DUMMY_HASH) && !!u;
  if (!ok) {
    fail([`login:${ip}`, `login-user:${name}`]);
    throw err(401, "Wrong username or password.");
  }
  return u;
}

/** Admin: creates an account. Skips the sign-up password rules so the standard default/demo logins can be created. */
export function adminCreateUser(username, password) {
  const name = checkUsername(username);
  if (findUser(name)) throw err(409, `An account named “${name}” already exists.`);
  if (!String(password || "")) throw err(400, "A password is required.");
  const u = { id: newId(12), username: name, passwordHash: hashPassword(String(password)), createdAt: new Date().toISOString(), agreedAt: null, devices: [] };
  updateUser(u);
  return u;
}

/** Admin: sets a new password for someone who forgot theirs and signs them out everywhere. */
export function adminSetPassword(u, password) {
  if (!String(password || "")) throw err(400, "A password is required.");
  u.passwordHash = hashPassword(String(password));
  updateUser(u);
  endAllSessions(u.id);
}

/** Re-checks the password before a sensitive account change. */
export function reauth(u, { password }, ip) {
  limited([`reauth:${u.id}`, `reauth-ip:${ip}`], 8);
  if (!verifyPassword(password, u.passwordHash)) {
    fail([`reauth:${u.id}`, `reauth-ip:${ip}`]);
    throw err(401, "Your current password didn't match.");
  }
}

export function changePassword(u, body, ip, keepToken) {
  const pw = checkPassword(body.newPassword, u.username);
  reauth(u, body, ip);
  u.passwordHash = hashPassword(pw);
  updateUser(u);
  endAllSessions(u.id, keepToken);
}

export function deleteUser(u) {
  endAllSessions(u.id);
  delete users[u.id];
  saveUsers();
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
