// BioPicker — geocoding via OpenStreetMap Nominatim (throttled + cached). Copyright (c) 2026 EPerf
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

// A town's name often also belongs to villages, canals or roads (e.g. "Ferozepur" is a village near Chandigarh
// as well as the city, which OpenStreetMap spells Firozpur). Prefer cities and towns among the top results.
const placeScore = (r) =>
  (+r.importance || 0) +
  (r.class === "place" && ["city", "town"].includes(r.type) ? 0.25 : 0) +
  (r.class === "boundary" && r.type === "administrative" ? 0.05 : 0);

export async function geocode(place) {
  const key = "f2:" + String(place || "").trim().toLowerCase();
  if (!place?.trim()) return null;
  if (key in cache) return cache[key];
  const res = await throttled(() =>
    fetchJSON(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(place)}`),
  ).catch(() => null);
  const best = Array.isArray(res) && res.length ? [...res].sort((a, b) => placeScore(b) - placeScore(a))[0] : null;
  const hit = best ? { lat: +best.lat, lon: +best.lon, label: best.display_name } : null;
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
