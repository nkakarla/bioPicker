// BioPicker — geocoding via OpenStreetMap Nominatim (throttled + cached). Copyright (c) 2026 ePerf
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, fetchJSON, sleep } from "./util.js";

const CACHE_FILE = path.join(DATA_DIR, "geocache.json");
let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
} catch {}
const persist = () => {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch {}
};

// Nominatim's usage policy allows at most one request per second.
let chain = Promise.resolve();
function throttled(fn) {
  const next = chain.then(async () => {
    try {
      return await fn();
    } finally {
      await sleep(1100);
    }
  });
  chain = next.catch(() => {});
  return next;
}

export async function geocode(place) {
  const key = "f:" + String(place || "").trim().toLowerCase();
  if (!place?.trim()) return null;
  if (key in cache) return cache[key];
  const res = await throttled(() =>
    fetchJSON(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(place)}`),
  ).catch(() => null);
  const hit = res?.[0] ? { lat: +res[0].lat, lon: +res[0].lon, label: res[0].display_name } : null;
  cache[key] = hit;
  persist();
  return hit;
}

export async function reverseGeocode(lat, lon) {
  const key = `r:${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (key in cache) return cache[key];
  const res = await throttled(() =>
    fetchJSON(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&lat=${lat}&lon=${lon}`),
  ).catch(() => null);
  let label = null;
  if (res?.address) {
    const a = res.address;
    label = [a.city || a.town || a.village || a.county, a.state, a.country].filter(Boolean).join(", ");
  }
  cache[key] = label;
  persist();
  return label;
}
