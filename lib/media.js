// BioPicker — public-domain media search & download.
// Sources: NASA Image & Video Library, Wikimedia Commons (PD/CC0 only), Internet Archive (public-domain
// licence only), Art Institute of Chicago (is_public_domain) and The Met Open Access (isPublicDomain).
// Copyright (c) 2026 ePerf
import fs from "node:fs";
import sharp from "sharp";
import { USER_AGENT, download, fetchJSON, ffmpeg, probeDuration, sleep } from "./util.js";

const PD_RE = /(public domain|^pd\b|^pd-|cc0|no restrictions|no known copyright)/i;
const clean = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 200);

// ---------------- Wikimedia Commons ----------------
async function commonsSearch(query, filetype, extra = {}) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `${query} filetype:${filetype}`,
    gsrnamespace: "6",
    gsrlimit: "15",
    ...extra,
  });
  const j = await fetchJSON(`https://commons.wikimedia.org/w/api.php?${params}`).catch(() => null);
  return Object.values(j?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
}

function commonsLicense(info) {
  const m = info?.extmetadata || {};
  return {
    license: clean(m.LicenseShortName?.value) || "",
    artist: clean(m.Artist?.value),
    date: clean(m.DateTimeOriginal?.value).slice(0, 40),
  };
}

async function commonsVideos(query) {
  const pages = await commonsSearch(query, "video", {
    prop: "videoinfo",
    viprop: "url|size|mime|extmetadata|derivatives",
    viurlwidth: "320",
  });
  const out = [];
  for (const p of pages) {
    const v = p.videoinfo?.[0];
    if (!v) continue;
    const lic = commonsLicense(v);
    if (!PD_RE.test(lic.license)) continue;
    const ders = (v.derivatives || []).filter((d) => d.transcodekey && /webm|mov|mp4/.test(d.transcodekey));
    const best =
      ders.filter((d) => d.height <= 720).sort((a, b) => b.height - a.height)[0] ||
      (v.derivatives || [])[0];
    out.push({
      kind: "video",
      source: "Wikimedia Commons",
      title: p.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, ""),
      date: lic.date,
      url: best?.src || v.url,
      pageUrl: v.descriptionurl,
      thumb: v.thumburl || "",
      license: lic.license,
      credit: lic.artist || "Wikimedia Commons",
    });
  }
  return out;
}

async function commonsImages(query) {
  const pages = await commonsSearch(query, "bitmap", {
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: "2400",
  });
  const out = [];
  for (const p of pages) {
    const v = p.imageinfo?.[0];
    if (!v) continue;
    const lic = commonsLicense(v);
    if (!PD_RE.test(lic.license)) continue;
    if ((v.width || 0) < 600) continue;
    out.push({
      kind: "image",
      source: "Wikimedia Commons",
      title: p.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, ""),
      date: lic.date,
      url: v.thumburl || v.url,
      pageUrl: v.descriptionurl,
      thumb: (v.thumburl || v.url || "").replace(/\/2400px-/, "/320px-"),
      license: lic.license,
      credit: lic.artist || "Wikimedia Commons",
    });
  }
  return out;
}

async function commonsAudio(query) {
  const pages = await commonsSearch(query, "audio", { prop: "imageinfo", iiprop: "url|size|mime|extmetadata" });
  const out = [];
  for (const p of pages) {
    const v = p.imageinfo?.[0];
    if (!v || /midi/.test(v.mime) || v.size < 200000) continue;
    const lic = commonsLicense(v);
    if (!PD_RE.test(lic.license)) continue;
    out.push({
      kind: "audio",
      source: "Wikimedia Commons",
      title: p.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, ""),
      date: lic.date,
      url: v.url,
      pageUrl: v.descriptionurl,
      thumb: "",
      license: lic.license,
      credit: lic.artist || "Wikimedia Commons",
    });
  }
  return out;
}

// ---------------- Internet Archive ----------------
async function archiveVideos(query) {
  const q = `(${query}) AND mediatype:movies AND licenseurl:*publicdomain*`;
  const url =
    `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}` +
    `&fl[]=identifier&fl[]=title&fl[]=year&fl[]=licenseurl&rows=8&output=json`;
  const j = await fetchJSON(url).catch(() => null);
  return (j?.response?.docs || []).map((d) => ({
    kind: "video",
    source: "Internet Archive",
    title: clean([].concat(d.title)[0]),
    date: d.year ? String(d.year) : "",
    url: null,
    archiveId: d.identifier,
    pageUrl: `https://archive.org/details/${d.identifier}`,
    thumb: `https://archive.org/services/img/${d.identifier}`,
    license: "Public domain",
    credit: "Internet Archive",
  }));
}

async function resolveArchive(id) {
  const j = await fetchJSON(`https://archive.org/metadata/${encodeURIComponent(id)}`);
  const vids = (j.files || []).filter((f) => /\.mp4$/i.test(f.name) && Number(f.size) > 300000);
  vids.sort((a, b) => Number(a.size) - Number(b.size));
  const pick = vids.find((f) => /512kb|h\.264/i.test(f.format)) || vids[0];
  if (!pick) throw new Error("no mp4 in archive item");
  return `https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(pick.name)}`;
}

// ---------------- NASA ----------------
async function nasaVideos(query) {
  const j = await fetchJSON(
    `https://images-api.nasa.gov/search?media_type=video&q=${encodeURIComponent(query)}`,
  ).catch(() => null);
  return (j?.collection?.items || []).slice(0, 8).map((it) => ({
    kind: "video",
    source: "NASA",
    title: clean(it.data?.[0]?.title),
    date: String(it.data?.[0]?.date_created || "").slice(0, 10),
    url: null,
    nasaCollection: it.href,
    pageUrl: `https://images.nasa.gov/details/${encodeURIComponent(it.data?.[0]?.nasa_id || "")}`,
    thumb: it.links?.[0]?.href || "",
    license: "Public domain (NASA)",
    credit: "NASA",
  }));
}

async function resolveNasa(collectionUrl) {
  const files = await fetchJSON(collectionUrl);
  const pref = ["~medium.mp4", "~small.mp4", "~mobile.mp4", "~preview.mp4", "~orig.mp4"];
  for (const suffix of pref) {
    const f = files.find((u) => u.endsWith(suffix));
    if (f) return f.replace(/^http:/, "https:").replace(/ /g, "%20");
  }
  throw new Error("no NASA mp4");
}

// ---------------- Museums ----------------
async function aicArt(query) {
  const url =
    `https://api.artic.edu/api/v1/artworks/search?q=${encodeURIComponent(query)}` +
    `&query[term][is_public_domain]=true&fields=id,title,image_id,artist_title,date_display&limit=8`;
  const j = await fetchJSON(url).catch(() => null);
  return (j?.data || [])
    .filter((d) => d.image_id)
    .map((d) => ({
      kind: "image",
      source: "Art Institute of Chicago",
      title: clean(d.title),
      date: clean(d.date_display),
      url: `https://www.artic.edu/iiif/2/${d.image_id}/full/1686,/0/default.jpg`,
      pageUrl: `https://www.artic.edu/artworks/${d.id}`,
      thumb: `https://www.artic.edu/iiif/2/${d.image_id}/full/400,/0/default.jpg`,
      license: "Public domain (CC0)",
      credit: d.artist_title || "Art Institute of Chicago",
    }));
}

async function metArt(query) {
  const s = await fetchJSON(
    `https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&q=${encodeURIComponent(query)}`,
  ).catch(() => null);
  const ids = (s?.objectIDs || []).slice(0, 8);
  const objs = await Promise.all(
    ids.map((id) => fetchJSON(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`).catch(() => null)),
  );
  return objs
    .filter((o) => o?.isPublicDomain && o.primaryImage)
    .map((o) => ({
      kind: "image",
      source: "The Metropolitan Museum of Art",
      title: clean(o.title),
      date: clean(o.objectDate),
      url: o.primaryImage,
      pageUrl: o.objectURL,
      thumb: o.primaryImageSmall,
      license: "Public domain (CC0)",
      credit: o.artistDisplayName || "The Met",
    }));
}

// ---------------- public API ----------------
const settle = async (ps) => (await Promise.allSettled(ps)).flatMap((r) => (r.status === "fulfilled" ? r.value : []));

export async function searchMedia(type, query) {
  if (!query?.trim()) return [];
  switch (type) {
    case "archival": {
      const [nasa, commons, archive] = await Promise.all([
        nasaVideos(query).catch(() => []),
        commonsVideos(query).catch(() => []),
        archiveVideos(query).catch(() => []),
      ]);
      // interleave so every source gets a chance in the top picks
      const out = [];
      for (let i = 0; i < 8; i++) for (const l of [commons, archive, nasa]) if (l[i]) out.push(l[i]);
      return out;
    }
    case "still":
      return settle([commonsImages(query)]);
    case "art": {
      const [a, m] = await Promise.all([aicArt(query).catch(() => []), metArt(query).catch(() => [])]);
      const out = [];
      for (let i = 0; i < 8; i++) for (const l of [a, m]) if (l[i]) out.push(l[i]);
      return out;
    }
    case "music":
      return settle([commonsAudio(query)]);
    default:
      return [];
  }
}

export async function resolveUrl(c) {
  if (c.url) return c.url;
  if (c.archiveId) return (c.url = await resolveArchive(c.archiveId));
  if (c.nasaCollection) return (c.url = await resolveNasa(c.nasaCollection));
  throw new Error("candidate has no URL");
}

// Download a clip of at most maxSec seconds (skipping the usual title-card opening), normalised to 1280x720.
export async function fetchVideoClip(c, dest, maxSec = 24) {
  const url = await resolveUrl(c);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let dur = 0;
      try {
        dur = await probeDuration(url);
      } catch {}
      const len = dur ? Math.min(maxSec, dur) : maxSec;
      const start = dur > len + 4 ? Math.min(dur * 0.2, dur - len - 1) : 0;
      await ffmpeg(
        [
          "-user_agent", USER_AGENT, "-ss", start.toFixed(2), "-t", len.toFixed(2), "-i", url, "-an",
          "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", dest,
        ],
        { timeoutMs: 6 * 60 * 1000 },
      );
      if ((await probeDuration(dest)) < 1.5) throw new Error("clip too short");
      return dest;
    } catch (e) {
      lastErr = e;
      if (!/429|Too Many Requests|timed out|Connection reset/i.test(e.message)) break;
      await sleep(4000 * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function fetchImage(c, dest) {
  const url = await resolveUrl(c);
  const tmp = dest + ".dl";
  await download(url, tmp, 120000, 80 * 1024 * 1024);
  await sharp(tmp, { failOn: "none", limitInputPixels: 400e6 })
    .rotate()
    .resize({ width: 3200, height: 3200, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#000" })
    .jpeg({ quality: 90 })
    .toFile(dest);
  fs.rmSync(tmp, { force: true });
  return dest;
}

export async function fetchAudio(c, dest) {
  const url = await resolveUrl(c);
  const tmp = dest + ".dl";
  await download(url, tmp, 180000, 150 * 1024 * 1024);
  await ffmpeg(["-i", tmp, "-vn", "-ac", "2", "-ar", "44100", "-b:a", "192k", dest], { timeoutMs: 5 * 60 * 1000 });
  fs.rmSync(tmp, { force: true });
  return dest;
}
