// BioPicker — where sign-ups and sign-ins come from: IP address, approximate place and device.
// Copyright (c) 2026 EPerf
//
// Places come from the free DB-IP "IP to City Lite" database (CC BY 4.0, https://db-ip.com), kept on this
// server in DATA_DIR/geoip and refreshed monthly, so visitors' addresses are never sent to another service.
// Set GEOIP=off to skip the download (places then show as unknown).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { Reader } from "mmdb-lib";
import { DATA_DIR, USER_AGENT, ensureDir } from "./util.js";

const GEO_DIR = path.join(DATA_DIR, "geoip");
const GEO_FILE = path.join(GEO_DIR, "dbip-city-lite.mmdb");
const REFRESH_DAYS = 32;
const ENABLED = process.env.GEOIP !== "off";
let reader = null;

function openDb() {
  try {
    reader = new Reader(fs.readFileSync(GEO_FILE));
    console.log(`[geoip] place lookups on (${GEO_FILE})`);
  } catch {
    reader = null;
  }
}

const monthKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
/** Downloads this month's database (or last month's, early in a month before it's published). */
async function download() {
  ensureDir(GEO_DIR);
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  for (const m of [monthKey(now), monthKey(prev)]) {
    const url = `https://download.db-ip.com/free/dbip-city-lite-${m}.mmdb.gz`;
    const r = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!r.ok) continue;
    const tmp = `${GEO_FILE}.${process.pid}.tmp`;
    await pipeline(Readable.fromWeb(r.body), zlib.createGunzip(), fs.createWriteStream(tmp));
    new Reader(fs.readFileSync(tmp)); // throws if the file is not a valid database
    fs.renameSync(tmp, GEO_FILE);
    console.log(`[geoip] downloaded DB-IP City Lite ${m}`);
    return;
  }
  throw new Error("no DB-IP City Lite file found for this or last month");
}

async function refresh() {
  if (!ENABLED) return;
  let age = Infinity;
  try {
    age = (Date.now() - fs.statSync(GEO_FILE).mtimeMs) / 864e5;
  } catch {}
  if (age > REFRESH_DAYS) {
    try {
      await download();
    } catch (e) {
      console.error("[geoip] download failed, places stay unknown until the next try:", e.message);
    }
  }
  openDb();
}
if (ENABLED) {
  openDb();
  // first check shortly after start, then daily (the file itself is replaced about monthly)
  setTimeout(refresh, 5000).unref();
  setInterval(refresh, 864e5).unref();
}

const PRIVATE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i;
const cleanIp = (ip) => String(ip || "").replace(/^::ffff:/, "");

/** Approximate place for an IP: { city, region, country, countryCode } (fields may be empty), or null if unknown. */
export function placeOf(ip) {
  ip = cleanIp(ip);
  if (!ip || ip === "?") return null;
  if (PRIVATE.test(ip)) return { city: "", region: "", country: "Local network", countryCode: "" };
  if (!reader) return null;
  try {
    const r = reader.get(ip);
    if (!r) return null;
    return {
      city: r.city?.names?.en || "",
      region: r.subdivisions?.[0]?.names?.en || "",
      country: r.country?.names?.en || "",
      countryCode: r.country?.iso_code || "",
    };
  } catch {
    return null;
  }
}
export const placeText = (p) => (p ? [p.city, p.region, p.country].filter(Boolean).join(", ") : "");
export const geoReady = () => !!reader;

/** A short device description from the User-Agent: "iPhone app", "iPhone · Safari", "Windows · Chrome"… */
export function deviceOf(ua) {
  ua = String(ua || "");
  if (!ua) return "";
  const app = /BioPickerApp\//.test(ua);
  const os = /iPad/.test(ua) ? "iPad"
    : /iPhone|iPod/.test(ua) ? "iPhone"
    : /Android/.test(ua) ? "Android"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Windows/.test(ua) ? "Windows"
    : /Macintosh|Mac OS X/.test(ua) ? "Mac"
    : /Linux/.test(ua) ? "Linux"
    : "";
  // the iPhone app's web view says BioPickerApp (newer builds) or leaves out the "Safari/" token (older ones)
  if (app || ((os === "iPhone" || os === "iPad") && !/Safari\//.test(ua))) return `${os || "iPhone"} app`;
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /SamsungBrowser/.test(ua) ? "Samsung Internet"
    : /Firefox\/|FxiOS/.test(ua) ? "Firefox"
    : /Chrome\/|CriOS/.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : /bot|crawl|spider|curl|wget|python|node/i.test(ua) ? "Script or bot"
    : "Other browser";
  return os ? `${os} · ${browser}` : browser;
}

const clip = (s, n) => String(s || "").slice(0, n);
/** Everything recorded about one visit (a sign-up or sign-in). */
export function visit(req, extra = {}) {
  const ip = cleanIp(req.ip);
  const ua = req.get("user-agent") || "";
  return { at: new Date().toISOString(), ip, place: placeOf(ip), device: deviceOf(ua), ua: clip(ua, 300), ...extra };
}
/** The page that sent someone to BioPicker, from what the sign-up page passes along (external links only). */
export function referrerOf(body, req) {
  const ref = clip(body?.referrer, 300);
  if (!/^https?:\/\//i.test(ref)) return "";
  try {
    if (new URL(ref).host === req.get("host")) return "";
  } catch {
    return "";
  }
  return ref;
}
export const landingOf = (body) => (/^\/[^\s]{0,300}$/.test(String(body?.landing || "")) ? String(body.landing) : "");
