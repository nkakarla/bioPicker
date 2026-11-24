// BioPicker — a film in another language: the script's words are translated, the pictures,
// maps and music stay the same. Copyright (c) 2026 EPerf
import { translateTexts } from "./ai.js";
import { LANGS, langVersion } from "./langs.js";

const mapParts = (ref) => String(ref || "").split(";").map((x) => x.trim()).filter(Boolean);
const labelOf = (part) => part.split("=")[0].trim();
const queryOf = (part) => (part.includes("=") ? part.split("=").slice(1).join("=").trim() : part.trim());

/** The words of a script to translate, as [{ key, kind, text }]. */
export function translationItems(src) {
  const items = [];
  const add = (key, kind, text) => String(text || "").trim() && items.push({ key, kind, text: String(text) });
  add("title", "title", src.title);
  add("tagline", "caption", src.tagline);
  const places = new Set();
  src.scenes.forEach((sc, i) => {
    add(`n${i}`, sc.voice === "story" ? "memory" : "narration", sc.narration);
    add(`t${i}`, "title", sc.onScreenTitle);
    add(`s${i}`, "caption", sc.onScreenSubtitle);
    (sc.visuals || []).forEach((v, j) => {
      add(`c${i}.${j}`, "caption", v.caption);
      if (String(v.type).toLowerCase() !== "map") return;
      const labels = [...mapParts(v.ref).map(labelOf), v.asset?.label, ...(v.asset?.marks || []).map((m) => m.label)];
      for (const l of labels) if (l && !places.has(l)) places.add(l) && add(`place:${l}`, "place", l);
    });
  });
  return items;
}

/**
 * Builds the translated copy of p.scripts[base] (e.g. "short" → "short-te"). Pictures, maps (with
 * their looked-up places) and music are kept, so the translation renders without searching again.
 */
export async function translateScript(p, base, lang, { log = () => {}, translate = translateTexts } = {}) {
  const src = p.scripts[base];
  if (!src) throw new Error("Write the English script first.");
  const L = LANGS[lang];
  if (!L) throw new Error("That language isn't available.");
  const items = translationItems(src);
  const out = {};
  // about 25 scenes at a time keeps each answer well inside the model's limits
  const CHUNK = 90;
  for (let i = 0; i < items.length; i += CHUNK) {
    if (items.length > CHUNK) log(`Translating part ${i / CHUNK + 1} of ${Math.ceil(items.length / CHUNK)}…`);
    Object.assign(out, await translate(items.slice(i, i + CHUNK), { language: L.name, native: L.native, documentary: p.kind === "documentary", pronounce: p.settings.pronounce || [] }));
  }
  const missing = items.filter((x) => !String(out[x.key] || "").trim());
  if (missing.length > items.length / 10) throw new Error(`The translation came back incomplete (${missing.length} of ${items.length} pieces missing). Try again.`);
  const T = (key, fallback) => (String(out[key] || "").trim() ? out[key].trim() : fallback);

  const copy = JSON.parse(JSON.stringify(src));
  copy.version = langVersion(base, lang);
  copy.lang = lang;
  copy.translatedFrom = { version: base, scriptAt: src.updatedAt || src.createdAt || null };
  copy.createdAt = new Date().toISOString();
  delete copy.updatedAt;
  delete copy.restoredFrom;
  copy.title = T("title", src.title);
  copy.tagline = T("tagline", src.tagline);
  copy.scenes.forEach((sc, i) => {
    sc.narration = T(`n${i}`, sc.narration);
    if (sc.onScreenTitle) sc.onScreenTitle = T(`t${i}`, sc.onScreenTitle);
    if (sc.onScreenSubtitle) sc.onScreenSubtitle = T(`s${i}`, sc.onScreenSubtitle);
    (sc.visuals || []).forEach((v, j) => {
      if (v.caption) v.caption = T(`c${i}.${j}`, v.caption);
      if (String(v.type).toLowerCase() !== "map") return;
      // "Ferozepur = Firozpur, Punjab, India" → "ఫిరోజ్‌పూర్ = Firozpur, Punjab, India": the map shows the
      // translated name and still looks up the same place
      v.ref = mapParts(v.ref).map((part) => `${T(`place:${labelOf(part)}`, labelOf(part))} = ${queryOf(part)}`).join("; ");
      if (v.asset?.kind === "map") {
        v.asset.label = T(`place:${v.asset.label}`, v.asset.label);
        for (const m of v.asset.marks || []) m.label = T(`place:${m.label}`, m.label);
      }
    });
  });
  return copy;
}
