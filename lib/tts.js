// BioPicker — narration voices. Providers: Microsoft Edge neural voices (default, no key),
// ElevenLabs (when ELEVENLABS_API_KEY is set) for a copy of the maker's own voice.
// Copyright (c) 2026 EPerf
import fs from "node:fs";
import path from "node:path";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { LANGS } from "./langs.js";
import { ensureDir, fetchWithTimeout, newId, sleep } from "./util.js";

const XI = "https://api.elevenlabs.io";
const xiKey = () => process.env.ELEVENLABS_API_KEY || "";
export const ownVoiceReady = () => !!xiKey();

let edgeVoiceCache = null;

async function edgeVoices() {
  if (edgeVoiceCache) return edgeVoiceCache;
  const tts = new MsEdgeTTS();
  try {
    const list = await tts.getVoices();
    edgeVoiceCache = list.map((v) => ({
      provider: "edge",
      id: v.ShortName,
      label: `${v.FriendlyName?.replace(/^Microsoft /, "").replace(/ Online \(Natural\)/, "") || v.ShortName}`,
      gender: v.Gender,
      locale: v.Locale,
      personality: (v.VoiceTag?.VoicePersonalities || []).join(", "),
    }));
  } finally {
    tts.close?.();
  }
  return edgeVoiceCache;
}

/**
 * A person's own (copied) voices. They belong to that account only: the ElevenLabs account is shared
 * by every BioPicker user, so its voice list is never shown as a whole.
 */
export const ownVoices = (user) =>
  ownVoiceReady()
    ? (user?.voices || []).map((v) => ({ provider: "elevenlabs", id: v.id, label: v.name, gender: "", locale: "own", personality: "your own voice", own: true }))
    : [];

/** Every voice this person may pick: their own voices first, then the free neural voices. */
export async function listVoices(user = null) {
  const edge = await edgeVoices().catch(() => []);
  return [...ownVoices(user), ...edge];
}

// Voices worth offering to the casting AI: the narration language plus English variants (never a person's own voice).
export async function castingShortlist(language = "en") {
  const all = await listVoices();
  const lang = language.toLowerCase().slice(0, 2);
  return all.filter((v) => v.locale.toLowerCase().startsWith(lang) || v.locale.startsWith("en-"));
}

/** True when a voice may be used by this person: a free voice, or one of their own copied voices. */
export const voiceAllowed = (voice, user) => !voice?.id || voice.provider !== "elevenlabs" || (user?.voices || []).some((v) => v.id === voice.id);

/**
 * The voices that read a film in another language. A copied voice speaks every language itself;
 * a free English voice is swapped for a free voice of that language (same gender), unless the maker
 * picked one for that language (settings.langVoices[lang]).
 */
export async function voicesForLang(settings, lang, { voice, storyVoice }) {
  if (!lang || !LANGS[lang]) return { voice, storyVoice };
  const pick = settings.langVoices?.[lang] || {};
  const edge = await edgeVoices().catch(() => []);
  const swap = (v) => {
    if (v?.provider === "elevenlabs") return v;
    const g = String(edge.find((x) => x.id === v?.id)?.gender || "male").toLowerCase() === "female" ? "female" : "male";
    const id = LANGS[lang].edge[g];
    return { provider: "edge", id, label: edge.find((x) => x.id === id)?.label || id, rate: v?.rate || 0, pitch: v?.pitch || 0 };
  };
  const nv = pick.voice?.id ? pick.voice : swap(voice);
  let sv = storyVoice ? (pick.storyVoice?.id ? pick.storyVoice : swap(storyVoice)) : null;
  // the same free voice for narrator and memories: keep the memories audibly different
  if (sv && !pick.storyVoice?.id && sv.provider === "edge" && sv.id === nv.id) sv = { ...sv, pitch: (sv.pitch || 0) - 6, rate: (sv.rate || 0) - 4 };
  return { voice: nv, storyVoice: sv };
}

// ---------- copying a voice (ElevenLabs instant voice cloning) ----------

/** Makes a voice from the maker's recorded samples (mp3 files). Returns the new voice id. */
export async function cloneVoice({ name, files, description = "" }) {
  if (!xiKey()) throw Object.assign(new Error("Own voices aren't set up on this server yet."), { status: 503 });
  const form = new FormData();
  form.append("name", name.slice(0, 100));
  form.append("description", description.slice(0, 500));
  form.append("remove_background_noise", "false"); // noise removal can flatten an accent; ask for a quiet room instead
  for (const f of files) form.append("files", new Blob([fs.readFileSync(f)], { type: "audio/mpeg" }), path.basename(f));
  const r = await fetchWithTimeout(`${XI}/v1/voices/add`, { method: "POST", headers: { "xi-api-key": xiKey() }, body: form }, 180000);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.voice_id) {
    const why = j.detail?.message || j.detail?.status || `HTTP ${r.status}`;
    throw Object.assign(new Error(`The voice couldn't be made: ${why}`), { status: 502 });
  }
  return j.voice_id;
}

export async function deleteClonedVoice(id) {
  if (!xiKey()) return;
  const r = await fetchWithTimeout(`${XI}/v1/voices/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "xi-api-key": xiKey() } });
  if (!r.ok && r.status !== 404) throw new Error(`ElevenLabs HTTP ${r.status}`);
}

/** Characters used and allowed this month on the shared ElevenLabs plan (null if unknown). */
export async function ownVoiceQuota() {
  if (!xiKey()) return null;
  try {
    const r = await fetchWithTimeout(`${XI}/v1/user/subscription`, { headers: { "xi-api-key": xiKey() } });
    if (!r.ok) return null;
    const j = await r.json();
    return { used: j.character_count, limit: j.character_limit, resetsAt: j.next_character_count_reset_unix ? new Date(j.next_character_count_reset_unix * 1000).toISOString() : null };
  } catch {
    return null;
  }
}

const pct = (n) => `${n >= 0 ? "+" : ""}${Math.round(Number(n) || 0)}%`;

async function edgeSynth(voice, text, outFile) {
  const tmp = ensureDir(path.join(path.dirname(outFile), `.tts-${newId(6)}`));
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice.id, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioFilePath } = await tts.toFile(tmp, text, { rate: pct(voice.rate), pitch: pct(voice.pitch) });
    fs.renameSync(audioFilePath, outFile);
  } finally {
    tts.close?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function elevenSynth(voice, text, outFile, lang) {
  if (!xiKey()) throw Object.assign(new Error("own voices aren't set up on this server"), { final: true });
  const r = await fetchWithTimeout(
    `${XI}/v1/text-to-speech/${encodeURIComponent(voice.id)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": xiKey(), "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        // eleven_v4 speaks 90+ languages (Hindi and Telugu included) in the copied voice
        model_id: process.env.ELEVENLABS_MODEL || "eleven_v4",
        ...(lang ? { language_code: lang } : {}),
        voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: Math.min(1.2, Math.max(0.7, 1 + (Number(voice.rate) || 0) / 100)) },
      }),
    },
    120000,
  );
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const e = new Error(`ElevenLabs: ${j.detail?.message || j.detail?.status || `HTTP ${r.status}`}`);
    e.final = [400, 401, 403, 404, 422].includes(r.status); // retrying won't help
    throw e;
  }
  fs.writeFileSync(outFile, Buffer.from(await r.arrayBuffer()));
}

export const DEFAULT_VOICE = { provider: "edge", id: "en-US-GuyNeural", rate: -5, pitch: 0, label: "Guy (en-US)" };

/**
 * What the voice should say: names respelled so text-to-speech pronounces them right
 * (e.g. Ferozepur → "Feerozepoor"), while captions and titles keep the real spelling.
 * list: [{ word, say }]; whole words, any case.
 */
export function spokenText(text, list) {
  let out = String(text || "");
  for (const { word, say } of Array.isArray(list) ? list : []) {
    const w = String(word || "").trim();
    if (!w || !String(say || "").trim()) continue;
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "giu"), String(say).trim());
  }
  return out;
}

/** lang: the film's language code ("te", "hi"); empty for English. */
export async function synthesize(voice, text, outFile, { lang = "" } = {}) {
  const v = voice?.id ? voice : DEFAULT_VOICE;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (v.provider === "elevenlabs") await elevenSynth(v, text, outFile, lang);
      else await edgeSynth(v, text, outFile);
      if (fs.statSync(outFile).size > 500) return outFile;
      throw new Error("empty audio");
    } catch (e) {
      lastErr = e;
      if (e.final) break;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`Narration voice failed: ${lastErr?.message}`);
}
