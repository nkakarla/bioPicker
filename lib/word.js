// BioPicker — Word (.docx) round trip of a biopic's inputs and scripts. Copyright (c) 2026 ePerf
//
// Every table's header starts with "ID [key]" and every row carries the record's ID in a grey first
// column, so an edited document can be matched back to the project: rows without an ID are new,
// rows that were deleted are removed (photos are only left out of the film, never deleted).
import fs from "node:fs";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import sharp from "sharp";
import { projectPath } from "./store.js";
import { COPYRIGHT, newId, sortByDate } from "./util.js";
import { readZip } from "./zip.js";

export const EVENT_TYPES = ["birth", "school", "graduation", "college", "job", "marriage", "child", "move", "military", "award", "fame", "retirement", "death", "other"];
const TONES = ["serious", "humorous", "teachable"];
const QUALITIES = ["480p", "720p", "1080p"];
const PERSON_LABELS = {
  name: "Full name",
  preferredName: "Preferred name",
  pronouns: "Pronouns",
  born: "Born (date)",
  birthplace: "Birthplace",
  died: "Died (date, blank if living)",
  nationality: "Nationality",
  occupation: "Occupation",
  claimToFame: "Claim to fame",
  personality: "Personality",
  family: "Family & friends",
  legacy: "Legacy",
  notes: "Other notes",
  language: "Narration language (e.g. en, es, hi)",
};
export const versionLabel = (v) => (v === "short" ? "Short version" : v === "long" ? "Long version" : `Episode ${v.slice(2)}`);

// ---------------------------------------------------------------- build
const GREY = "EDEBE6";
const HEAD = "3A3023";
const lines = (text) => String(text ?? "").split(/\r?\n/);
function cell(text, { width, id = false, head = false, image = null } = {}) {
  const children = image
    ? [new Paragraph({ children: [image] })]
    : lines(text).map((t) => new Paragraph({ children: [new TextRun({ text: t, bold: head, size: id || head ? 16 : 20, color: head ? "FFFFFF" : id ? "7A7063" : undefined })] }));
  return new TableCell({
    children,
    width: { size: width, type: WidthType.PERCENTAGE },
    shading: head ? { type: ShadingType.CLEAR, fill: HEAD, color: "auto" } : id ? { type: ShadingType.CLEAR, fill: GREY, color: "auto" } : undefined,
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
  });
}
function table(key, cols, rows) {
  // cols: [[heading, widthPercent], ...] — the ID column is added first
  const widths = [9, ...cols.map((c) => c[1])];
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: [cell(`ID [${key}]`, { width: widths[0], head: true }), ...cols.map((c, i) => cell(c[0], { width: widths[i + 1], head: true }))] }),
      ...rows.map((r) => new TableRow({ children: r.map((v, i) => (v instanceof ImageRun ? cell("", { width: widths[i], image: v }) : cell(v, { width: widths[i], id: i === 0 }))) })),
    ],
  });
}
const h1 = (t) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 120 } });
const h2 = (t) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 100 } });
const note = (t) => new Paragraph({ children: [new TextRun({ text: t, italics: true, color: "6B6255", size: 18 })], spacing: { after: 120 } });
const para = (t, opts = {}) => new Paragraph({ children: [new TextRun({ text: t, ...opts })], spacing: { after: 80 } });

async function photoRun(p, ph) {
  try {
    const src = projectPath(p.id, "uploads", ph.file);
    if (!fs.existsSync(src)) return "(missing)";
    const buf = await sharp(src).resize({ width: 360, height: 360, fit: "inside" }).jpeg({ quality: 78 }).toBuffer({ resolveWithObject: true });
    const w = 150;
    const hgt = Math.round((w * buf.info.height) / buf.info.width);
    return new ImageRun({ type: "jpg", data: buf.data, transformation: { width: w, height: hgt } });
  } catch {
    return "(unreadable)";
  }
}

export function scriptVersions(p) {
  const order = (v) => (v === "short" ? 0 : v === "long" ? 1 : 1 + Number(v.slice(2)));
  return Object.keys(p.scripts).sort((a, b) => order(a) - order(b));
}

export async function buildDocx(p) {
  const name = p.person.name || "Untitled";
  const kids = [];
  kids.push(
    new Paragraph({ children: [new TextRun({ text: "BioPicker", color: "B08A45", size: 22, bold: true })] }),
    new Paragraph({ text: `The story of ${name}`, heading: HeadingLevel.TITLE }),
    para(`Exported ${new Date().toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" })}`, { color: "6B6255", size: 18 }),
    h2("How to edit this document"),
    para("1. Change any text in the white cells: details, dates, captions, answers, episode titles and the narration."),
    para("2. Leave the grey ID column alone. It is how BioPicker knows which row is which."),
    para("3. To add something, add a row and leave its ID blank. In the Photos table, paste a picture into the Photo cell of the new row."),
    para("4. To remove a timeline event, interview question or script scene, delete its row. Photos whose rows are deleted are only left out of the film, never deleted."),
    para("5. Save as Word (.docx) and upload it in BioPicker with File → Update from Word. You can undo an upload from the same menu."),
  );

  kids.push(h1("1. The person"), table("person", [["Field", 26], ["Value", 65]], Object.keys(PERSON_LABELS).map((k) => [k, PERSON_LABELS[k], p.person[k] || ""])));

  kids.push(
    h1("2. Style & length"),
    note(`tone: ${TONES.join(" / ")} · quality: ${QUALITIES.join(" / ")} · episodes: 0 lets the AI choose`),
    table("settings", [["Setting", 40], ["Value", 51]], [
      ["tone", "Tone", p.settings.tone],
      ["shortSeconds", "Short version length (seconds)", String(p.settings.shortSeconds)],
      ["longSeconds", "Long version length (seconds)", String(p.settings.longSeconds)],
      ["episodeCount", "Series: number of episodes", String(p.settings.episodeCount || 0)],
      ["episodeMinutes", "Series: minutes per episode", String(Math.round((p.settings.episodeSeconds || 600) / 60))],
      ["quality", "Video quality", p.settings.quality],
    ]),
  );

  kids.push(
    h1("3. Timeline & places"),
    note(`Date as YYYY-MM-DD, YYYY-MM or YYYY. Type: ${EVENT_TYPES.join(", ")}.`),
    table("timeline", [["Date", 11], ["Type", 10], ["Title", 20], ["Place", 17], ["Description", 33]],
      [...p.timeline].sort(sortByDate).map((e) => [e.id, e.date, e.type, e.title, e.place, e.description])),
  );

  const photoRows = [];
  for (const ph of p.photos) photoRows.push([ph.id, await photoRun(p, ph), ph.caption || "", ph.date || "", ph.place || "", ph.include === false ? "No" : "Yes"]);
  kids.push(
    h1("4. Photos"),
    note("Use in film: Yes or No. To add a photo, add a row, leave the ID blank and paste the picture into the Photo cell."),
    table("photos", [["Photo", 22], ["Caption", 28], ["Date", 11], ["Place", 17], ["Use in film", 13]], photoRows),
  );

  kids.push(
    h1("5. Interview"),
    note("Answer in your own words. Add a row with a blank ID to add your own question and answer."),
    table("interview", [["Question", 38], ["Answer", 53]], p.interview.map((q) => [q.id, q.question, q.answer || ""])),
  );

  if (p.documents.length) {
    kids.push(h1("Documents"), note("For reference only. Add or remove documents in the app."));
    for (const d of p.documents) kids.push(para(`• ${d.name}${d.summary ? ": " + d.summary : ""}`));
  }

  if (p.series?.episodes?.length) {
    kids.push(
      h1("6. Documentary series"),
      note("Edit the series title, episode titles and what each covers. Add or remove episodes in the app."),
      table("series", [["Episode", 12], ["Title", 30], ["What it covers", 49]], [
        ["title", "Series title", p.series.title || "", ""],
        ...p.series.episodes.map((e) => [`ep${e.n}`, `Episode ${e.n}${e.from ? ` (${e.from}${e.to && e.to !== e.from ? "–" + e.to : ""})` : ""}`, e.title, e.logline]),
      ]),
    );
  }

  const versions = scriptVersions(p);
  if (versions.length) {
    kids.push(h1("7. Scripts"), note("The narrator reads the Narration column. Edit it freely; add a row (blank ID) for a new scene, delete a row to cut a scene. Pictures for each scene are chosen in the app."));
    for (const v of versions) {
      const s = p.scripts[v];
      kids.push(
        h2(`${versionLabel(v)}${s.title ? ": " + s.title : ""}`),
        table(`scriptinfo:${v}`, [["Field", 20], ["Value", 71]], [["title", "Film title", s.title || ""], ["tagline", "Tagline", s.tagline || ""]]),
        new Paragraph({ text: "", spacing: { after: 80 } }),
        table(`script:${v}`, [["#", 5], ["On-screen title", 16], ["Subtitle", 16], ["Narration", 54]], s.scenes.map((sc, i) => [sc.id, String(i + 1), sc.onScreenTitle || "", sc.onScreenSubtitle || "", sc.narration || ""])),
      );
    }
  }

  kids.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 400 }, children: [new TextRun({ text: `BioPicker · ${COPYRIGHT}`, color: "9A9080", size: 16 })] }));

  const doc = new Document({
    creator: "BioPicker",
    title: `BioPicker: ${name}`,
    description: `bioPicker:${p.id}`,
    styles: { default: { document: { run: { font: "Calibri", size: 20 } } } },
    sections: [{ properties: { page: { size: { orientation: PageOrientation.LANDSCAPE }, margin: { top: 720, bottom: 720, left: 720, right: 720 } } }, children: kids }],
  });
  return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------- parse
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");

/** Top-level <tag>…</tag> blocks inside xml (handles nesting of the same tag). */
function blocks(xml, tag) {
  const out = [];
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const isOpen = (i) => xml.startsWith(open, i) && /[\s>/]/.test(xml[i + open.length]);
  let i = 0;
  while (i < xml.length) {
    const start = xml.indexOf(open, i);
    if (start < 0) break;
    if (!isOpen(start)) { i = start + open.length; continue; }
    const gt = xml.indexOf(">", start);
    if (xml[gt - 1] === "/") { out.push(xml.slice(start, gt + 1)); i = gt + 1; continue; }
    let depth = 1;
    let j = gt + 1;
    while (depth > 0) {
      const nextOpen = xml.indexOf(open, j);
      const nextClose = xml.indexOf(close, j);
      if (nextClose < 0) return out; // malformed
      if (nextOpen >= 0 && nextOpen < nextClose && isOpen(nextOpen)) {
        const g = xml.indexOf(">", nextOpen);
        if (xml[g - 1] !== "/") depth++;
        j = g + 1;
      } else {
        depth--;
        j = nextClose + close.length;
      }
    }
    out.push(xml.slice(start, j));
    i = j;
  }
  return out;
}
function paragraphText(p) {
  let out = "";
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br(?:\s[^>]*)?\/>|<w:cr\/>/g;
  let m;
  while ((m = re.exec(p))) out += m[1] !== undefined ? decode(m[1]) : m[0].startsWith("<w:tab") ? "\t" : "\n";
  return out;
}
const cellText = (tc) => blocks(tc, "w:p").map(paragraphText).join("\n").replace(/ /g, " ").trim();

/** Reads a .docx and returns its BioPicker tables: [{ key, rows: [{ cells: [text], images: [[{data, name}]] }] }]. */
export function parseDocx(buf) {
  let entries;
  try {
    entries = readZip(buf);
  } catch {
    throw Object.assign(new Error("That file isn't a Word .docx document. In Word, use File → Save As → Word Document (.docx)."), { status: 400 });
  }
  const get = (n) => entries.find((e) => e.name === n)?.data;
  const docXml = get("word/document.xml");
  if (!docXml) throw Object.assign(new Error("That file isn't a Word .docx document."), { status: 400 });
  const xml = docXml.toString("utf8");
  const rels = {};
  const relXml = get("word/_rels/document.xml.rels")?.toString("utf8") || "";
  for (const tag of relXml.match(/<Relationship\s[^>]*>/g) || []) {
    const id = tag.match(/\sId="([^"]+)"/)?.[1];
    const target = tag.match(/\sTarget="([^"]+)"/)?.[1];
    if (id && target) rels[id] = target.startsWith("/") ? target.slice(1) : `word/${target}`;
  }
  const body = blocks(xml, "w:body")[0] || xml;
  const tables = [];
  for (const tbl of blocks(body, "w:tbl")) {
    const trs = blocks(tbl, "w:tr");
    if (!trs.length) continue;
    const head = blocks(trs[0], "w:tc").map(cellText);
    const key = head[0]?.match(/\[\s*([a-z]+(?::[a-z0-9]+)?)\s*\]/i)?.[1]?.toLowerCase();
    if (!key) continue;
    const rows = trs.slice(1).map((tr) => {
      const tcs = blocks(tr, "w:tc");
      return {
        cells: tcs.map(cellText),
        images: tcs.map((tc) =>
          [...tc.matchAll(/<a:blip\b[^>]*\br:embed="([^"]+)"/g)]
            .map((m) => rels[m[1]])
            .filter(Boolean)
            .map((n) => ({ name: n.split("/").pop(), data: get(n) }))
            .filter((x) => x.data)),
      };
    });
    tables.push({ key, rows });
  }
  if (!tables.length) throw Object.assign(new Error("No BioPicker tables found. Upload a document that was downloaded from BioPicker (File → Download Word document)."), { status: 400 });
  return tables;
}

// ---------------------------------------------------------------- apply
const YES = /^(y|yes|true|1|x|✓|✔|include|included)$/i;
const blankRow = (r) => r.cells.every((c) => !c) && r.images.every((i) => !i.length);

/**
 * Applies an edited document to the project (in memory). ingest(file) turns an image into a photo record.
 * Returns { changes: [text], warnings: [text], newPhotos: [photo], timelineChanged }.
 */
export async function applyDocx(p, tables, { ingest }) {
  const changes = [];
  const warnings = [];
  const newPhotos = [];
  const byKey = Object.fromEntries(tables.map((t) => [t.key, t]));
  const count = (n, what) => `${n} ${what}${n === 1 ? "" : "s"}`;

  // person
  if (byKey.person) {
    const changed = [];
    for (const r of byKey.person.rows) {
      const [k, , v = ""] = r.cells;
      if (!(k in p.person)) continue;
      const val = v.slice(0, 5000);
      if ((p.person[k] || "") !== val) (p.person[k] = val), changed.push(PERSON_LABELS[k] || k);
    }
    if (changed.length) changes.push(`Person: updated ${changed.join(", ")}`);
  }

  // settings
  if (byKey.settings) {
    const s = p.settings;
    const changed = [];
    const num = (v, lo, hi) => {
      const n = Math.round(Number(String(v).replace(/[^\d.]/g, "")));
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null;
    };
    for (const r of byKey.settings.rows) {
      const [k, label, v = ""] = r.cells;
      const val = v.trim().toLowerCase();
      let next;
      if (k === "tone") next = TONES.includes(val) ? val : (warnings.push(`Tone "${v}" isn't one of ${TONES.join("/")}; kept ${s.tone}.`), s.tone);
      else if (k === "quality") next = QUALITIES.includes(val) ? val : (warnings.push(`Quality "${v}" isn't one of ${QUALITIES.join("/")}; kept ${s.quality}.`), s.quality);
      else if (k === "shortSeconds") next = num(v, 30, 300) ?? s.shortSeconds;
      else if (k === "longSeconds") next = num(v, 120, 1800) ?? s.longSeconds;
      else if (k === "episodeCount") next = num(v, 0, 20) ?? s.episodeCount;
      else if (k === "episodeMinutes") {
        const m = num(v, 3, 30);
        if (m != null && m * 60 !== s.episodeSeconds) (s.episodeSeconds = m * 60), changed.push(label);
        continue;
      } else continue;
      if (next !== s[k]) (s[k] = next), changed.push(label);
    }
    if (changed.length) changes.push(`Style: updated ${changed.join(", ")}`);
  }

  // timeline
  let timelineChanged = false;
  if (byKey.timeline) {
    const old = Object.fromEntries(p.timeline.map((e) => [e.id, e]));
    const seen = new Set();
    let added = 0;
    let edited = 0;
    const next = [];
    for (const r of byKey.timeline.rows) {
      if (blankRow(r)) continue;
      const [id, date = "", type = "", title = "", place = "", description = ""] = r.cells;
      const t = type.trim().toLowerCase();
      const fields = { date: date.trim().slice(0, 20), type: EVENT_TYPES.includes(t) ? t : "other", title: title.slice(0, 200), place: place.slice(0, 200), description: description.slice(0, 3000) };
      const o = old[id];
      if (o && !seen.has(id)) {
        seen.add(id);
        const diff = Object.keys(fields).some((k) => (o[k] || "") !== fields[k]);
        if (diff) edited++;
        next.push({ ...o, ...fields, ...(o.place !== fields.place ? { lat: null, lon: null, geoFor: "" } : {}) });
      } else {
        added++;
        next.push({ id: newId(8), ...fields, lat: null, lon: null, geoFor: "" });
      }
    }
    const removed = p.timeline.filter((e) => !seen.has(e.id)).length;
    if (added || edited || removed) {
      p.timeline = next.sort(sortByDate);
      timelineChanged = true;
      changes.push(`Timeline: ${[added && `${added} added`, edited && `${edited} edited`, removed && `${removed} removed`].filter(Boolean).join(", ")}`);
    }
  }

  // photos
  if (byKey.photos) {
    const old = Object.fromEntries(p.photos.map((ph) => [ph.id, ph]));
    const seen = new Set();
    let edited = 0;
    for (const r of byKey.photos.rows) {
      if (blankRow(r)) continue;
      const [id, , caption = "", date = "", place = "", use = "Yes"] = r.cells;
      const include = use.trim() ? YES.test(use.trim()) : true;
      const ph = old[id];
      if (ph) {
        seen.add(id);
        const upd = { caption: caption.slice(0, 1000), date: date.trim().slice(0, 40), place: place.slice(0, 200), include };
        if (Object.keys(upd).some((k) => (k === "include" ? ph.include !== false : ph[k] || "") !== upd[k])) edited++, Object.assign(ph, upd);
        continue;
      }
      const img = r.images[1]?.[0] || r.images.flat()[0];
      if (!img) {
        if (caption || date || place) warnings.push(`A new photo row ("${(caption || date || place).slice(0, 40)}") has no picture pasted in, so it was skipped.`);
        continue;
      }
      try {
        const ph2 = await ingest({ buffer: img.data, originalname: `word-${img.name}` });
        Object.assign(ph2, { caption: caption.slice(0, 1000) || ph2.caption, date: date.trim() || ph2.date, place: place || ph2.place, include });
        newPhotos.push(ph2);
      } catch (e) {
        warnings.push(`A pasted photo couldn't be read (${e.message}).`);
      }
    }
    let hidden = 0;
    for (const ph of p.photos) if (!seen.has(ph.id) && ph.include !== false) (ph.include = false), hidden++;
    p.photos.push(...newPhotos);
    const bits = [newPhotos.length && `${newPhotos.length} added`, edited && `${edited} edited`, hidden && `${hidden} left out of the film (rows deleted; photos kept)`].filter(Boolean);
    if (bits.length) changes.push(`Photos: ${bits.join(", ")}`);
  }

  // interview
  if (byKey.interview) {
    const old = Object.fromEntries(p.interview.map((q) => [q.id, q]));
    const seen = new Set();
    let added = 0;
    let edited = 0;
    const next = [];
    for (const r of byKey.interview.rows) {
      if (blankRow(r)) continue;
      const [id, question = "", answer = ""] = r.cells;
      const q = old[id];
      if (q && !seen.has(id)) {
        seen.add(id);
        if ((q.answer || "") !== answer || q.question !== question) edited++;
        next.push({ ...q, question: question.slice(0, 1000) || q.question, answer: answer.slice(0, 8000) });
      } else if (question.trim()) {
        added++;
        next.push({ id: newId(8), question: question.slice(0, 1000), why: "Added in Word", category: "personal", answer: answer.slice(0, 8000) });
      }
    }
    const removed = p.interview.filter((q) => !seen.has(q.id)).length;
    if (added || edited || removed) {
      p.interview = next;
      changes.push(`Interview: ${[added && `${added} added`, edited && `${edited} edited`, removed && `${removed} removed`].filter(Boolean).join(", ")}`);
    }
  }

  // series plan (titles and loglines only)
  if (byKey.series && p.series?.episodes) {
    let edited = 0;
    let extra = 0;
    for (const r of byKey.series.rows) {
      if (blankRow(r)) continue;
      const [id, , title = "", logline = ""] = r.cells;
      if (id === "title") {
        if (title && title !== p.series.title) (p.series.title = title.slice(0, 200)), edited++;
        continue;
      }
      const ep = p.series.episodes.find((e) => `ep${e.n}` === id);
      if (!ep) { extra++; continue; }
      if ((title && title !== ep.title) || (logline && logline !== ep.logline)) {
        ep.title = (title || ep.title).slice(0, 200);
        ep.logline = (logline || ep.logline).slice(0, 1000);
        edited++;
      }
    }
    if (edited) changes.push(`Series: ${count(edited, "title/description")} updated`);
    if (extra) warnings.push("Episodes can only be added or removed in the app; extra episode rows were ignored.");
  }

  // scripts
  const touched = new Set();
  for (const t of tables) {
    const m = t.key.match(/^(scriptinfo|script):(.+)$/);
    if (!m) continue;
    const v = m[2];
    const s = p.scripts[v];
    if (!s) { warnings.push(`There is no ${versionLabel(v)} script in BioPicker any more; its table was ignored.`); continue; }
    if (m[1] === "scriptinfo") {
      for (const r of t.rows) {
        const [k, , val = ""] = r.cells;
        if ((k === "title" || k === "tagline") && val !== (s[k] || "")) (s[k] = val.slice(0, 300)), touched.add(v);
      }
      continue;
    }
    const old = Object.fromEntries(s.scenes.map((sc) => [sc.id, sc]));
    const seen = new Set();
    let added = 0;
    let edited = 0;
    const scenes = [];
    for (const r of t.rows) {
      if (blankRow(r)) continue;
      const [id, , title = "", sub = "", narration = ""] = r.cells;
      const o = old[id];
      if (o && !seen.has(id)) {
        seen.add(id);
        if ((o.onScreenTitle || "") !== title || (o.onScreenSubtitle || "") !== sub || (o.narration || "") !== narration) edited++;
        scenes.push({ ...o, onScreenTitle: title.slice(0, 300), onScreenSubtitle: sub.slice(0, 300), narration: narration.slice(0, 4000) });
      } else if (narration.trim() || title.trim()) {
        added++;
        scenes.push({ id: newId(6), kind: "life", eventId: "", year: "", place: "", transition: "fade", onScreenTitle: title.slice(0, 300), onScreenSubtitle: sub.slice(0, 300), narration: narration.slice(0, 4000), visuals: [{ type: "card", ref: (title || narration).slice(0, 80), caption: "" }] });
      }
    }
    const removed = s.scenes.filter((sc) => !seen.has(sc.id)).length;
    const moved = scenes.filter((sc) => old[sc.id]).map((sc) => sc.id).join() !== s.scenes.filter((sc) => seen.has(sc.id)).map((sc) => sc.id).join();
    if (added || edited || removed || moved) {
      s.scenes = scenes;
      if (added) s.mediaResolvedAt = null;
      touched.add(v);
      changes.push(`${versionLabel(v)} script: ${[added && `${added} scenes added (as title cards; add pictures in the app)`, edited && `${edited} edited`, removed && `${removed} removed`, moved && "reordered"].filter(Boolean).join(", ")}`);
    }
  }
  for (const v of touched) p.scripts[v].updatedAt = new Date().toISOString();
  for (const v of touched) if (!changes.some((c) => c.startsWith(versionLabel(v)))) changes.push(`${versionLabel(v)} script: title/tagline updated`);

  return { changes, warnings, newPhotos, timelineChanged, scriptsChanged: [...touched] };
}
