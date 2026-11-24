// BioPicker — all Claude calls (vision, document extraction, interview, history, casting, script).
// Copyright (c) 2026 EPerf
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { photoForAI } from "./photos.js";
import { projectPath } from "./store.js";
import { getBilling, recordAI } from "./usage.js";

// The admin panel's choice (Plans & paywall → AI prices), else CLAUDE_MODEL, else Claude Sonnet 5.
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
export const currentModel = () => getBilling().aiModel || DEFAULT_MODEL;
export const defaultModel = DEFAULT_MODEL;
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

/** task names the kind of call for usage reports (photo, document, interview, history, voice, series, script, tighten, media). */
async function askJSON({ task, system, content, schema, effort = "medium", maxTokens = 32000 }) {
  const model = currentModel();
  const base = {
    model,
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
  // count the tokens before any check below: a refused or cut-off answer is still billed
  try {
    recordAI(task, model, msg);
  } catch (e) {
    console.error("[usage]", e);
  }
  if (msg.stop_reason === "refusal") throw Object.assign(new Error("Claude declined this request."), { refusal: true });
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

const isDoc = (p) => p.kind === "documentary";
const wordCount = (s) => String(s || "").split(/\s+/).filter(Boolean).length;

/** What the AI knows about a documentary made from the maker's own script. */
function storyBlock(p, { research = true } = {}) {
  const s = p.story || {};
  const pics = p.photos
    .filter((ph) => ph.include !== false)
    .map((ph) => `- [${ph.id}] ${ph.illustration ? "(illustration) " : ""}${ph.caption || ph.originalName}${ph.ai?.description ? " | shows: " + ph.ai.description : ""}`);
  const picked = (p.research?.events || []).filter((e) => e.include !== false);
  const lines = [
    "## THE DOCUMENTARY",
    `Working title: ${p.person.name || "(untitled)"}`,
    s.about ? `About: ${s.about}` : "",
    s.period ? `Period: ${s.period}` : "",
    s.place ? `Place: ${s.place}` : "",
    "",
    "## THE WRITER'S SCRIPT (their own words and notes; every personal fact comes only from here)",
    s.text?.trim() || "(none yet)",
    "",
    "## PICTURES (the writer's own; many are illustrations made from memory, not photographs)",
    ...(pics.length ? pics : ["(none)"]),
  ];
  if (research && p.research) {
    lines.push("", "## BACKGROUND RESEARCH (the events the writer chose to include)", `Overview: ${p.research.overview}`);
    for (const e of picked) lines.push(`- [${e.id}] ${e.date} | ${e.scope} | ${e.title} — ${e.description}${e.archivalQuery ? ` (footage: ${e.archivalQuery})` : ""}`);
  }
  return lines.filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
}

function personBlock(p) {
  if (isDoc(p)) return storyBlock(p);
  const person = p.person;
  const lines = Object.entries(person)
    .filter(([k, v]) => k !== "pronouns" && v && String(v).trim())
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
  concern: str,
});

export async function analyzePhoto(p, photo) {
  const buf = await photoForAI(p.id, photo);
  const who = isDoc(p)
    ? `This picture is for a documentary${p.story?.about ? " about " + p.story.about : ""}. It may be an illustration made from memory rather than a photograph; describe what it shows either way.`
    : p.person.name ? `The biopic subject is ${p.person.name}.` : "";
  return askJSON({
    task: "photo",
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
          "lifeStage: childhood, teen, young adult, adult, later life, or unknown. clues: anything readable (signs, dates, school names). " +
          "concern: '' for almost every photo. Only if it shows nudity or sexual content, graphic injury or gore, a hate symbol shown approvingly, " +
          "or something plainly meant to humiliate a person, say what in a few plain words (ordinary family, beach, war-era or medical photos are fine).",
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
    task: "document",
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
    task: "interview",
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
    task: "history",
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
    task: "voice",
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

// ---------- documentary series ----------
const SERIES_SCHEMA = obj({
  title: str,
  episodes: arr(obj({ title: str, logline: str, from: str, to: str, eventIds: arr(str) })),
});

/** Splits the life into episodes. count 0 = choose 2-8 from how much material there is. */
export async function planSeries(p, count, episodeSeconds) {
  const mins = Math.round(episodeSeconds / 60);
  return askJSON({
    task: "series",
    effort: "high",
    system:
      "You are a documentary series producer. You divide a real person's life into episodes that each stand on their own " +
      "and build to a satisfying whole. You never invent facts about the person.",
    content: [{
      type: "text",
      text:
        personBlock(p) +
        `\n\n## BRIEF\nPlan a documentary SERIES about this person, each episode about ${mins} minutes. ` +
        (count ? `Exactly ${count} episodes.` : "Choose the number of episodes (2-8) that the material can genuinely fill; do not pad.") +
        "\nSplit mostly chronologically (childhood & roots, education, career, claim to fame, family, later life & legacy), " +
        "but group by theme where that tells the story better. Every timeline event should land in exactly one episode (eventIds = timeline [id]s). " +
        "title: the series title. Each episode: a short evocative title, a one-sentence logline, from/to = the years it spans.",
    }],
    schema: SERIES_SCHEMA,
  });
}

function episodeBrief(p, ep) {
  const all = p.series?.episodes || [];
  const list = all.map((e, i) => `  ${i + 1}. ${e.title} (${e.from}-${e.to})${i + 1 === ep.n ? "  <== THIS EPISODE" : ""}`).join("\n");
  return (
    `SERIES: "${p.series?.title || ""}", episode ${ep.n} of ${all.length}: "${ep.title}" (${ep.from}-${ep.to}).\n` +
    `What it covers: ${ep.logline}\nTimeline events for this episode: ${(ep.eventIds || []).join(", ") || "(choose from the years above)"}\n` +
    `All episodes:\n${list}\nThe film title should be "${ep.title}". `
  );
}

export async function writeScript(p, version, targetSeconds, episode = null) {
  const { words, scenes: sceneCount } = wordBudget(targetSeconds, p.settings.voice?.rate);
  const ctx = p.context
    ? JSON.stringify(p.context)
    : "(no historical research yet — use only well-known events you are sure of)";
  const includeArchival = p.settings.includeArchival;
  const includeArt = p.settings.includeArt;
  return askJSON({
    task: "script",
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
          (episode ? episodeBrief(p, episode) : `Version: ${version} cut, `) +
          `target runtime ${targetSeconds} seconds. HARD LIMIT: at most ${words} narration words in total ` +
          `(count them), across roughly ${sceneCount} scenes of about ${Math.round(words / sceneCount)} words each. Brevity is the soul of this cut. Refer to the subject by name; take any pronouns only from the materials provided, never assume them.\n\n` +
          (episode
            ? "Structure: a short cold open, then a title scene whose onScreenTitle is 'Episode N' and onScreenSubtitle the episode title; " +
              "tell ONLY this episode's part of the life in depth (mention other periods in a sentence at most); weave in 'meanwhile in the world' " +
              "context scenes for these years; end with a closing line: for every episode but the last, a teaser for the next episode; for the last, legacy.\n\n"
            : "Structure: open with a hook + title scene; move chronologically through the timeline (birth, schooling, graduation, " +
              "college, work, claim to fame, family, later life); weave in 'meanwhile in the world' context scenes that connect " +
              "history and culture to the person's choices; end with legacy and a closing line.\n\n") +
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

// ---------- documentaries (from the maker's own script) ----------
const RESEARCH_SCHEMA = obj({
  overview: str,
  events: arr(obj({ date: str, title: str, description: str, scope: str, relevance: str, archivalQuery: str, stillQuery: str, mapPlace: str })),
  factChecks: arr(obj({ claim: str, note: str })),
});

/** The history around the writer's story: events to weave in, and notes on claims in the script that history qualifies. */
export async function researchTopic(p) {
  return askJSON({
    task: "history",
    effort: "high",
    system:
      "You are a meticulous historian and documentary researcher. You give balanced, well-documented history from " +
      "mainstream scholarship. Where the sides' accounts differ (causes, who won, casualties), you say so plainly instead of taking a side. " +
      "Only include events you are confident happened, with dates you are confident of.",
    content: [{
      type: "text",
      text:
        storyBlock(p, { research: false }) +
        "\n\n## BRIEF\nResearch the background for this documentary. Work out the setting (where, when, what was happening) from the script. " +
        "events: 8-16 items in date order covering: the big picture and its causes; the leaders and the international situation; " +
        "what happened nearest the writer's place and time (battles, movements of troops, air raids, blackouts, evacuations); " +
        "life on the home front (rationing, radio, slogans, prices, how ordinary families coped); and how it ended and what followed. " +
        "date: YYYY, YYYY-MM or YYYY-MM-DD. scope: world | national | local. relevance: one sentence on how it touches the writer's story. " +
        "archivalQuery: a short search phrase for public-domain newsreel footage of this event ('' if unlikely to exist). " +
        "stillQuery: a short search phrase for a public-domain historical photograph ('' if none). mapPlace: a place name to show on a map, or ''. " +
        "overview: 3-4 sentences a narrator could build on. " +
        "factChecks: claims in the writer's script that mainstream history qualifies, disputes or gets wrong (dates, alliances, causes, outcomes); " +
        "claim = the writer's words briefly, note = what historians say, gently and specifically. Only real issues; [] if none. " +
        "Never question the writer's personal memories, only general historical claims.",
    }],
    schema: RESEARCH_SCHEMA,
  });
}

const DOC_SCENE = obj({
  kind: str,
  voice: str,
  year: str,
  place: str,
  narration: str,
  onScreenTitle: str,
  onScreenSubtitle: str,
  visuals: arr(VISUAL),
  transition: str,
});
const DOC_SCRIPT_SCHEMA = obj({ title: str, tagline: str, musicMood: str, musicQueries: arr(str), scenes: arr(DOC_SCENE) });

const WORDING = {
  keep:
    "Use the writer's own sentences as written, in their order where possible. You may fix spelling, spell out abbreviations " +
    "for the ear, split long passages across scenes, and must drop notes meant for an illustrator or editor (e.g. 'render multiple panels…', " +
    "'don't forget the tree'). Do not otherwise rewrite them. Your own words go only in the narrator's commentary scenes.",
  polish:
    "Keep the writer's voice, facts and best phrases, but turn notes into flowing, speakable sentences and tighten them. " +
    "Drop notes meant for an illustrator or editor (e.g. 'render multiple panels…'). Never add personal details that are not in the script.",
  notes:
    "Treat the script as notes. Write fresh narration from them, keeping every personal fact true to the notes and adding none. " +
    "Ignore notes meant for an illustrator or editor.",
};

/** Docs: true when the writer's sentences must survive as written (so the script is not machine-tightened). */
export const keepsWording = (p) => isDoc(p) && p.story?.wording === "keep";

export async function writeDocumentary(p, version, targetSeconds) {
  const s = p.story || {};
  const { words, scenes: sceneCount } = wordBudget(targetSeconds, p.settings.voice?.rate);
  const first = s.telling !== "third";
  const mine = wordCount(s.text);
  const budget = keepsWording(p)
    ? `The writer's kept sentences take what they take (about ${mine} words at most); add at most ${Math.max(60, words - mine)} words of commentary.`
    : `HARD LIMIT: at most ${words} narration words in total (count them), across roughly ${sceneCount} scenes.`;
  return askJSON({
    task: "script",
    effort: "high",
    system:
      "You are an award-winning documentary writer and editor. You turn a writer's own story into a documentary that weaves their " +
      "memories with the history around them. You write narration that sounds great read aloud (no stage directions, no speaker labels, " +
      "no emojis, numbers spelled out when natural) and you cut pictures to it. You never invent personal facts. History must be real and " +
      "balanced: present each side fairly and say where accounts differ. Opinions in the writer's script stay theirs, in their voice; the " +
      "narrator does not state them as fact.",
    content: [{
      type: "text",
      text:
        storyBlock(p) +
        `\n\n## BRIEF\nTone — ${TONES[p.settings.tone] || TONES.serious}\n` +
        `Version: ${version} cut, target runtime ${targetSeconds} seconds. ${budget}\n\n` +
        `The writer's words — ${WORDING[s.wording] || WORDING.polish}\n\n` +
        (first
          ? "Two voices. voice='story' scenes are the writer remembering, in the FIRST person ('I', 'my brother', 'our house'), as the writer. " +
            "voice='narrator' scenes are a documentary narrator giving the history and background in the third person. Alternate them so " +
            "the history frames each memory: what the world was doing, then what the writer saw.\n\n"
          : "One narrator tells everything in the third person (voice='narrator' on every scene); refer to the writer and family as the script names them.\n\n") +
        "Balance: the writer's memories are the heart of the film. Give them about half of the narration (more if the script is mostly memories); " +
        "the history is there to frame them, so pick only the background events that explain what the writer lived through, and fold the rest into a line or two. " +
        "Use every concrete detail of the memories (people, ages, the house, the road, the tree, animals, what the children did and saw).\n\n" +
        "Structure: a short cold open on a vivid moment from the writer's memories; a title scene; then the story in order, with " +
        "the background research woven in where it explains what the writer lived through (use the chosen events; prefer those nearest the " +
        "writer's place and time); end with how it ended, what followed, and a closing line (the writer's own reflection if the script has one; " +
        "otherwise a brief, hedged narrator close).\n\n" +
        "Scene fields:\n" +
        "- kind: title | memory | context | closing\n" +
        "- voice: story | narrator\n" +
        "- year, place: for the on-screen lower third ('' if n/a)\n" +
        "- onScreenTitle / onScreenSubtitle: short lower-third text (e.g. 'September 1965' / 'Ferozepur, Punjab')\n" +
        "- visuals: 1-3 items shown in order during the scene. type is one of:\n" +
        "    photo   → ref = a picture [id] from PICTURES. Use every picture; one may carry more than one scene. Memory scenes should show the writer's pictures.\n" +
        "    map     → ref = a place name, when the story moves somewhere new or to show where events happened\n" +
        (p.settings.includeArchival ? "    archival → ref = search phrase for public-domain newsreel/film footage of a real event\n" : "") +
        (p.settings.includeArt ? "    art     → ref = search phrase for a public-domain painting/print evoking the moment\n" : "") +
        "    still   → ref = search phrase for a public-domain historical photograph\n" +
        "    card    → ref = short text shown as a title card (use sparingly, e.g. a date or a slogan)\n" +
        "  caption: short on-screen credit/label for archival/still/art ('' for pictures)\n" +
        "- transition into this scene: fade (default) | fadeblack (chapter change) | wipeleft | slideup (use the last two rarely)\n\n" +
        "musicMood: a phrase describing the score. musicQueries: 3-4 PUBLIC-DOMAIN compositions that fit " +
        "(composers who died before 1930, or traditional folk melodies of the region).",
    }],
    schema: DOC_SCRIPT_SCHEMA,
  });
}

const TIGHTEN_SCHEMA = obj({ narrations: arr(str) });

// Second pass when a script overshoots its word budget: shorten every scene, keep the voice.
export async function tightenScript(script, words) {
  const numbered = script.scenes.map((s, i) => `${i}. ${s.narration}`).join("\n");
  const r = await askJSON({
    task: "tighten",
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

// ---------- content check (before a film is rendered) ----------
export const CONTENT_CATEGORIES = ["sexual", "minors", "hate", "harassment", "violence", "self-harm", "privacy", "illegal", "other"];
const REVIEW_SCHEMA = obj({ hold: { type: "boolean" }, categories: arr(str), reason: str, notes: str });

/** Reads a film's script and photo notes against BioPicker's content rules. material is plain text. */
export async function reviewContent(material) {
  return askJSON({
    task: "safety",
    effort: "low",
    maxTokens: 4000,
    system:
      "You check biographical films before BioPicker renders them, against its content rules. Most biopics are tributes to " +
      "relatives, friends or public figures. Real lives include war, illness, death, crime, addiction, grief and hard history; " +
      "telling them honestly is fine, as are factual accounts of historical atrocities, a quoted swear word, and affectionate teasing " +
      "in a humorous film.\n\n" +
      "HOLD the film only for a clear case of:\n" +
      "- sexual: sexually explicit content (anything sexual involving a minor is category 'minors', always held)\n" +
      "- hate: attacking or demeaning people for race, ethnicity, religion, nationality, gender, sexuality, disability or similar\n" +
      "- harassment: a film made to mock, humiliate, threaten or defame a real person rather than tell their story\n" +
      "- violence: praising or promoting violence, terrorism or cruelty, or gore for its own sake\n" +
      "- self-harm: encouraging suicide, self-harm or eating disorders\n" +
      "- privacy: exposing a private person's home address, phone number, or intimate or medical secrets to embarrass them\n" +
      "- illegal: instructions for, or promotion of, serious crimes\n" +
      "- other: anything else plainly abusive\n\n" +
      "When it is a judgement call, do not hold; a person reviews every hold, and wrongly holding a family's tribute is a real harm. " +
      "Put milder worries in notes instead.",
    content: [{
      type: "text",
      text:
        material +
        "\n\nhold: true only for a clear breach. categories: the matching words from the list (empty when not held). " +
        "reason: when held, one or two plain sentences the film's maker will read, saying what the problem is without repeating " +
        "offensive words; '' otherwise. notes: anything a reviewer might want to look at even though it isn't held; '' if nothing.",
    }],
    schema: REVIEW_SCHEMA,
  });
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
    task: "media",
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
