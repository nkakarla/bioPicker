// BioPicker — narration voices. Providers: Microsoft Edge neural voices (default, no key),
// ElevenLabs (when ELEVENLABS_API_KEY is set). Copyright (c) 2026 ePerf
import fs from "node:fs";
import path from "node:path";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { ensureDir, fetchWithTimeout, newId, sleep } from "./util.js";

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

async function elevenVoices() {
  if (!process.env.ELEVENLABS_API_KEY) return [];
  try {
    const r = await fetchWithTimeout("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.voices || []).map((v) => ({
      provider: "elevenlabs",
      id: v.voice_id,
      label: `${v.name} (ElevenLabs)`,
      gender: v.labels?.gender || "",
      locale: v.labels?.accent || "en",
      personality: [v.labels?.description, v.labels?.age, v.labels?.use_case].filter(Boolean).join(", "),
    }));
  } catch {
    return [];
  }
}

export async function listVoices() {
  const [edge, eleven] = await Promise.all([edgeVoices().catch(() => []), elevenVoices()]);
  return [...eleven, ...edge];
}

// Voices worth offering to the casting AI: the narration language plus English variants.
export async function castingShortlist(language = "en") {
  const all = await listVoices();
  const lang = language.toLowerCase().slice(0, 2);
  return all.filter((v) => v.provider !== "edge" || v.locale.toLowerCase().startsWith(lang) || v.locale.startsWith("en-"));
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

async function elevenSynth(voice, text, outFile) {
  const r = await fetchWithTimeout(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.id)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1 + (Number(voice.rate) || 0) / 100 },
      }),
    },
    120000,
  );
  if (!r.ok) throw new Error(`ElevenLabs HTTP ${r.status}`);
  fs.writeFileSync(outFile, Buffer.from(await r.arrayBuffer()));
}

export const DEFAULT_VOICE = { provider: "edge", id: "en-US-GuyNeural", rate: -5, pitch: 0, label: "Guy (en-US)" };

export async function synthesize(voice, text, outFile) {
  const v = voice?.id ? voice : DEFAULT_VOICE;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (v.provider === "elevenlabs") await elevenSynth(v, text, outFile);
      else await edgeSynth(v, text, outFile);
      if (fs.statSync(outFile).size > 500) return outFile;
      throw new Error("empty audio");
    } catch (e) {
      lastErr = e;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`Narration voice failed: ${lastErr?.message}`);
}
