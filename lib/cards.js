// BioPicker — generated visuals: Ken Burns canvases, title/text/credit cards, lower thirds, maps.
// Copyright (c) 2026 EPerf
import fs from "node:fs";
import { createRequire } from "node:module";
import sharp from "sharp";
import { feature } from "topojson-client";
import { COPYRIGHT, wrapText, xmlEscape } from "./util.js";

const SERIF = "Georgia, 'DejaVu Serif', 'Liberation Serif', serif";
const SANS = "'Segoe UI', 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif";
export const KB_SCALE = 2.5; // Ken Burns source canvases are rendered this much larger than the output

const svgBuf = (w, h, body) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);

// Fit any picture into a 16:9 canvas: cover when close to 16:9, otherwise contain over a blurred copy.
export async function prepareStill(src, dest, W, H) {
  const meta = await sharp(src).metadata();
  const ar = (meta.width || 1) / (meta.height || 1);
  const target = W / H;
  if (Math.abs(ar / target - 1) < 0.18) {
    await sharp(src).resize(W, H, { fit: "cover", position: "attention" }).jpeg({ quality: 90 }).toFile(dest);
    return dest;
  }
  const bg = await sharp(src).resize(Math.round(W / 8), Math.round(H / 8), { fit: "cover" }).blur(6).modulate({ brightness: 0.55 }).toBuffer();
  const bgBig = await sharp(bg).resize(W, H).toBuffer();
  const fg = await sharp(src).resize(Math.round(W * 0.94), Math.round(H * 0.94), { fit: "inside" }).toBuffer();
  await sharp(bgBig).composite([{ input: fg, gravity: "centre" }]).jpeg({ quality: 90 }).toFile(dest);
  return dest;
}

async function backdrop(bgSrc, W, H, darken = 0.35) {
  if (bgSrc && fs.existsSync(bgSrc)) {
    return sharp(bgSrc).resize(Math.round(W / 6), Math.round(H / 6), { fit: "cover" }).blur(4)
      .modulate({ brightness: darken }).resize(W, H).toBuffer();
  }
  return sharp(svgBuf(W, H, `<defs><radialGradient id="g" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#2b2419"/><stop offset="1" stop-color="#0c0a07"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/>`)).png().toBuffer();
}

export async function titleCard({ name, years, tagline, bgSrc }, dest, W, H) {
  const s = W / 1280;
  const bg = await backdrop(bgSrc, W, H, 0.4);
  const nameLines = wrapText(name, 22);
  const tag = wrapText(tagline, 60).slice(0, 2);
  let y = H / 2 - (nameLines.length * 70 * s) / 2;
  let body = "";
  for (const l of nameLines) {
    body += `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="${SERIF}" font-size="${72 * s}" fill="#f6ead0">${xmlEscape(l)}</text>`;
    y += 80 * s;
  }
  body += `<line x1="${W / 2 - 120 * s}" x2="${W / 2 + 120 * s}" y1="${y - 30 * s}" y2="${y - 30 * s}" stroke="#c9a25f" stroke-width="${2 * s}"/>`;
  body += `<text x="${W / 2}" y="${y + 20 * s}" text-anchor="middle" font-family="${SANS}" font-size="${30 * s}" letter-spacing="${6 * s}" fill="#e7c989">${xmlEscape(years)}</text>`;
  y += 80 * s;
  for (const l of tag) {
    body += `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="${SERIF}" font-style="italic" font-size="${30 * s}" fill="#efe6d4">${xmlEscape(l)}</text>`;
    y += 42 * s;
  }
  await sharp(bg).composite([{ input: svgBuf(W, H, body) }]).jpeg({ quality: 92 }).toFile(dest);
  return dest;
}

export async function textCard({ kicker, heading, body, bgSrc }, dest, W, H) {
  const s = W / 1280;
  const bg = await backdrop(bgSrc, W, H, 0.3);
  const hLines = wrapText(heading, 34).slice(0, 3);
  const bLines = wrapText(body, 62).slice(0, 6);
  const total = (kicker ? 50 : 0) + hLines.length * 62 + 30 + bLines.length * 44;
  let y = H / 2 - (total * s) / 2 + 40 * s;
  let svg = "";
  if (kicker) {
    svg += `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="${SANS}" font-size="${24 * s}" letter-spacing="${6 * s}" fill="#e7c989">${xmlEscape(kicker.toUpperCase())}</text>`;
    y += 60 * s;
  }
  for (const l of hLines) {
    svg += `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="${SERIF}" font-size="${52 * s}" fill="#f6ead0">${xmlEscape(l)}</text>`;
    y += 62 * s;
  }
  y += 20 * s;
  for (const l of bLines) {
    svg += `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="${SANS}" font-size="${28 * s}" fill="#e9e2d4">${xmlEscape(l)}</text>`;
    y += 44 * s;
  }
  await sharp(bg).composite([{ input: svgBuf(W, H, svg) }]).jpeg({ quality: 92 }).toFile(dest);
  return dest;
}

export async function creditsCard({ heading, lines }, dest, W, H) {
  const s = W / 1280;
  const bg = await backdrop(null, W, H);
  let y = 90 * s;
  let svg = `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="${SERIF}" font-size="${40 * s}" fill="#f6ead0">${xmlEscape(heading)}</text>`;
  y += 60 * s;
  for (const l of lines) {
    const bold = l.startsWith("## ");
    const text = bold ? l.slice(3) : l;
    svg += `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="${bold ? SANS : SERIF}" font-size="${(bold ? 20 : 22) * s}" ${bold ? `letter-spacing="${4 * s}" fill="#e7c989"` : 'fill="#e9e2d4"'}>${xmlEscape(text.slice(0, 110))}</text>`;
    y += (bold ? 32 : 28) * s;
  }
  svg += `<text x="${W / 2}" y="${H - 50 * s}" text-anchor="middle" font-family="${SANS}" font-size="${22 * s}" letter-spacing="${3 * s}" fill="#c9a25f">${xmlEscape(COPYRIGHT)} · BioPicker</text>`;
  await sharp(bg).composite([{ input: svgBuf(W, H, svg) }]).jpeg({ quality: 92 }).toFile(dest);
  return dest;
}

// Transparent overlay: year / place bar in the lower left.
export async function lowerThird({ title, subtitle }, dest, W, H) {
  const s = W / 1280;
  const t = String(title || "").slice(0, 48);
  const st = String(subtitle || "").slice(0, 70);
  const w = Math.max(t.length * 24, st.length * 13, 160) * s + 60 * s;
  const x = 56 * s;
  const y = H - 150 * s;
  const svg =
    `<defs><linearGradient id="lg" x1="0" x2="1"><stop offset="0" stop-color="#0b0906" stop-opacity="0.78"/><stop offset="1" stop-color="#0b0906" stop-opacity="0"/></linearGradient></defs>` +
    `<rect x="${x - 20 * s}" y="${y - 50 * s}" width="${w + 120 * s}" height="${110 * s}" fill="url(#lg)"/>` +
    `<rect x="${x - 20 * s}" y="${y - 50 * s}" width="${4 * s}" height="${110 * s}" fill="#c9a25f"/>` +
    `<text x="${x}" y="${y}" font-family="${SERIF}" font-size="${40 * s}" fill="#f6ead0">${xmlEscape(t)}</text>` +
    (st ? `<text x="${x}" y="${y + 40 * s}" font-family="${SANS}" font-size="${22 * s}" letter-spacing="${2 * s}" fill="#e7c989">${xmlEscape(st.toUpperCase())}</text>` : "");
  await sharp(svgBuf(W, H, svg)).png().toFile(dest);
  return dest;
}

// Small credit line for archival/art (top right).
export async function sourceTag(text, dest, W, H) {
  const s = W / 1280;
  const t = String(text || "").slice(0, 90);
  const svg = `<text x="${W - 30 * s}" y="${40 * s}" text-anchor="end" font-family="${SANS}" font-size="${16 * s}" fill="#ffffff" fill-opacity="0.85" stroke="#000" stroke-opacity="0.5" stroke-width="${2 * s}" paint-order="stroke">${xmlEscape(t)}</text>`;
  await sharp(svgBuf(W, H, svg)).png().toFile(dest);
  return dest;
}

export async function watermark(dest, W, H) {
  const s = W / 1280;
  const svg = `<text x="${W - 24 * s}" y="${H - 20 * s}" text-anchor="end" font-family="${SANS}" font-size="${14 * s}" fill="#ffffff" fill-opacity="0.55">${xmlEscape(COPYRIGHT)}</text>`;
  await sharp(svgBuf(W, H, svg)).png().toFile(dest);
  return dest;
}

export async function captionOverlay(text, dest, W, H) {
  const s = W / 1280;
  const lines = wrapText(text, 70).slice(-2);
  let y = H - (lines.length * 36 + 30) * s;
  let svg = "";
  for (const l of lines) {
    svg += `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="${SANS}" font-size="${26 * s}" fill="#fff" stroke="#000" stroke-width="${4 * s}" paint-order="stroke">${xmlEscape(l)}</text>`;
    y += 36 * s;
  }
  await sharp(svgBuf(W, H, svg)).png().toFile(dest);
  return dest;
}

// ---------------- maps (Natural Earth via world-atlas; public domain) ----------------
let countries = null;
function loadCountries() {
  if (countries) return countries;
  const require = createRequire(import.meta.url);
  const topo = JSON.parse(fs.readFileSync(require.resolve("world-atlas/countries-50m.json"), "utf8"));
  countries = feature(topo, topo.objects.countries).features;
  return countries;
}

export async function mapCard({ lat, lon, label, year, prev }, dest, W, H) {
  const s = W / 1280;
  const span = 44; // degrees of longitude across the (zoomed-out) frame
  const cos = Math.max(0.25, Math.cos((lat * Math.PI) / 180));
  const k = W / (span * cos);
  const px = (lo, la) => {
    let d = lo - lon;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return [W / 2 + d * cos * k, H / 2 - (la - lat) * k];
  };
  let paths = "";
  for (const f of loadCountries()) {
    const polys = f.geometry?.type === "Polygon" ? [f.geometry.coordinates] : f.geometry?.coordinates || [];
    for (const poly of polys) {
      for (const ring of poly) {
        let d = "";
        let last = null;
        let visible = false;
        for (const [lo, la] of ring) {
          const [x, y] = px(lo, la);
          if (x > -W && x < 2 * W && y > -H && y < 2 * H) visible = true;
          const jump = last && Math.abs(x - last[0]) > W * 2;
          d += `${!last || jump ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
          last = [x, y];
        }
        if (visible) paths += `<path d="${d}Z"/>`;
      }
    }
  }
  let grat = "";
  for (let g = -180; g <= 180; g += 10) {
    const [x] = px(g, lat);
    if (x >= 0 && x <= W) grat += `<line x1="${x}" x2="${x}" y1="0" y2="${H}"/>`;
  }
  for (let g = -80; g <= 80; g += 10) {
    const [, y] = px(lon, g);
    if (y >= 0 && y <= H) grat += `<line x1="0" x2="${W}" y1="${y}" y2="${y}"/>`;
  }
  let journey = "";
  if (prev && Number.isFinite(prev.lat)) {
    const [x0, y0] = px(prev.lon, prev.lat);
    const mx = (x0 + W / 2) / 2;
    const my = Math.min(y0, H / 2) - Math.hypot(x0 - W / 2, y0 - H / 2) * 0.25;
    journey =
      `<path d="M${x0},${y0} Q${mx},${my} ${W / 2},${H / 2}" fill="none" stroke="#8a2d1c" stroke-width="${4 * s}" stroke-dasharray="${14 * s} ${10 * s}" opacity="0.8"/>` +
      `<circle cx="${x0}" cy="${y0}" r="${8 * s}" fill="#8a2d1c" opacity="0.6"/>`;
  }
  const lbl = String(label || "").split(",").slice(0, 2).join(",").slice(0, 40);
  const lw = Math.max(lbl.length * 15, String(year || "").length * 18, 120) * s + 40 * s;
  const svg =
    `<defs><radialGradient id="v" cx="50%" cy="50%" r="70%"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#2b1d0e" stop-opacity="0.55"/></radialGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="#a9bcb8"/>` +
    `<g stroke="#8fa39f" stroke-width="${1 * s}" opacity="0.7">${grat}</g>` +
    `<g fill="#efe2c2" stroke="#9c8663" stroke-width="${1.4 * s}" stroke-linejoin="round">${paths}</g>` +
    journey +
    `<circle cx="${W / 2}" cy="${H / 2}" r="${26 * s}" fill="#b0301c" opacity="0.25"/>` +
    `<circle cx="${W / 2}" cy="${H / 2}" r="${11 * s}" fill="#b0301c" stroke="#fff" stroke-width="${3 * s}"/>` +
    `<g transform="translate(${W / 2 + 24 * s},${H / 2 - 70 * s})">` +
    `<rect width="${lw}" height="${year ? 74 * s : 46 * s}" rx="${4 * s}" fill="#1a140c" opacity="0.82"/>` +
    `<text x="${20 * s}" y="${32 * s}" font-family="${SERIF}" font-size="${26 * s}" fill="#f6ead0">${xmlEscape(lbl)}</text>` +
    (year ? `<text x="${20 * s}" y="${62 * s}" font-family="${SANS}" font-size="${20 * s}" letter-spacing="${3 * s}" fill="#e7c989">${xmlEscape(year)}</text>` : "") +
    `</g>` +
    `<rect width="${W}" height="${H}" fill="url(#v)"/>` +
    `<text x="${24 * s}" y="${H - 20 * s}" font-family="${SANS}" font-size="${14 * s}" fill="#3b3226" opacity="0.7">Map data: Natural Earth (public domain)</text>`;
  await sharp(svgBuf(W, H, svg)).jpeg({ quality: 90 }).toFile(dest);
  return { file: dest, focalX: 0.5, focalY: 0.5 };
}

// ---- close-up map: a few nearby places (a town and the border post beside it), with country borders at 1:10m ----
let countries10 = null;
function loadCountries10() {
  if (countries10) return countries10;
  const require = createRequire(import.meta.url);
  const topo = JSON.parse(fs.readFileSync(require.resolve("world-atlas/countries-10m.json"), "utf8"));
  countries10 = feature(topo, topo.objects.countries).features.map((f) => {
    const polys = f.geometry?.type === "Polygon" ? [f.geometry.coordinates] : f.geometry?.type === "MultiPolygon" ? f.geometry.coordinates : [];
    let x0 = 180, x1 = -180, y0 = 90, y1 = -90;
    for (const poly of polys) for (const [lo, la] of poly[0] || []) { x0 = Math.min(x0, lo); x1 = Math.max(x1, lo); y0 = Math.min(y0, la); y1 = Math.max(y1, la); }
    return { name: f.properties?.name || "", polys, box: [x0, y0, x1, y1] };
  });
  return countries10;
}
function insideCountry(c, lon, lat) {
  let hit = false;
  for (const poly of c.polys) for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}
/** Straight-line distance in km. */
export function kmBetween(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** marks: [{lat, lon, label}], the first is the place the scene is about. Shows how close the others are. */
export async function localMapCard({ marks, year }, dest, W, H) {
  const s = W / 1280;
  const lats = marks.map((m) => m.lat);
  const lons = marks.map((m) => m.lon);
  const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
  const lon0 = (Math.min(...lons) + Math.max(...lons)) / 2;
  const cos = Math.cos((lat0 * Math.PI) / 180);
  const minSpan = 0.25; // degrees of latitude (about 28 km), so two places a few km apart aren't drawn on top of each other
  const dLat = Math.max(Math.max(...lats) - Math.min(...lats), minSpan) * 1.7;
  const dLon = Math.max(Math.max(...lons) - Math.min(...lons), minSpan / cos) * 1.7;
  const k = Math.min(W / (dLon * cos), H / dLat); // pixels per degree of latitude
  const px = (lo, la) => [W / 2 + (lo - lon0) * cos * k, H / 2 - (la - lat0) * k];
  const view = [lon0 - W / (2 * cos * k), lat0 - H / (2 * k), lon0 + W / (2 * cos * k), lat0 + H / (2 * k)];
  const near = loadCountries10().filter((c) => c.box[0] < view[2] + 1 && c.box[2] > view[0] - 1 && c.box[1] < view[3] + 1 && c.box[3] > view[1] - 1);
  const home = near.find((c) => insideCountry(c, marks[0].lon, marks[0].lat));

  let land = "";
  for (const c of near) {
    let d = "";
    for (const poly of c.polys) for (const ring of poly) {
      d += ring.map(([lo, la], i) => { const [x, y] = px(lo, la); return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`; }).join("") + "Z";
    }
    land += `<path d="${d}" fill="${c === home ? "#efe2c2" : "#d6c8a8"}" fill-rule="evenodd"/>`;
  }
  // the outlines, drawn on top, are the borders
  const borders = near.map((c) => c.polys.map((poly) => poly.map((ring) => ring.map(([lo, la], i) => { const [x, y] = px(lo, la); return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`; }).join("") + "Z").join("")).join("")).join("");

  // everything placed so far, so labels, distance bubbles and country names keep clear of each other and of the dots
  const pts = marks.map((m) => ({ ...m, xy: px(m.lon, m.lat) }));
  const taken = pts.map(({ xy: [x, y] }, i) => { const r = (i ? 12 : 26) * s; return { x: x - r, y: y - r, w: 2 * r, h: 2 * r }; });
  // keep clear of the scene's year/place caption (lower left), the scale bar and the watermark (lower right)
  taken.push({ x: 0, y: H - 210 * s, w: 620 * s, h: 210 * s }, { x: W - 420 * s, y: H - 140 * s, w: 420 * s, h: 140 * s }, { x: W / 2 - 260 * s, y: H - 70 * s, w: 520 * s, h: 70 * s });
  const overlap = (a) => taken.reduce((sum, b) => sum + Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)), 0);
  const offFrame = (a) => a.x < 8 * s || a.y < 8 * s || a.x + a.w > W - 8 * s || a.y + a.h > H - 8 * s;

  // how far each place is from the first one (only when there are few enough lines to read)
  let lines = "";
  if (pts.length <= 3) {
    for (const m of pts.slice(1)) {
      const [x0, y0] = pts[0].xy, [x1, y1] = m.xy;
      const km = kmBetween(pts[0], m);
      const t = `≈ ${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const [nx, ny] = [-(y1 - y0) / len, (x1 - x0) / len]; // perpendicular, to slide the bubble off the dots
      let best = null;
      for (const off of [0, 40, -40, 80, -80, 120, -120]) {
        const cx = (x0 + x1) / 2 + nx * off * s, cy = (y0 + y1) / 2 + ny * off * s;
        const box = { x: cx - 56 * s, y: cy - 18 * s, w: 112 * s, h: 36 * s, cx, cy };
        const score = overlap(box) + (offFrame(box) ? 1e9 : 0);
        if (!best || score < best.score) best = { ...box, score };
        if (score === 0) break;
      }
      taken.push(best);
      const lead = Math.hypot(best.cx - (x0 + x1) / 2, best.cy - (y0 + y1) / 2) > 1 ? `<line x1="${(x0 + x1) / 2}" y1="${(y0 + y1) / 2}" x2="${best.cx}" y2="${best.cy}" stroke="#1a140c" stroke-width="${1.2 * s}" opacity="0.6"/>` : "";
      lines += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="#1a140c" stroke-width="${2.5 * s}" stroke-dasharray="${10 * s} ${8 * s}" opacity="0.75"/>` + lead +
        `<g transform="translate(${best.cx},${best.cy})"><rect x="${-56 * s}" y="${-18 * s}" width="${112 * s}" height="${36 * s}" rx="${18 * s}" fill="#fff8e6" stroke="#1a140c" stroke-width="${1.5 * s}"/>` +
        `<text y="${7 * s}" text-anchor="middle" font-family="${SANS}" font-size="${19 * s}" font-weight="600" fill="#1a140c">${t}</text></g>`;
    }
  }

  // markers, and a label beside each one on whichever side is free
  let dots = "", labels = "";
  for (const [i, m] of pts.entries()) {
    const [x, y] = m.xy;
    const main = i === 0;
    const fs1 = (main ? 26 : 21) * s;
    const txt = String(m.label || "").split(",")[0].trim().slice(0, 30);
    const w = txt.length * fs1 * 0.56 + 28 * s, hgt = fs1 + 20 * s, gap = (main ? 20 : 14) * s;
    const sides = [
      [x + gap, y - hgt / 2], [x - gap - w, y - hgt / 2], [x - w / 2, y - gap - hgt], [x - w / 2, y + gap],
      [x + gap * 0.7, y - gap * 0.7 - hgt], [x + gap * 0.7, y + gap * 0.7], [x - gap * 0.7 - w, y - gap * 0.7 - hgt], [x - gap * 0.7 - w, y + gap * 0.7],
    ];
    let best = null;
    for (const [lx, ly] of sides) {
      const box = { x: lx, y: ly, w, h: hgt };
      const score = overlap(box) + (offFrame(box) ? 1e9 : 0);
      if (!best || score < best.score) best = { ...box, score };
      if (score === 0) break;
    }
    taken.push(best);
    dots += main
      ? `<circle cx="${x}" cy="${y}" r="${24 * s}" fill="#b0301c" opacity="0.25"/><circle cx="${x}" cy="${y}" r="${11 * s}" fill="#b0301c" stroke="#fff" stroke-width="${3 * s}"/>`
      : `<circle cx="${x}" cy="${y}" r="${8 * s}" fill="#1a140c" stroke="#fff" stroke-width="${2.5 * s}"/>`;
    labels += `<rect x="${best.x}" y="${best.y}" width="${w}" height="${hgt}" rx="${4 * s}" fill="#1a140c" opacity="${main ? 0.85 : 0.72}"/>` +
      `<text x="${best.x + 14 * s}" y="${best.y + hgt / 2 + fs1 * 0.35}" font-family="${main ? SERIF : SANS}" font-size="${fs1}" fill="#f6ead0">${xmlEscape(txt)}</text>`;
  }

  // country names: in the country's on-screen part, as near its middle as possible while keeping clear of everything above
  let names = "";
  for (const c of near) {
    const cells = [];
    for (let gx = 0; gx < 24; gx++) for (let gy = 0; gy < 14; gy++) {
      const x = ((gx + 0.5) * W) / 24, y = ((gy + 0.5) * H) / 14;
      if (insideCountry(c, lon0 + (x - W / 2) / (cos * k), lat0 - (y - H / 2) / k)) cells.push([x, y]);
    }
    if (cells.length < 14) continue;
    const mx = cells.reduce((a, [x]) => a + x, 0) / cells.length, my = cells.reduce((a, [, y]) => a + y, 0) / cells.length;
    const name = c.name.toUpperCase();
    const w = name.length * 34 * s * 0.9, hgt = 40 * s;
    let best = null;
    for (const [x, y] of cells) {
      const box = { x: x - w / 2, y: y - hgt / 2, w, h: hgt };
      if (offFrame(box)) continue;
      // the box must stay inside the country too
      if (![[box.x, y], [box.x + w, y]].every(([ex, ey]) => insideCountry(c, lon0 + (ex - W / 2) / (cos * k), lat0 - (ey - H / 2) / k))) continue;
      const score = overlap(box) * 10 + Math.hypot(x - mx, y - my);
      if (!best || score < best.score) best = { x, y, score, box };
    }
    if (!best) continue;
    taken.push(best.box);
    names += `<text x="${best.x.toFixed(0)}" y="${(best.y + 12 * s).toFixed(0)}" text-anchor="middle" font-family="${SANS}" font-size="${34 * s}" letter-spacing="${10 * s}" fill="#6b5a3e" opacity="0.5">${xmlEscape(name)}</text>`;
  }

  // scale bar
  const kmPerPx = 111.32 / k;
  const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200].find((v) => v / kmPerPx >= 110 * s) || 200;
  const bar = nice / kmPerPx;
  const sb = `<g transform="translate(${W - 140 * s - bar},${H - 90 * s})"><rect width="${bar}" height="${7 * s}" fill="#1a140c"/><rect width="${bar / 2}" height="${7 * s}" fill="#fff8e6" stroke="#1a140c" stroke-width="${1 * s}"/>` +
    `<text y="${-8 * s}" font-family="${SANS}" font-size="${16 * s}" fill="#1a140c">0</text><text x="${bar}" y="${-8 * s}" text-anchor="middle" font-family="${SANS}" font-size="${16 * s}" fill="#1a140c">${nice} km</text></g>`;

  const svg =
    `<defs><radialGradient id="v" cx="50%" cy="50%" r="75%"><stop offset="0.65" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#2b1d0e" stop-opacity="0.45"/></radialGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="#a9bcb8"/>` + land + names +
    `<path d="${borders}" fill="none" stroke="#8a2d1c" stroke-width="${3.5 * s}" stroke-dasharray="${16 * s} ${9 * s}" stroke-linejoin="round"/>` +
    lines + dots + labels +
    `<rect width="${W}" height="${H}" fill="url(#v)"/>` + sb +
    `<text x="${W / 2}" y="${H - 48 * s}" text-anchor="middle" font-family="${SANS}" font-size="${14 * s}" fill="#3b3226" opacity="0.7">Map data: Natural Earth (public domain) · borders approximate</text>`;
  await sharp(svgBuf(W, H, svg)).jpeg({ quality: 90 }).toFile(dest);
  return { file: dest, focalX: 0.5, focalY: 0.5 };
}
