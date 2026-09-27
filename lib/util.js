// BioPicker — shared helpers. Copyright (c) 2026 ePerf
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
export const USER_AGENT = "BioPicker/1.0 (+https://biopicker.eperflabs.com)";
export const COPYRIGHT = "© 2026 ePerf";

export const newId = (n = 10) => crypto.randomBytes(n).toString("base64url").replace(/[-_]/g, "x").slice(0, n);

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function run(cmd, args, { onStderr, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => {
      err += d;
      if (err.length > 200000) err = err.slice(-100000);
      onStderr?.(String(d));
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-1500)}`));
    });
  });
}

export const ffmpeg = (args, opts) => run(process.env.FFMPEG || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], opts);

export async function probeDuration(file) {
  const ua = /^https?:/.test(file) ? ["-user_agent", USER_AGENT] : [];
  const { out } = await run(process.env.FFPROBE || "ffprobe", [
    ...ua, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
  ], { timeoutMs: 60000 });
  const d = parseFloat(out.trim());
  return Number.isFinite(d) ? d : 0;
}

export async function probeVideo(file) {
  const { out } = await run(process.env.FFPROBE || "ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
    "-of", "json", file,
  ], { timeoutMs: 60000 });
  const j = JSON.parse(out);
  return {
    width: j.streams?.[0]?.width || 0,
    height: j.streams?.[0]?.height || 0,
    duration: parseFloat(j.format?.duration) || 0,
  };
}

export async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT, ...(opts.headers || {}) },
    });
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJSON(url, opts, ms) {
  const r = await fetchWithTimeout(url, opts, ms);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

export async function download(url, dest, ms = 120000, maxBytes = 400 * 1024 * 1024) {
  const r = await fetchWithTimeout(url, {}, ms);
  if (!r.ok) throw new Error(`HTTP ${r.status} downloading ${url}`);
  const len = Number(r.headers.get("content-length") || 0);
  if (len > maxBytes) throw new Error(`File too large (${len} bytes)`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`File too large (${buf.length} bytes)`);
  fs.writeFileSync(dest, buf);
  return dest;
}

export const xmlEscape = (s) =>
  String(s ?? "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

export function wrapText(text, maxChars) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > maxChars && line) {
      lines.push(line);
      line = w;
    } else line = (line + " " + w).trim();
  }
  if (line) lines.push(line);
  return lines;
}

export function yearOf(date) {
  const m = String(date || "").match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

export function sortByDate(a, b) {
  return String(a.date || "9999").localeCompare(String(b.date || "9999"));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
