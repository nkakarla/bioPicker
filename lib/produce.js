// BioPicker — production: resolve media for a script, then render the film with ffmpeg.
// Copyright (c) 2026 ePerf
import fs from "node:fs";
import path from "node:path";
import { pickMedia } from "./ai.js";
import {
  KB_SCALE, captionOverlay, creditsCard, lowerThird, mapCard, prepareStill, sourceTag, textCard, titleCard, watermark,
} from "./cards.js";
import { geocode } from "./geo.js";
import { fetchAudio, fetchImage, fetchVideoClip, searchMedia } from "./media.js";
import { nextFilmNumber, projectPath, saveProject, syncRenders } from "./store.js";
import { DEFAULT_VOICE, synthesize } from "./tts.js";
import { COPYRIGHT, ensureDir, ffmpeg, newId, probeDuration, yearOf } from "./util.js";

const FPS = 30;
const T = 0.8; // crossfade seconds
const SIZES = { "480p": [854, 480], "720p": [1280, 720], "1080p": [1920, 1080] };
const XFADES = new Set(["fade", "fadeblack", "wipeleft", "wiperight", "slideup", "slideleft", "smoothleft", "circleopen"]);

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

// ======================= media resolution =======================

export async function resolveMedia(p, version, log = () => {}) {
  const script = p.scripts[version];
  if (!script) throw new Error("No script for this version yet.");
  const photosById = Object.fromEntries(p.photos.map((ph) => [ph.id, ph]));
  const usable = p.photos.filter((ph) => ph.include !== false);
  const mediaDir = projectPath(p.id, "media");
  const searchCache = new Map();
  const search = async (type, q) => {
    const key = `${type}|${q}`;
    if (!searchCache.has(key)) searchCache.set(key, await searchMedia(type, q).catch(() => []));
    return searchCache.get(key);
  };

  const needPick = [];
  for (const [si, scene] of script.scenes.entries()) {
    for (const [vi, v] of scene.visuals.entries()) {
      v.type = String(v.type || "").toLowerCase();
      if (v.asset && v.locked) continue;
      if (v.type === "photo") {
        let ph = photosById[v.ref];
        if (!ph) ph = usable.find((x) => x.eventId && x.eventId === scene.eventId) || null;
        v.asset = ph ? { kind: "photo", photoId: ph.id } : null;
      } else if (v.type === "map") {
        const g = await geocode(v.ref || scene.place);
        v.asset = g ? { kind: "map", lat: g.lat, lon: g.lon, label: v.ref || scene.place } : null;
      } else if (v.type === "card") {
        v.asset = { kind: "card" };
      } else if (["archival", "still", "art"].includes(v.type)) {
        if ((v.type === "archival" && !p.settings.includeArchival) || (v.type === "art" && !p.settings.includeArt)) {
          v.asset = null;
          continue;
        }
        log(`Searching public-domain ${v.type}: "${v.ref}"`);
        let cands = await search(v.type, v.ref);
        if (!cands.length && v.type === "archival") cands = await search("still", v.ref);
        if (!cands.length && v.type !== "art" && p.settings.includeArt) cands = await search("art", v.ref);
        v.candidates = cands.slice(0, 8);
        v.candIndex = 0;
        if (v.candidates.length > 1) {
          needPick.push({
            key: `${si}.${vi}`,
            want: `${v.ref} (${scene.year || "any year"}) — for a scene about: ${scene.narration.slice(0, 160)}`,
            candidates: v.candidates,
          });
        }
      }
    }
  }

  if (needPick.length) {
    log(`Asking Claude to choose the best of ${needPick.length} archival/art searches…`);
    try {
      const { picks } = await pickMedia(needPick);
      for (const pk of picks) {
        const [si, vi] = pk.key.split(".").map(Number);
        const v = script.scenes[si]?.visuals[vi];
        if (!v?.candidates) continue;
        if (pk.index < 0) v.candidates = [];
        else if (pk.index < v.candidates.length) v.candIndex = pk.index;
      }
    } catch (e) {
      log(`Media pick skipped: ${e.message}`);
    }
  }

  // download chosen candidates (falling back to the next candidate on failure)
  const jobs = [];
  script.scenes.forEach((scene) =>
    scene.visuals.forEach((v) => {
      if (v.candidates && !(v.asset && v.locked)) jobs.push(v);
    }),
  );
  await pool(jobs, 2, async (v) => {
    v.asset = null;
    const order = [v.candIndex, ...v.candidates.map((_, i) => i).filter((i) => i !== v.candIndex)];
    for (const idx of order.slice(0, 4)) {
      const c = v.candidates[idx];
      if (!c) continue;
      try {
        const base = newId(8);
        if (c.kind === "video") {
          log(`Fetching clip: ${c.title} (${c.source})`);
          const f = `${base}.mp4`;
          await fetchVideoClip(c, path.join(mediaDir, f));
          v.asset = { kind: "video", file: f, ...credit(c) };
        } else {
          log(`Fetching image: ${c.title} (${c.source})`);
          const f = `${base}.jpg`;
          await fetchImage(c, path.join(mediaDir, f));
          v.asset = { kind: "image", file: f, ...credit(c) };
        }
        v.candIndex = idx;
        break;
      } catch (e) {
        log(`  skipped (${e.message.slice(0, 120)})`);
      }
    }
  });

  // drop empty visuals; make sure every scene shows something
  let photoCursor = 0;
  for (const scene of script.scenes) {
    scene.visuals = scene.visuals.filter((v) => v.asset);
    if (!scene.visuals.length) {
      const ph = usable.find((x) => x.eventId && x.eventId === scene.eventId) || usable[photoCursor++ % Math.max(1, usable.length)];
      scene.visuals.push(
        ph
          ? { type: "photo", ref: ph.id, caption: "", asset: { kind: "photo", photoId: ph.id } }
          : { type: "card", ref: scene.onScreenTitle || p.person.name, caption: "", asset: { kind: "card" } },
      );
    }
  }

  await resolveMusic(p, script, log);
  script.mediaResolvedAt = new Date().toISOString();
  saveProject(p);
  return script;
}

const credit = (c) => ({
  title: c.title,
  source: c.source,
  license: c.license,
  credit: c.credit,
  pageUrl: c.pageUrl,
  thumb: c.thumb,
});

async function resolveMusic(p, script, log) {
  const mode = p.settings.music;
  script.music = [];
  if (mode === "none") return;
  if (mode === "upload" && p.uploadedMusic.length) {
    script.music = p.uploadedMusic.map((m) => ({ file: m.file, dir: "music", title: m.name, source: "Uploaded by user", license: "Provided by user", credit: "" }));
    return;
  }
  if (mode === "generated") return;
  for (const q of script.musicQueries || []) {
    if (script.music.length >= 2) break;
    log(`Searching public-domain music: "${q}"`);
    const cands = await searchMedia("music", q).catch(() => []);
    for (const c of cands.slice(0, 3)) {
      try {
        const f = `${newId(8)}.mp3`;
        await fetchAudio(c, path.join(projectPath(p.id, "media"), f));
        const d = await probeDuration(path.join(projectPath(p.id, "media"), f));
        if (d < 30) continue;
        script.music.push({ file: f, dir: "media", ...credit(c) });
        break;
      } catch (e) {
        log(`  music skipped (${e.message.slice(0, 100)})`);
      }
    }
  }
  if (!script.music.length) log("No public-domain recording found; an original ambient score will be generated.");
}

// Original ambient pad (A minor – F – C – G), 32 s loop, generated from sine waves: no copyright.
async function generateAmbient(dest) {
  const chords = [
    [220.0, 261.63, 329.63],
    [174.61, 220.0, 261.63],
    [130.81, 196.0, 261.63],
    [196.0, 246.94, 293.66],
  ];
  const inputs = [];
  for (const ch of chords) {
    const expr = ch
      .map((f, i) => `${(0.09 - i * 0.015).toFixed(3)}*sin(2*PI*${f}*t)*(0.7+0.3*sin(2*PI*${(0.13 + i * 0.07).toFixed(2)}*t))`)
      .join("+") + `+0.04*sin(2*PI*${(ch[0] / 2).toFixed(2)}*t)`;
    inputs.push("-f", "lavfi", "-i", `aevalsrc='${expr}':s=44100:d=8`);
  }
  const fil =
    chords.map((_, i) => `[${i}:a]afade=t=in:d=1.5,afade=t=out:st=6:d=2[c${i}]`).join(";") +
    `;[c0][c1]acrossfade=d=1.5[x1];[x1][c2]acrossfade=d=1.5[x2];[x2][c3]acrossfade=d=1.5,lowpass=f=1800,aecho=0.8:0.7:120|240:0.35|0.2,pan=stereo|c0=c0|c1=c0[out]`;
  await ffmpeg([...inputs, "-filter_complex", fil, "-map", "[out]", "-b:a", "192k", dest]);
  return dest;
}

// ======================= rendering =======================

function sentences(text) {
  return (String(text).match(/[^.!?…]+[.!?…]+["”’)]*|[^.!?…]+$/g) || [text]).map((s) => s.trim()).filter(Boolean);
}

const srtTime = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, "0")}`;
};

async function kenBurns(src, dest, W, H, dur, { focalX = 0.5, focalY = 0.45, zoomIn = true, z0 = 1.0, z1 = 1.18 } = {}) {
  const N = Math.max(2, Math.round(dur * FPS));
  const e = `(3*pow(on/${N},2)-2*pow(on/${N},3))`;
  const zs = zoomIn ? z0 : z1;
  const ze = zoomIn ? z1 : z0;
  const fx = Math.min(0.85, Math.max(0.15, focalX));
  const fy = Math.min(0.85, Math.max(0.15, focalY));
  // centre drifts from the middle toward the focal point (or back out)
  const cx = zoomIn ? `(0.5+(${fx}-0.5)*${e})` : `(${fx}+(0.5-${fx})*${e})`;
  const cy = zoomIn ? `(0.5+(${fy}-0.5)*${e})` : `(${fy}+(0.5-${fy})*${e})`;
  const z = `${zs}+(${ze}-${zs})*${e}`;
  const x = `max(0,min(iw-iw/zoom,${cx}*iw-iw/zoom/2))`;
  const y = `max(0,min(ih-ih/zoom,${cy}*ih-ih/zoom/2))`;
  await ffmpeg([
    "-i", src,
    "-vf", `scale=${Math.round(W * KB_SCALE)}:${Math.round(H * KB_SCALE)},zoompan=z='${z}':x='${x}':y='${y}':d=${N}:s=${W}x${H}:fps=${FPS},setsar=1,format=yuv420p`,
    "-frames:v", String(N), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-r", String(FPS), dest,
  ]);
  return dest;
}

async function videoSegment(src, dest, W, H, dur) {
  await ffmpeg([
    "-stream_loop", "-1", "-i", src, "-t", dur.toFixed(3), "-an",
    "-vf", `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", dest,
  ]);
  return dest;
}

export async function renderFilm(p, version, { log = () => {}, progress = () => {} } = {}) {
  const script = p.scripts[version];
  if (!script) throw new Error("No script for this version.");
  if (!script.mediaResolvedAt) await resolveMedia(p, version, log);
  const [W, H] = SIZES[p.settings.quality] || SIZES["720p"];
  const KW = Math.round(W * KB_SCALE);
  const KH = Math.round(H * KB_SCALE);
  const work = projectPath(p.id, "work", version);
  fs.rmSync(work, { recursive: true, force: true });
  ensureDir(work);
  const photosById = Object.fromEntries(p.photos.map((ph) => [ph.id, ph]));
  const voice = p.settings.voice?.id ? p.settings.voice : DEFAULT_VOICE;
  const scenes = script.scenes.filter((s) => s.visuals?.length);
  const P = (f) => path.join(work, f);

  // ---- 1. narration ----
  log(`Recording narration with ${voice.label || voice.id}…`);
  let done = 0;
  const narr = await pool(scenes, 4, async (sc, i) => {
    const text = String(sc.narration || "").trim();
    if (!text) return { file: null, dur: 0 };
    const f = P(`narr_${i}.mp3`);
    await synthesize(voice, text, f);
    const dur = await probeDuration(f);
    progress(0.02 + 0.18 * (++done / scenes.length));
    return { file: f, dur };
  });

  // ---- 2. timings ----
  const durs = scenes.map((sc, i) => {
    const min = sc.kind === "title" ? 5.5 : 4;
    const tail = sc.kind === "closing" || i === scenes.length - 1 ? 2.2 : 0.9;
    return Math.max(min, narr[i].dur + T + tail);
  });

  // ---- credits ----
  const creditLines = buildCredits(p, script, voice);
  const creditPages = [];
  const perPage = 18;
  for (let i = 0; i < creditLines.length; i += perPage) creditPages.push(creditLines.slice(i, i + perPage));
  const creditSecs = script.targetSeconds && script.targetSeconds <= 150 ? 6 : 7;

  // ---- 3. visuals per scene ----
  log("Animating photographs, maps and archival footage…");
  const segFiles = [];
  const wm = await watermark(P("wm.png"), W, H);
  let zoomToggle = false;
  let prevPoint = null;
  const titleBg = (() => {
    const v = scenes[0]?.visuals.find((x) => x.asset?.kind === "photo");
    return v ? projectPath(p.id, "uploads", photosById[v.asset.photoId]?.file || "") : null;
  })();

  for (const [i, sc] of scenes.entries()) {
    const d = durs[i];
    let visuals = sc.visuals.slice(0, Math.max(1, Math.floor(d / 2.5)));
    if (sc.kind === "title") visuals = [{ type: "titlecard", asset: { kind: "titlecard" } }, ...visuals.slice(0, Math.max(0, Math.floor(d / 3) - 1))];
    const each = d / visuals.length;
    const parts = [];
    const tags = [];
    for (const [j, v] of visuals.entries()) {
      const a = v.asset;
      const out = P(`s${i}_v${j}.mp4`);
      const canvas = P(`s${i}_v${j}.jpg`);
      zoomToggle = !zoomToggle;
      if (a.kind === "titlecard") {
        await titleCard({
          name: script.title || p.person.name,
          years: [yearOf(p.person.born), yearOf(p.person.died) || ""].filter((x) => x !== null).join(" – ").replace(/ – $/, " –"),
          tagline: script.tagline,
          bgSrc: titleBg,
        }, canvas, KW, KH);
        await kenBurns(canvas, out, W, H, each, { zoomIn: true, z1: 1.08 });
      } else if (a.kind === "photo") {
        const ph = photosById[a.photoId];
        await prepareStill(projectPath(p.id, "uploads", ph.file), canvas, KW, KH);
        const fx = Number.isFinite(ph.ai?.focalX) ? ph.ai.focalX : 0.5;
        const fy = Number.isFinite(ph.ai?.focalY) ? ph.ai.focalY : 0.42;
        await kenBurns(canvas, out, W, H, each, { focalX: fx, focalY: fy, zoomIn: zoomToggle });
      } else if (a.kind === "image") {
        await prepareStill(projectPath(p.id, "media", a.file), canvas, KW, KH);
        await kenBurns(canvas, out, W, H, each, { zoomIn: zoomToggle, z1: 1.14 });
        tags.push({ j, text: `${v.caption || a.title} — ${a.source} (${a.license})` });
      } else if (a.kind === "video") {
        await videoSegment(projectPath(p.id, "media", a.file), out, W, H, each);
        tags.push({ j, text: `${v.caption || a.title} — ${a.source} (${a.license})` });
      } else if (a.kind === "map") {
        await mapCard({ lat: a.lat, lon: a.lon, label: a.label, year: sc.year, prev: prevPoint }, canvas, KW, KH);
        prevPoint = { lat: a.lat, lon: a.lon };
        await kenBurns(canvas, out, W, H, each, { focalX: 0.5, focalY: 0.5, zoomIn: true, z0: 1.0, z1: 1.9 });
      } else {
        const kicker = { context: "Meanwhile", lesson: "Lesson", legacy: "Legacy" }[sc.kind] || "";
        await textCard({ kicker, heading: v.ref || sc.onScreenTitle, body: sc.kind === "lesson" ? sc.onScreenSubtitle : "", bgSrc: titleBg }, canvas, KW, KH);
        await kenBurns(canvas, out, W, H, each, { zoomIn: true, z1: 1.06 });
      }
      parts.push(out);
    }

    // assemble scene: concat visuals + lower third + source credits (+ burned captions)
    const inputs = [];
    parts.forEach((f) => inputs.push("-i", f));
    let fil = parts.map((_, k) => `[${k}:v]`).join("") + `concat=n=${parts.length}:v=1:a=0,fps=${FPS},format=yuv420p[base]`;
    let last = "base";
    let idx = parts.length;
    const ov = (file, enable, fadeIn, fadeOut) => {
      inputs.push("-loop", "1", "-t", d.toFixed(3), "-i", file);
      const fades = [fadeIn != null ? `fade=t=in:st=${fadeIn}:d=0.5:alpha=1` : "", fadeOut != null ? `fade=t=out:st=${fadeOut}:d=0.5:alpha=1` : ""].filter(Boolean).join(",");
      fil += `;[${idx}:v]format=rgba${fades ? "," + fades : ""}[o${idx}];[${last}][o${idx}]overlay=0:0${enable ? `:enable='${enable}'` : ""}[l${idx}]`;
      last = `l${idx}`;
      idx++;
    };
    const lt = sc.kind === "title" ? null : { title: sc.onScreenTitle || sc.year, subtitle: sc.onScreenSubtitle || sc.place };
    if (lt && (lt.title || lt.subtitle)) {
      await lowerThird(lt, P(`s${i}_lt.png`), W, H);
      ov(P(`s${i}_lt.png`), null, 0.7, Math.max(1.5, Math.min(d - 0.9, 6)));
    }
    for (const t of tags) {
      await sourceTag(t.text, P(`s${i}_tag${t.j}.png`), W, H);
      ov(P(`s${i}_tag${t.j}.png`), `between(t,${(t.j * each).toFixed(2)},${((t.j + 1) * each).toFixed(2)})`);
    }
    if (p.settings.burnCaptions && narr[i].dur) {
      const ss = sentences(sc.narration);
      const total = ss.reduce((a, s) => a + s.length, 0) || 1;
      let t0 = T;
      for (const [k, s] of ss.entries()) {
        const t1 = t0 + (narr[i].dur * s.length) / total;
        await captionOverlay(s, P(`s${i}_cap${k}.png`), W, H);
        ov(P(`s${i}_cap${k}.png`), `between(t,${t0.toFixed(2)},${t1.toFixed(2)})`);
        t0 = t1;
      }
    }
    const seg = P(`scene_${i}.mp4`);
    await ffmpeg([
      ...inputs, "-filter_complex", fil, "-map", `[${last}]`, "-t", d.toFixed(3),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-r", String(FPS), "-pix_fmt", "yuv420p", seg,
    ]);
    segFiles.push(seg);
    progress(0.2 + 0.55 * ((i + 1) / scenes.length));
    log(`Scene ${i + 1}/${scenes.length} ready`);
  }

  // credits segments
  for (const [k, lines] of creditPages.entries()) {
    const img = P(`credits_${k}.jpg`);
    await creditsCard({ heading: k === 0 ? "Credits" : "Credits (continued)", lines }, img, KW, KH);
    const seg = P(`credits_${k}.mp4`);
    await kenBurns(img, seg, W, H, creditSecs, { zoomIn: true, z1: 1.04 });
    segFiles.push(seg);
    durs.push(creditSecs);
  }

  // ---- 4. crossfade everything ----
  log("Editing scenes together…");
  const starts = [];
  let acc = 0;
  for (const [i, d] of durs.entries()) {
    starts.push(i === 0 ? 0 : acc - T * i);
    acc += d;
  }
  const total = acc - T * (durs.length - 1);
  const vIn = [];
  segFiles.forEach((f) => vIn.push("-i", f));
  let vf = segFiles.map((_, i) => `[${i}:v]settb=AVTB,fps=${FPS},format=yuv420p[s${i}]`).join(";");
  let cur = "s0";
  for (let i = 1; i < segFiles.length; i++) {
    const tr = scenes[i]?.transition;
    const name = XFADES.has(tr) ? tr : i >= scenes.length || tr === "fadeblack" ? "fadeblack" : "fade";
    vf += `;[${cur}][s${i}]xfade=transition=${name}:duration=${T}:offset=${starts[i].toFixed(3)}[x${i}]`;
    cur = `x${i}`;
  }
  const videoOnly = P("video.mp4");
  await ffmpeg([...vIn, "-filter_complex", vf, "-map", `[${cur}]`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", videoOnly], { timeoutMs: 60 * 60 * 1000 });
  progress(0.85);

  // ---- 5. narration track + subtitles ----
  log("Mixing narration and music…");
  const aIn = [];
  const aF = [];
  const srt = [];
  let n = 0;
  scenes.forEach((sc, i) => {
    if (!narr[i].file) return;
    const at = starts[i] + (i === 0 ? 0.6 : T);
    aIn.push("-i", narr[i].file);
    aF.push(`[${n}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${Math.round(at * 1000)}:all=1[a${n}]`);
    n++;
    const ss = sentences(sc.narration);
    const tot = ss.reduce((a, s) => a + s.length, 0) || 1;
    let t0 = at;
    for (const s of ss) {
      const t1 = t0 + (narr[i].dur * s.length) / tot;
      srt.push(`${srt.length + 1}\n${srtTime(t0)} --> ${srtTime(t1)}\n${s}\n`);
      t0 = t1;
    }
  });
  const narrWav = P("narration.wav");
  await ffmpeg([
    ...aIn, "-filter_complex",
    aF.join(";") + ";" + Array.from({ length: n }, (_, k) => `[a${k}]`).join("") + `amix=inputs=${n}:normalize=0:dropout_transition=0,apad=whole_dur=${total.toFixed(2)}[narr]`,
    "-map", "[narr]", "-t", total.toFixed(3), narrWav,
  ]);

  // ---- 6. music ----
  let musicFile = null;
  if (p.settings.music !== "none") {
    const tracks = (script.music || []).map((m) => projectPath(p.id, m.dir || "media", m.file)).filter((f) => fs.existsSync(f));
    if (tracks.length) {
      musicFile = P("music.m4a");
      const mi = [];
      tracks.forEach((f) => mi.push("-i", f));
      await ffmpeg([
        ...mi, "-filter_complex",
        tracks.map((_, k) => `[${k}:a]aresample=44100,aformat=channel_layouts=stereo,loudnorm=I=-20[m${k}]`).join(";") + ";" +
          tracks.map((_, k) => `[m${k}]`).join("") + `concat=n=${tracks.length}:v=0:a=1[m]`,
        "-map", "[m]", "-c:a", "aac", "-b:a", "192k", musicFile,
      ]);
    } else {
      musicFile = await generateAmbient(P("ambient.mp3"));
    }
  }

  // ---- 7. final mux ----
  const take = nextFilmNumber(p, version);
  const outName = `${slug(p.person.name || "biopic")}-${version}-v${take}.mp4`;
  const outFile = projectPath(p.id, "output", outName);
  const args = ["-i", videoOnly, "-loop", "1", "-i", wm, "-i", narrWav];
  let af;
  if (musicFile) {
    args.push("-stream_loop", "-1", "-i", musicFile);
    af =
      `[2:a]asplit=2[nv][sc];` +
      `[3:a]atrim=0:${total.toFixed(3)},volume=0.32,afade=t=in:d=2,afade=t=out:st=${Math.max(0, total - 5).toFixed(2)}:d=5[mu];` +
      `[mu][sc]sidechaincompress=threshold=0.02:ratio=6:attack=30:release=600[duck];` +
      `[nv][duck]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100[aout]`;
  } else af = `[2:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100[aout]`;
  await ffmpeg([
    ...args, "-filter_complex", `[0:v][1:v]overlay=0:0:shortest=1[vout];${af}`,
    "-map", "[vout]", "-map", "[aout]", "-t", total.toFixed(3),
    "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
    "-metadata", `title=${script.title || p.person.name}`, "-metadata", `copyright=${COPYRIGHT}`, "-metadata", "comment=Made with BioPicker",
    outFile,
  ], { timeoutMs: 60 * 60 * 1000 });
  const srtName = outName.replace(/\.mp4$/, ".srt");
  fs.writeFileSync(projectPath(p.id, "output", srtName), srt.join("\n"));
  const vttName = outName.replace(/\.mp4$/, ".vtt");
  fs.writeFileSync(projectPath(p.id, "output", vttName), "WEBVTT\n\n" + srt.join("\n").replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2"));
  progress(1);

  // every render is kept as a new version (v1, v2, …) with the exact script it was cut from
  const snapshot = JSON.parse(JSON.stringify(script));
  for (const sc of snapshot.scenes || []) for (const v of sc.visuals || []) delete v.candidates;
  const film = { id: newId(8), version, n: take, file: outName, srt: srtName, vtt: vttName, seconds: Math.round(total), at: new Date().toISOString(), quality: p.settings.quality, label: "", title: script.title || "", scriptSnapshot: snapshot };
  p.films.push(film);
  syncRenders(p);
  saveProject(p);
  if (!process.env.KEEP_WORK) fs.rmSync(work, { recursive: true, force: true });
  log(`Done — ${Math.round(total)} s film rendered as ${version} v${take}.`);
  return p.renders[version];
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "biopic";

function buildCredits(p, script, voice) {
  const lines = [];
  lines.push("## A FILM ABOUT", p.person.name || script.title);
  lines.push("## NARRATION", `${voice.label || voice.id} — AI voice (${voice.provider === "elevenlabs" ? "ElevenLabs" : "Microsoft neural TTS"})`);
  lines.push("## PHOTOGRAPHS & DOCUMENTS", `Personal collection of the family and friends of ${p.person.name || "the subject"}`);
  const seen = new Set();
  const media = [];
  for (const sc of script.scenes)
    for (const v of sc.visuals || [])
      if (v.asset?.source && !seen.has(v.asset.title)) {
        seen.add(v.asset.title);
        media.push(`${v.asset.title.slice(0, 60)} — ${v.asset.credit ? v.asset.credit.slice(0, 30) + ", " : ""}${v.asset.source} (${v.asset.license})`);
      }
  if (media.length) lines.push("## ARCHIVAL FOOTAGE, PHOTOGRAPHS & ART", ...media);
  const music = (script.music || []).map((m) => `${m.title.slice(0, 60)} — ${m.credit ? m.credit.slice(0, 30) + ", " : ""}${m.source} (${m.license})`);
  if (p.settings.music !== "none") lines.push("## MUSIC", ...(music.length ? music : ["Original ambient score generated by BioPicker"]));
  lines.push("## MAPS", "Natural Earth (public domain)");
  lines.push("## RESEARCH & SCRIPT", "Written with AI assistance (Anthropic Claude) from family-provided material.", "Historical notes are AI-researched; please verify before publishing.");
  lines.push("## PRODUCED WITH", `BioPicker — ${COPYRIGHT}. All rights reserved.`);
  return lines;
}
