// BioPicker — photo ingest: normalise, thumbnail, read EXIF metadata. Copyright (c) 2026 ePerf
import fs from "node:fs";
import exifr from "exifr";
import sharp from "sharp";
import { reverseGeocode } from "./geo.js";
import { projectPath } from "./store.js";
import { newId } from "./util.js";

function isoDate(d) {
  if (!d) return "";
  if (d instanceof Date && !isNaN(d)) return d.toISOString().slice(0, 10);
  const m = String(d).match(/(\d{4})[:\-](\d{2})[:\-](\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

export async function readExif(buf) {
  let tags = {};
  try {
    tags = (await exifr.parse(buf, { tiff: true, exif: true, gps: true, iptc: true, xmp: true })) || {};
  } catch {}
  const out = {
    date: isoDate(tags.DateTimeOriginal || tags.CreateDate || tags.DateCreated || tags.ModifyDate),
    lat: typeof tags.latitude === "number" ? tags.latitude : null,
    lon: typeof tags.longitude === "number" ? tags.longitude : null,
    camera: [tags.Make, tags.Model].filter(Boolean).join(" "),
    description: tags.ImageDescription || tags.Caption || tags.description || "",
    artist: tags.Artist || tags.Creator || "",
    keywords: [].concat(tags.Keywords || tags.subject || []).slice(0, 12),
  };
  return out;
}

export async function ingestPhoto(projectId, file) {
  const id = newId(10);
  const src = file.buffer;
  const exif = await readExif(src);
  let img;
  try {
    img = sharp(src, { failOn: "none" }).rotate();
    await img.metadata();
  } catch (e) {
    throw new Error(`${file.originalname}: unsupported image (${e.message}). Try JPEG or PNG.`);
  }
  const mainFile = `${id}.jpg`;
  const info = await sharp(src, { failOn: "none" })
    .rotate()
    .resize({ width: 4000, height: 4000, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#000" })
    .jpeg({ quality: 92 })
    .toFile(projectPath(projectId, "uploads", mainFile));
  await sharp(projectPath(projectId, "uploads", mainFile))
    .resize({ width: 480, height: 480, fit: "inside" })
    .jpeg({ quality: 80 })
    .toFile(projectPath(projectId, "thumbs", mainFile));

  let place = "";
  if (exif.lat != null && exif.lon != null) place = (await reverseGeocode(exif.lat, exif.lon)) || "";

  return {
    id,
    file: mainFile,
    originalName: file.originalname,
    width: info.width,
    height: info.height,
    exif,
    date: exif.date || "",
    place,
    lat: exif.lat,
    lon: exif.lon,
    caption: exif.description || "",
    ai: null,
    eventId: null,
    include: true,
  };
}

export function deletePhotoFiles(projectId, photo) {
  for (const d of ["uploads", "thumbs"]) {
    try {
      fs.unlinkSync(projectPath(projectId, d, photo.file));
    } catch {}
  }
}

// Small JPEG for sending to Claude vision.
export async function photoForAI(projectId, photo) {
  return sharp(projectPath(projectId, "uploads", photo.file))
    .resize({ width: 1024, height: 1024, fit: "inside" })
    .jpeg({ quality: 80 })
    .toBuffer();
}
