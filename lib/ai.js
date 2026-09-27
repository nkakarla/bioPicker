// BioPicker — all Claude calls (vision, document extraction, interview, history, casting, script).
// Copyright (c) 2026 ePerf
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { photoForAI } from "./photos.js";
import { projectPath } from "./store.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
const USE_FALLBACKS = process.env.CLAUDE_FALLBACKS !== "0";
let client;
const getClient = () => (client ??= new Anthropic());

export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// Structured-output schemas: every object closed and fully required.
const obj = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str = { type: "string" };
const num = { type: "number" };
const arr = (items) => ({ type: "array", items });

let fallbacksRejected = false;

async function askJSON({ system, content, schema, effort = "medium", maxTokens = 32000 }) {
  const base = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content }],
    output_config: { effort, format: { type: "json_schema", schema } },
  };
  let msg;
  if (USE_FALLBACKS && !fallbacksRejected) {
    try {
      msg = await getClient()
        .beta.messages.stream({ ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
        .finalMessage();
    } catch (e) {
      if (!(e instanceof Anthropic.BadRequestError)) throw e;
      // The account/model may not accept server-side fallbacks; run without them from now on.
      fallbacksRejected = true;
    }
  }
  if (!msg) msg = await getClient().messages.stream(base).finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("Claude declined this request.");
  if (msg.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off (max_tokens).");
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}

const TONES = {
  serious:
    "SERIOUS: a dignified, cinematic documentary. Warm, reflective, measured; think a public-television portrait. Respectful, never saccharine.",
  humorous:
    "HUMOROUS: affectionate and witty, like a roast delivered by a best friend who also narrates nature documentaries. Gentle irony, playful asides, comic timing — never mean, never mocking tragedy.",
  teachable:
    "TEACHABLE: an engaging history lesson for curious students. Explain context clearly, draw explicit lessons from choices the person made, pose a reflective question or two, and connect personal events to the history around them.",
};

function personBlock(p) {
  const person = p.person;
  const lines = Object.entries(person)
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `${k}: ${v}`);
  const tl = [...p.timeline]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((e) => `- [${e.id}] ${e.date || "?"} | ${e.type} | ${e.title}${e.place ? " @ " + e.place : ""}${e.description ? " — " + e.description : ""}`);
  const qa = p.interview.filter((q) => q.answer?.trim()).map((q) => `Q (${q.category}): ${q.question}\nA: ${q.answer}`);
  const photos = p.photos
    .filter((ph) => ph.include !== false)
    .map((ph) => `- [${ph.id}] ${ph.date || "undated"}${ph.place ? " @ " + ph.place : ""}: ${ph.caption || ph.ai?.description || ph.originalName}`);
  const docs = p.documents.map((d) => `- ${d.name}: ${d.summary || ""}`);
  return [
    "## PERSON",
    ...lines,
    "",
    "## TIMELINE",
    ...(tl.length ? tl : ["(none yet)"]),
    "",
    "## INTERVIEW ANSWERS",
    ...(qa.length ? qa : ["(none yet)"]),
    "",
    "## PHOTOS",
    ...(photos.length ? photos : ["(none)"]),
    "",
    "## DOCUMENTS",
    ...(docs.length ? docs : ["(none)"]),
  ].join("\n");
}

// ---------- photos ----------
const PHOTO_SCHEMA = obj({
  description: str,
  suggestedCaption: str,
  estimatedYearRange: str,
  lifeStage: str,
  setting: str,
  mood: str,
  peopleCount: num,
  focalX: num,
  focalY: num,
  clues: str,
});

export async function analyzePhoto(p, photo) {
  const buf = await photoForAI(p.id, photo);
  const who = p.person.name ? `The biopic subject is ${p.person.name}.` : "";
  return askJSON({
    effort: "low",
    maxTokens: 4000,
    system:
      "You catalogue personal photographs for a biographical documentary. Be concrete and brief. " +
      "Never identify real people by face; describe them (e.g. 'a young man in a graduation gown').",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } },
      {
        type: "text",
        text:
          `${who}\nKnown metadata: date=${photo.date || "unknown"}, place=${photo.place || "unknown"}, camera=${photo.exif?.camera || "unknown"}.\n` +
          "Describe the photo. focalX/focalY are the 0..1 coordinates (from top-left) of the most important subject — " +
          "where a slow Ken Burns zoom should end. estimatedYearRange from clothing, film stock, cars etc. (e.g. '1965-1975'). " +
          "lifeStage: childhood, teen, young adult, adult, later life, or unknown. clues: anything readable (signs, dates, school names).",
      },
    ],
    schema: PHOTO_SCHEMA,
  });
}

// ---------- documents ----------
const EVENT = obj({ date: str, type: str, title: str, place: str, description: str });
const DOC_SCHEMA = obj({ summary: str, events: arr(EVENT), facts: arr(str) });

export async function extractDocument(p, doc) {
  const file = projectPath(p.id, "docs", doc.file);
  const buf = fs.readFileSync(file);
  const ext = path.extname(doc.file).toLowerCase();
  let block;
  if (ext === ".pdf") block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } };
  else if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) {
    const mt = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" }[ext];
    block = { type: "image", source: { type: "base64", media_type: mt, data: buf.toString("base64") } };
  } else block = { type: "text", text: `DOCUMENT "${doc.name}":\n\n${buf.toString("utf8").slice(0, 400000)}` };
  return askJSON({
    effort: "medium",
    system:
      "You extract biographical facts from documents (resumes, certificates, obituaries, letters, articles, diplomas) " +
      "for a documentary about one person. Only report what the document supports.",
    content: [
      block,
      {
        type: "text",
        text:
          `Subject: ${p.person.name || "unknown"}.\nExtract dated life events. date as YYYY, YYYY-MM or YYYY-MM-DD. ` +
          "type is one of: birth, school, graduation, college, job, marriage, child, move, award, fame, military, retirement, death, other. " +
          "place is 'City, Region, Country' when known, else ''. facts: other useful details (personality, family, achievements).",
      },
    ],
    schema: DOC_SCHEMA,
  });
}

// ---------- interview ----------
const Q_SCHEMA = obj({
  questions: arr(obj({ question: str, why: str, category: str })),
});

export async function nextQuestions(p, count = 6) {
  const asked = p.interview.map((q) => `- ${q.question}${q.answer ? "" : " (unanswered)"}`).join("\n");
  return askJSON({
    effort: "medium",
    maxTokens: 8000,
    system:
      "You are a documentary producer interviewing a friend or relative of the subject (or the subject themself) " +
      "to write a great biopic. Ask warm, specific, story-eliciting questions — not generic ones. " +
      "Each question should unlock a scene: an anecdote, a turning point, a sensory detail, a quote, a relationship.",
    content: [
      {
        type: "text",
        text:
          personBlock(p) +
          `\n\n## ALREADY ASKED\n${asked || "(nothing yet)"}\n\n` +
          `The film's tone will be ${p.settings.tone}. Write ${count} NEW questions, covering gaps first. ` +
          "Categories to balance: personality, claim to fame, family & friends, turning points, humor & quirks, legacy, places. " +
          "Reference specifics you already know (names, dates, and only photos that appear in PHOTOS). category must be one of those words. " +
          "why = one short line on what the answer adds to the film.",
      },
    ],
    schema: Q_SCHEMA,
  });
}

// ---------- historical context ----------
const HIST_ITEM = obj({ year: str, title: str, description: str, scope: str });
const CONTEXT_SCHEMA = obj({
  eraOverview: str,
  moments: arr(
    obj({
      eventId: str,
      year: str,
      world: arr(HIST_ITEM),
      local: arr(HIST_ITEM),
      culturalShift: str,
      influence: str,
      archivalQuery: str,
      artQuery: str,
    }),
  ),
});

export async function historicalContext(p) {
  return askJSON({
    effort: "high",
    system:
      "You are a meticulous historian and documentary researcher. For each life event, list major world events and " +
      "local/regional events (near the event's place) from roughly that year, plus the cultural shift of the moment " +
      "(music, technology, social change) and a thoughtful, hedged note on how it MAY have influenced this person. " +
      "Only include events you are confident happened in that year; prefer famous, well-documented ones.",
    content: [
      {
        type: "text",
        text:
          personBlock(p) +
          "\n\nFor EVERY timeline event (use its [id] as eventId) give 1-3 world items and 0-2 local items. " +
          "scope is 'world', 'national' or 'local'. archivalQuery: a short search phrase for PUBLIC-DOMAIN newsreel/film footage " +
          "of the most iconic world event of that moment (e.g. 'Apollo 11 moon landing', 'Berlin Wall fall 1989'); '' if none fits. " +
          "artQuery: a short phrase to find a public-domain painting or print that evokes the mood/theme of this life moment " +
          "(e.g. 'harbor sunrise', 'schoolhouse', 'city at night'). eraOverview: 2-3 sentences on the arc of history across their life.",
      },
    ],
    schema: CONTEXT_SCHEMA,
  });
}

// ---------- voice casting ----------
const CAST_SCHEMA = obj({ voiceId: str, rate: num, pitch: num, rationale: str });

export async function castVoice(p, voices) {
  const list = voices.map((v) => `${v.id} | ${v.gender} | ${v.locale} | ${v.personality || ""}`).join("\n");
  return askJSON({
    effort: "low",
    maxTokens: 4000,
    system: "You are a casting director choosing the narrator for a biographical documentary.",
    content: [
      {
        type: "text",
        text:
          personBlock(p) +
          `\n\nTone: ${p.settings.tone}.\nAVAILABLE VOICES (id | gender | locale | personality):\n${list}\n\n` +
          "Choose the voice id that best suits narrating THIS person's story (their heritage/region, era, personality and the tone). " +
          "rate is a percent adjustment -20..20 (slower for gravitas), pitch a percent adjustment -10..10. " +
          "rationale: one or two sentences the user will read.",
      },
    ],
    schema: CAST_SCHEMA,
  });
}

// ---------- script ----------
const VISUAL = obj({ type: str, ref: str, caption: str });
const SCENE = obj({
  kind: str,
  eventId: str,
  year: str,
  place: str,
  narration: str,
  onScreenTitle: str,
  onScreenSubtitle: str,
  visuals: arr(VISUAL),
  transition: str,
});
const SCRIPT_SCHEMA = obj({
  title: str,
  tagline: str,
  musicMood: str,
  musicQueries: arr(str),
  scenes: arr(SCENE),
});

// Narration words that fit a runtime, leaving room for scene breaths, crossfades and the credits.
export function wordBudget(targetSeconds, rate = 0) {
  const scenes = Math.max(6, Math.min(60, Math.round(targetSeconds / 10)));
  const credits = targetSeconds <= 150 ? 6 : 12;
  const talk = Math.max(20, targetSeconds - credits - scenes * 1.6);
  return { words: Math.round(talk * 2.45 * (1 + (Number(rate) || 0) / 100)), scenes };
}

export async function writeScript(p, version, targetSeconds) {
  const { words, scenes: sceneCount } = wordBudget(targetSeconds, p.settings.voice?.rate);
  return askJSON({
    effort: "high",
    system:
      "You are an award-winning documentary writer and editor. You write narration that sounds great read aloud " +
      "by a single narrator (no stage directions, no speaker labels, no emojis, spell out numbers when natural), " +
      "and you cut pictures to it. You never invent facts about the person: when unsure, stay general or frame it " +
      "as possibility ('perhaps', 'it's easy to imagine'). Historical events must be real.",
    content: [
      {
        type: "text",
        text:
          personBlock(p) +
          `\n\n## HISTORICAL RESEARCH\n${ctx}\n\n` +
          `## BRIEF\nTone — ${TONES[p.settings.tone] || TONES.serious}\n` +
          `Version: ${version} cut, target runtime ${targetSeconds} seconds. HARD LIMIT: at most ${words} narration words in total ` +
          `(count them), across roughly ${sceneCount} scenes of about ${Math.round(words / sceneCount)} words each. Brevity is the soul of this cut. Narration pronouns for the subject: ${p.person.pronouns}.\n\n` +
          "Structure: open with a hook + title scene; move chronologically through the timeline (birth, schooling, graduation, " +
          "college, work, claim to fame, family, later life); weave in 'meanwhile in the world' context scenes that connect " +
          "history and culture to the person's choices; end with legacy and a closing line.\n\n" +
          "Scene fields:\n" +
          "- kind: title | life | context | lesson | legacy | closing\n" +
          "- eventId: the timeline [id] the scene belongs to, or ''\n" +
          "- year, place: for the on-screen lower third ('' if n/a)\n" +
          "- onScreenTitle / onScreenSubtitle: short lower-third text (e.g. '1969' / 'Houston, Texas'); for lesson scenes the takeaway\n" +
          "- visuals: 1-3 items shown in order during the scene. type is one of:\n" +
          "    photo   → ref = a photo [id] from PHOTOS (use each photo at most once or twice; use as many photos as fit)\n" +
          "    map     → ref = a place name, used when the story moves somewhere new\n" +
          (includeArchival ? "    archival → ref = search phrase for public-domain newsreel/film footage of a famous real event\n" : "") +
          (includeArt ? "    art     → ref = search phrase for a public-domain painting/print evoking the moment\n" : "") +
          "    still   → ref = search phrase for a public-domain historical photograph (e.g. 'Woodstock 1969')\n" +
          "    card    → ref = short text shown as a title card (use sparingly)\n" +
          "  caption: short on-screen credit/label for archival/art/still ('' for photos)\n" +
          "- transition into this scene: fade (default) | fadeblack (chapter change) | wipeleft | slideup (use the last two rarely)\n\n" +
          "musicMood: a phrase describing the score. musicQueries: 3-4 PUBLIC-DOMAIN classical/ragtime/folk/march compositions " +
          "that fit (composers who died before 1930, e.g. 'Satie Gymnopedie', 'Scott Joplin The Entertainer', 'Debussy Clair de Lune').",
      },
    ],
    schema: SCRIPT_SCHEMA,
  });
}

const TIGHTEN_SCHEMA = obj({ narrations: arr(str) });

// Second pass when a script overshoots its word budget: shorten every scene, keep the voice.
export async function tightenScript(script, words) {
  const numbered = script.scenes.map((s, i) => `${i}. ${s.narration}`).join("\n");
  const r = await askJSON({
    effort: "medium",
    maxTokens: 16000,
    system: "You are a documentary editor cutting narration to time without losing its voice, humour or key facts.",
    content: [
      {
        type: "text",
        text:
          `These ${script.scenes.length} narration lines total too many words. Rewrite them so the TOTAL is at most ${words} words. ` +
          "Keep the same number of lines in the same order, keep the tone, keep every fact true, keep each line speakable.\n\n" +
          numbered,
      },
    ],
    schema: TIGHTEN_SCHEMA,
  });
  if (r.narrations.length === script.scenes.length) r.narrations.forEach((n, i) => (script.scenes[i].narration = n));
  return script;
}

// ---------- media picking ----------
const PICK_SCHEMA = obj({ picks: arr(obj({ key: str, index: num })) });

export async function pickMedia(requests) {
  // requests: [{key, want, candidates:[{title, source, date}]}]
  if (!requests.length) return { picks: [] };
  const text = requests
    .map(
      (r) =>
        `KEY ${r.key}\nWANT: ${r.want}\n` +
        r.candidates.map((c, i) => `  ${i}: ${c.title} (${c.source}${c.date ? ", " + c.date : ""})`).join("\n"),
    )
    .join("\n\n");
  return askJSON({
    effort: "low",
    maxTokens: 8000,
    system: "You pick the best matching archival media for documentary scenes.",
    content: [
      {
        type: "text",
        text:
          text +
          "\n\nFor each KEY choose the candidate index that best depicts WANT (right event, right era). " +
          "Use -1 if none is a reasonable match.",
      },
    ],
    schema: PICK_SCHEMA,
  });
}
