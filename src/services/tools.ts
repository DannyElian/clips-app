import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";
import { toolAbort } from "./cancel.js";
import { ensureDir, probeVideo, runCommand, type ProbeInfo } from "./ffmpeg.js";
import { ollamaChat, parseJsonBlock } from "./ollama.js";
import { JOBS_DIR } from "./jobs.js";
import { resolveFont } from "./captions.js";

const ROOT = path.resolve(process.cwd());
const DATA = path.join(ROOT, "data");
const LIBRARY = path.join(DATA, "library");
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/transcribe_verbatim.py");
const STAMP = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/stamp_text.py");
const THUMB = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/thumb.py");

export const LANGS = [
  { id: "es", name: "Español" },
  { id: "en", name: "Inglés" },
  { id: "pt", name: "Portugués" },
  { id: "fr", name: "Francés" },
  { id: "it", name: "Italiano" },
  { id: "de", name: "Alemán" },
] as const;

export interface Segment {
  start: number;
  end: number;
  text: string;
  words?: Array<{ start: number; end: number; word: string }>;
}

export interface MediaRow {
  mediaKey: string;
  path: string;
  filename: string;
  probe: ProbeInfo;
  jobId?: string;
}

export interface ToolJob {
  id: string;
  status: "pending" | "processing" | "completed" | "error";
  progress: string;
  result?: unknown;
  error?: string;
}

const running = new Map<string, ToolJob>();

export function getToolJob(id: string): ToolJob | undefined {
  return running.get(id);
}

function python(): string {
  return process.env.PYTHON_BIN || "python3.11";
}

async function fileKey(filePath: string): Promise<string> {
  const st = await fs.stat(filePath);
  return createHash("sha1").update(`${filePath}|${st.size}|${Math.round(st.mtimeMs)}`).digest("hex").slice(0, 20);
}

export async function resolveMedia(input: {
  jobId?: string;
  filename?: string;
  filePath?: string;
}): Promise<MediaRow> {
  let filePath = input.filePath;
  let filename = input.filename || (filePath ? path.basename(filePath) : "video.mp4");
  if (input.jobId && input.filename && !input.filePath) {
    filename = path.basename(input.filename);
    filePath = path.join(JOBS_DIR, input.jobId, "clips", filename);
  }
  if (!filePath) throw new Error("Falta el vídeo.");
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(DATA) && !resolved.startsWith(path.resolve(JOBS_DIR))) {
    throw new Error("El archivo tiene que estar dentro de la app.");
  }
  await fs.access(resolved);
  const probe = await probeVideo(resolved);
  const mediaKey = await fileKey(resolved);
  await pool.query(
    `INSERT INTO media (media_key, path, filename, width, height, fps, duration_sec, codec, bitrate, job_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (media_key) DO UPDATE SET path = EXCLUDED.path, filename = EXCLUDED.filename`,
    [mediaKey, resolved, filename, probe.width, probe.height, probe.fps, probe.durationSec, probe.codec, probe.bitrate, input.jobId || null],
  );
  return { mediaKey, path: resolved, filename, probe, jobId: input.jobId };
}

export async function saveUpload(filePath: string, filename: string): Promise<MediaRow> {
  await ensureDir(LIBRARY);
  const id = randomUUID();
  const destDir = path.join(LIBRARY, id);
  await ensureDir(destDir);
  const dest = path.join(destDir, path.basename(filename).replace(/[^\w.\-]+/g, "_"));
  await fs.copyFile(filePath, dest);
  return resolveMedia({ filePath: dest, filename });
}

export async function cachedTranscript(
  filePath: string,
  filename: string,
): Promise<{ language: string; text: string; segments: Segment[] } | null> {
  const media = await resolveMedia({ filePath, filename });
  return (await loadTranscript(media.mediaKey, true)) || (await loadTranscript(media.mediaKey, false));
}

export async function rememberTranscript(
  filePath: string,
  filename: string,
  heard: { text: string; segments: Segment[] },
): Promise<void> {
  const text = heard.text.trim() || heard.segments.map((seg) => seg.text).join(" ").trim();
  if (!text) return;
  const media = await resolveMedia({ filePath, filename });
  const withWords = heard.segments.some((seg) => seg.words?.length);
  await pool.query(
    `INSERT INTO transcripts (media_key, with_words, language, full_text, segments)
     VALUES ($1,$2,'',$3,$4)
     ON CONFLICT (media_key, with_words) DO UPDATE SET full_text = EXCLUDED.full_text, segments = EXCLUDED.segments`,
    [media.mediaKey, withWords, text, JSON.stringify(heard.segments)],
  );
  if (withWords) {
    await pool.query(
      `INSERT INTO transcripts (media_key, with_words, language, full_text, segments)
       VALUES ($1,false,'',$2,$3)
       ON CONFLICT (media_key, with_words) DO NOTHING`,
      [media.mediaKey, text, JSON.stringify(heard.segments)],
    );
  }
}

async function loadTranscript(mediaKey: string, withWords: boolean): Promise<{ language: string; text: string; segments: Segment[] } | null> {
  const { rows } = await pool.query(
    "SELECT language, full_text, segments FROM transcripts WHERE media_key = $1 AND with_words = $2",
    [mediaKey, withWords],
  );
  const row = rows[0] as { language: string; full_text: string; segments: Segment[] } | undefined;
  if (!row) return null;
  return { language: row.language, text: row.full_text, segments: row.segments };
}

async function loadSaved<T>(mediaKey: string, tool: string): Promise<T[]> {
  const { rows } = await pool.query(
    `SELECT payload FROM tool_results WHERE media_key = $1 AND tool = $2 AND status = 'completed' ORDER BY created_at DESC LIMIT 12`,
    [mediaKey, tool],
  );
  return (rows as { payload: T }[]).map((row) => row.payload).filter(Boolean);
}

export async function ensureTranscript(media: MediaRow, withWords: boolean): Promise<{ language: string; text: string; segments: Segment[] }> {
  const cached = await loadTranscript(media.mediaKey, withWords);
  if (cached) return cached;
  if (!withWords) {
    const detailed = await loadTranscript(media.mediaKey, true);
    if (detailed) return detailed;
  }
  if (!media.probe.hasAudio) throw new Error("Este vídeo no tiene audio.");
  const dir = path.join(DATA, "transcripts", media.mediaKey);
  await ensureDir(dir);
  const wav = path.join(dir, "audio.wav");
  const out = path.join(dir, withWords ? "words.json" : "plain.json");
  const extracted = await runCommand("ffmpeg", ["-y", "-i", media.path, "-vn", "-ac", "1", "-ar", "16000", wav], {
    timeoutMs: 20 * 60 * 1000,
  });
  if (extracted.code !== 0) throw new Error("No se pudo extraer el audio.");
  const args = [SCRIPT, wav, out];
  if (withWords) args.push("words");
  const timeoutMs = Math.round(Math.min(90, Math.max(8, media.probe.durationSec / 60 * 2 + 5)) * 60 * 1000);
  const run = await runCommand(python(), args, { timeoutMs });
  if (run.code !== 0) throw new Error((run.stderr || run.stdout).slice(-300) || "Falló la transcripción.");
  const parsed = JSON.parse(await fs.readFile(out, "utf8")) as {
    ok?: boolean;
    error?: string;
    language?: string;
    text?: string;
    segments?: Segment[];
  };
  if (!parsed.ok) throw new Error(parsed.error || "Transcripción vacía.");
  await fs.unlink(wav).catch(() => undefined);
  const segments = parsed.segments ?? [];
  const text = parsed.text || "";
  await pool.query(
    `INSERT INTO transcripts (media_key, with_words, language, full_text, segments)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (media_key, with_words) DO UPDATE SET full_text = EXCLUDED.full_text, segments = EXCLUDED.segments, language = EXCLUDED.language`,
    [media.mediaKey, withWords, parsed.language || "", text, JSON.stringify(segments)],
  );
  if (withWords) {
    await pool.query(
      `INSERT INTO transcripts (media_key, with_words, language, full_text, segments)
       VALUES ($1,false,$2,$3,$4)
       ON CONFLICT (media_key, with_words) DO NOTHING`,
      [media.mediaKey, parsed.language || "", text, JSON.stringify(segments)],
    );
  }
  return { language: parsed.language || "", text, segments };
}

export function toSrt(segments: Segment[]): string {
  return segments
    .map((cue, i) => `${i + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`)
    .join("\n");
}

export function toVtt(segments: Segment[]): string {
  const body = segments
    .map((cue) => `${vttStamp(cue.start)} --> ${vttStamp(cue.end)}\n${cue.text}\n`)
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

function stamp(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

function vttStamp(sec: number): string {
  return stamp(sec).replace(",", ".");
}

const HOLD_AFTER_SPEECH = 0.16;
const PAUSE_BREAK = 0.32;

function spokenWords(seg: Segment): Array<{ start: number; end: number; word: string }> {
  const timed = seg.words?.filter((word) => word.word.trim());
  if (timed?.length) {
    return timed.map((word) => {
      const start = word.start;
      let end = Math.max(word.end, start + 0.06);
      if (end - start > 1.2) end = start + 0.55;
      return { start, end, word: word.word.trim() };
    });
  }
  const tokens = seg.text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const speech = Math.min(Math.max(0.2, seg.end - seg.start), tokens.length * 0.42 + 0.1);
  const slice = speech / tokens.length;
  return tokens.map((word, i) => ({
    start: seg.start + slice * i,
    end: seg.start + slice * (i + 1),
    word,
  }));
}

/** Cues follow each word. They leave shortly after the last word and stay off during a pause. */
export function chunkSegments(segments: Segment[], maxCues = 80, wordsPerCue = 5): Segment[] {
  const words = segments.flatMap(spokenWords).sort((a, b) => a.start - b.start);
  const build = (maxWords: number) => {
    const groups: Array<typeof words> = [];
    let cur: typeof words = [];
    const flush = () => {
      if (cur.length) groups.push(cur);
      cur = [];
    };
    for (const word of words) {
      const prev = cur[cur.length - 1];
      const pause = prev ? word.start - prev.end > PAUSE_BREAK : false;
      const punct = prev ? /[.!?…:]$/.test(prev.word) : false;
      if (prev && (pause || punct || cur.length >= maxWords)) flush();
      cur.push(word);
    }
    flush();
    return groups;
  };
  let maxWords = Math.max(1, wordsPerCue);
  let groups = build(maxWords);
  while (wordsPerCue > 1 && groups.length > maxCues && maxWords < 14) {
    maxWords += 3;
    groups = build(maxWords);
  }
  const cues: Segment[] = groups.slice(0, maxCues).map((group) => ({
    start: group[0]!.start,
    end: group[group.length - 1]!.end,
    text: group.map((word) => word.word).join(" "),
    words: group,
  }));
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    const next = cues[i + 1];
    const prev = cues[i - 1];
    let start = Math.max(0, cue.start - 0.04);
    if (prev) start = Math.max(start, prev.end + 0.03);
    let end = cue.end + HOLD_AFTER_SPEECH;
    if (next && next.start - cue.end > PAUSE_BREAK) end = cue.end + HOLD_AFTER_SPEECH;
    else if (next) end = Math.min(end, next.start - 0.03);
    cue.start = start;
    cue.end = Math.max(start + 0.18, end);
  }
  return cues.filter((cue) => cue.end > cue.start);
}

export async function transcribeMedia(media: MediaRow): Promise<{ language: string; text: string; segments: Segment[]; srt: string; vtt: string }> {
  const spoken = await ensureTranscript(media, false);
  return {
    language: spoken.language,
    text: spoken.text,
    segments: spoken.segments,
    srt: toSrt(spoken.segments),
    vtt: toVtt(spoken.segments),
  };
}

export async function subtitlePreview(media: MediaRow, style: string): Promise<{ language: string; segments: Segment[]; cues: Segment[]; srt: string; vtt: string }> {
  const spoken = await ensureTranscript(media, true);
  const cues = chunkSegments(spoken.segments);
  return {
    language: spoken.language,
    segments: spoken.segments,
    cues,
    srt: toSrt(cues),
    vtt: toVtt(cues),
  };
}

export function outputUrl(media: MediaRow, filename: string): string {
  return `/api/tools/file/${media.mediaKey}/${encodeURIComponent(path.basename(filename))}`;
}

export async function outputFile(mediaKey: string, name: string): Promise<string> {
  const { rows } = await pool.query("SELECT path FROM media WHERE media_key = $1", [mediaKey]);
  const row = rows[0] as { path: string } | undefined;
  if (!row) throw new Error("No está ese vídeo.");
  if (name === "source") return row.path;
  const file = path.join(path.dirname(row.path), path.basename(name));
  await fs.access(file);
  return file;
}

export async function burnSubtitles(
  media: MediaRow,
  style: { position?: "top" | "middle" | "bottom"; color?: string; look?: string; size?: string },
  segments?: Segment[],
  onProgress?: (msg: string) => void,
): Promise<{ outputPath: string; filename: string; probe: ProbeInfo }> {
  const look = style.look === "palabra" || style.look === "barra" ? style.look : "frase";
  const color = /^#[0-9a-fA-F]{6}$/.test(style.color || "") ? style.color! : "#ffe14a";
  const scale = style.size === "chico" ? "0.82" : style.size === "grande" ? "1.28" : "1";
  const sourceSegments = segments ?? (await ensureTranscript(media, true)).segments;
  const phraseCap =
    look === "palabra"
      ? Math.min(2000, Math.max(50, Math.ceil(media.probe.durationSec / 2)))
      : Math.min(4000, Math.max(50, Math.ceil(media.probe.durationSec / 1.5)));
  const phrases = chunkSegments(sourceSegments, phraseCap, look === "palabra" ? 4 : 5);
  const cues: Segment[] = [];
  const highlights: number[] = [];
  if (look === "palabra") {
    for (const phrase of phrases) {
      const words = phrase.words?.length ? phrase.words : phrase.text.split(/\s+/).filter(Boolean).map((word, i, all) => {
        const span = Math.max(0.2, phrase.end - phrase.start) / all.length;
        return { word, start: phrase.start + span * i, end: phrase.start + span * (i + 1) };
      });
      words.forEach((word, index) => {
        const next = words[index + 1];
        cues.push({ start: word.start, end: next ? next.start : Math.max(word.end, word.start + 0.18), text: phrase.text });
        highlights.push(index);
      });
    }
  } else {
    cues.push(...phrases);
    highlights.push(...phrases.map(() => -1));
  }
  const overlayDirect = cues.length <= 60;
  const shown = overlayDirect ? cues.slice(0, 70) : cues;
  const shownHi = overlayDirect ? highlights.slice(0, 70) : highlights;
  if (!shown.length) throw new Error("No hay texto para poner en el vídeo.");
  const dir = path.join(path.dirname(media.path), "subs-build");
  await fs.rm(dir, { recursive: true, force: true });
  await ensureDir(dir);
  const font = await resolveFont();
  const pngs: string[] = [];
  for (let i = 0; i < shown.length; i++) {
    const txt = path.join(dir, `${i}.txt`);
    const png = path.join(dir, `${i}.png`);
    await fs.writeFile(txt, shown[i]!.text, "utf8");
    const made = await runCommand(
      python(),
      [STAMP, png, font, String(media.probe.width), txt, "sub", look, color, scale, String(shownHi[i] ?? -1)],
      { timeoutMs: 20_000 },
    );
    if (made.code !== 0) throw new Error("No se pudo dibujar un subtítulo.");
    pngs.push(png);
    if (!overlayDirect && (i === 0 || i % 40 === 0)) {
      onProgress?.(`Dibujando subtítulos ${i + 1} de ${shown.length}…`);
    }
  }
  const y =
    style.position === "top" ? "H*0.16" : style.position === "middle" ? "(H-h)/2" : "H-h-H*0.14";
  if (!overlayDirect) {
    return burnSubtitleStrip(media, dir, shown, y, look);
  }
  let chain = "[0:v]format=yuv420p[base]";
  let last = "base";
  const inputs = ["-i", media.path];
  pngs.forEach((png, i) => {
    inputs.push("-loop", "1", "-i", png);
    const next = `s${i}`;
    const cue = shown[i]!;
    chain += `;[${last}][${i + 1}:v]overlay=x=(main_w-overlay_w)/2:y=${y}:enable='between(t\\,${cue.start.toFixed(2)}\\,${cue.end.toFixed(2)})'[${next}]`;
    last = next;
  });
  const filename = media.filename.replace(/\.mp4$/i, "") + `.subs-${look}.mp4`;
  const outputPath = path.join(path.dirname(media.path), filename);
  const encode = await runCommand(
    "ffmpeg",
    [
      "-y",
      ...inputs,
      "-filter_complex",
      chain,
      "-map",
      `[${last}]`,
      "-map",
      "0:a?",
      "-c:v",
      "h264_videotoolbox",
      "-b:v",
      bitrateFor(media.probe.height),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      outputPath,
    ],
    { timeoutMs: Math.max(120_000, media.probe.durationSec * 4000) },
  );
  if (encode.code !== 0) throw new Error(`No se pudo exportar con subtítulos: ${encode.stderr.slice(-300)}`);
  const probe = await probeVideo(outputPath);
  if (probe.height + 8 < media.probe.height || probe.width + 8 < media.probe.width) {
    await fs.unlink(outputPath).catch(() => undefined);
    throw new Error("La exportación bajó la resolución. No se guardó.");
  }
  return { outputPath, filename, probe };
}

async function burnSubtitleStrip(
  media: MediaRow,
  dir: string,
  cues: Segment[],
  y: string,
  look: string,
): Promise<{ outputPath: string; filename: string; probe: ProbeInfo }> {
  const align = y.startsWith("H*0.16") ? "top" : y.includes("(H-h)/2") ? "middle" : "bottom";
  const padded = await runCommand(python(), [STAMP, "--pad", dir, align], { timeoutMs: 120_000 });
  if (padded.code !== 0) throw new Error("No se pudo preparar la pista de subtítulos.");
  const list: string[] = ["ffconcat version 1.0"];
  let cursor = 0;
  const duration = media.probe.durationSec;
  cues.forEach((cue, i) => {
    const start = Math.max(cursor, cue.start);
    if (start > cursor + 0.04) {
      list.push("file 'blank.png'", `duration ${(start - cursor).toFixed(3)}`);
      cursor = start;
    }
    const end = Math.min(duration, Math.max(cursor + 0.08, cue.end));
    if (end <= cursor) return;
    list.push(`file '${i}.png'`, `duration ${(end - cursor).toFixed(3)}`);
    cursor = end;
  });
  if (duration > cursor + 0.04) {
    list.push("file 'blank.png'", `duration ${(duration - cursor).toFixed(3)}`);
  }
  list.push("file 'blank.png'");
  const listPath = path.join(dir, "strip.txt");
  await fs.writeFile(listPath, list.join("\n") + "\n", "utf8");
  const stripPath = path.join(dir, "strip.mov");
  const strip = await runCommand(
    "ffmpeg",
    ["-y", "-f", "concat", "-safe", "0", "-i", "strip.txt", "-vf", "fps=8,format=rgba", "-c:v", "qtrle", "-pix_fmt", "argb", "strip.mov"],
    { cwd: dir, timeoutMs: Math.max(180_000, media.probe.durationSec * 2000) },
  );
  if (strip.code !== 0) throw new Error(`No se pudo armar la pista de subtítulos: ${strip.stderr.slice(-300)}`);
  const filename = media.filename.replace(/\.mp4$/i, "") + `.subs-${look}.mp4`;
  const outputPath = path.join(path.dirname(media.path), filename);
  const encode = await runCommand(
    "ffmpeg",
    [
      "-y",
      "-i",
      media.path,
      "-i",
      stripPath,
      "-filter_complex",
      `[0:v]format=yuv420p[base];[1:v]format=rgba[sub];[base][sub]overlay=x=(main_w-overlay_w)/2:y=${y}:format=auto[vout]`,
      "-map",
      "[vout]",
      "-map",
      "0:a?",
      "-t",
      duration.toFixed(2),
      "-c:v",
      "h264_videotoolbox",
      "-b:v",
      bitrateFor(media.probe.height),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outputPath,
    ],
    { timeoutMs: Math.max(180_000, media.probe.durationSec * 4000) },
  );
  await fs.rm(stripPath, { force: true }).catch(() => undefined);
  if (encode.code !== 0) throw new Error(`No se pudo exportar con subtítulos: ${encode.stderr.slice(-300)}`);
  const probe = await probeVideo(outputPath);
  if (probe.height + 8 < media.probe.height || probe.width + 8 < media.probe.width) {
    await fs.unlink(outputPath).catch(() => undefined);
    throw new Error("La exportación bajó la resolución. No se guardó.");
  }
  return { outputPath, filename, probe };
}

function bitrateFor(height: number): string {
  if (height >= 1440) return "30M";
  if (height >= 1080) return "16M";
  if (height >= 720) return "8M";
  return "4M";
}

export interface SilenceSpan {
  start: number;
  end: number;
}

export async function detectSilence(media: MediaRow, minSec: number, noiseDb: number): Promise<{ spans: SilenceSpan[]; cached?: boolean }> {
  const noise = Math.min(-20, Math.max(-50, noiseDb));
  const min = Math.min(5, Math.max(0.3, minSec));
  const saved = (await loadSaved<{ min?: number; noise?: number; spans?: SilenceSpan[] }>(media.mediaKey, "silence")).find(
    (row) => row.min === min && row.noise === noise && Array.isArray(row.spans),
  );
  if (saved?.spans) return { spans: saved.spans, cached: true };
  const run = await runCommand(
    "ffmpeg",
    ["-i", media.path, "-af", `silencedetect=noise=${noise}dB:d=${min}`, "-f", "null", "-"],
    { timeoutMs: Math.max(60_000, media.probe.durationSec * 500) },
  );
  const text = run.stderr;
  const spans: SilenceSpan[] = [];
  let start: number | null = null;
  for (const line of text.split("\n")) {
    const s = line.match(/silence_start:\s*([0-9.]+)/);
    const e = line.match(/silence_end:\s*([0-9.]+)/);
    if (s) start = Number(s[1]);
    if (e && start != null) {
      const end = Number(e[1]);
      if (end - start >= min) spans.push({ start, end });
      start = null;
    }
  }
  await pool.query(
    `INSERT INTO tool_results (id, media_key, tool, status, payload) VALUES ($1,$2,'silence','completed',$3)`,
    [randomUUID(), media.mediaKey, JSON.stringify({ min, noise, spans })],
  );
  return { spans };
}

export async function applySilence(media: MediaRow, spans: SilenceSpan[]): Promise<{ outputPath: string; filename: string; probe: ProbeInfo }> {
  if (!spans.length) throw new Error("No hay silencios marcados para quitar.");
  const keep = spans
    .map((s) => `between(t\\,${s.start.toFixed(3)}\\,${s.end.toFixed(3)})`)
    .join("+");
  const filename = media.filename.replace(/\.mp4$/i, "") + ".nosilence.mp4";
  const outputPath = path.join(path.dirname(media.path), filename);
  const run = await runCommand(
    "ffmpeg",
    [
      "-y",
      "-i",
      media.path,
      "-filter_complex",
      `[0:v]select='not(${keep})',setpts=N/FRAME_RATE/TB[v];[0:a]aselect='not(${keep})',asetpts=N/SR/TB[a]`,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "h264_videotoolbox",
      "-b:v",
      bitrateFor(media.probe.height),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outputPath,
    ],
    { timeoutMs: Math.max(120_000, media.probe.durationSec * 4000) },
  );
  if (run.code !== 0) throw new Error(`No se pudo exportar sin silencios: ${run.stderr.slice(-300)}`);
  const probe = await probeVideo(outputPath);
  if (probe.height + 8 < media.probe.height) {
    await fs.unlink(outputPath).catch(() => undefined);
    throw new Error("La exportación bajó la resolución. No se guardó.");
  }
  return { outputPath, filename, probe };
}

const LANG_NAME: Record<string, string> = Object.fromEntries(LANGS.map((l) => [l.id, l.name]));

function briefText(text: string, limit = 1400): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  const third = Math.floor(limit / 3);
  const mid = Math.floor(clean.length / 2);
  return `${clean.slice(0, third)} … ${clean.slice(mid - Math.floor(third / 2), mid + Math.floor(third / 2))} … ${clean.slice(-third)}`;
}

function packSegments(segments: Segment[], maxBlocks = 16): Segment[] {
  if (segments.length <= maxBlocks) return segments;
  const size = Math.ceil(segments.length / maxBlocks);
  const packed: Segment[] = [];
  for (let i = 0; i < segments.length; i += size) {
    const parts = segments.slice(i, i + size);
    packed.push({
      start: parts[0]!.start,
      end: parts[parts.length - 1]!.end,
      text: parts.map((part) => part.text).join(" "),
    });
  }
  return packed;
}

function readNumbered(raw: string, count: number): string[] {
  const lines = new Array<string>(count).fill("");
  try {
    const parsed = parseJsonBlock<Record<string, unknown>>(raw);
    const arr = [parsed.lines, parsed.translations, parsed.text].find(Array.isArray) as unknown[] | undefined;
    if (arr) {
      arr.forEach((item, i) => {
        if (i >= count) return;
        lines[i] = String(typeof item === "string" ? item : (item as { text?: string })?.text || "").trim();
      });
      if (lines.some(Boolean)) return lines;
    }
  } catch {
    // plain numbered lines
  }
  for (const row of raw.split(/\n+/)) {
    const match = row.match(/^\s*(\d+)\s*[\.\)|:\-]\s*(.+)\s*$/);
    if (!match) continue;
    const index = Number(match[1]) - 1;
    if (index >= 0 && index < count) lines[index] = match[2]!.trim();
  }
  return lines;
}

async function translateBlock(part: Segment[], name: string): Promise<string[]> {
  const payload = part.map((seg, n) => `${n + 1}. ${seg.text}`).join("\n");
  const raw = await ollamaChat(
    [
      {
        role: "system",
        content: `Traduce al ${name}. La primera línea es 1. Luego 2. 3. hasta ${part.length}. Una traducción por línea, en el mismo orden. No saludes ni expliques.`,
      },
      { role: "user", content: payload },
    ],
    { numPredict: Math.min(640, part.length * 36), timeoutMs: 55_000 },
  );
  return readNumbered(raw, part.length);
}

export async function translateSegments(media: MediaRow, lang: string): Promise<{ segments: Segment[]; srt: string; vtt: string; warnings: string[]; cached?: boolean }> {
  const name = LANG_NAME[lang];
  if (!name) throw new Error("Idioma no disponible.");
  const saved = (await loadSaved<{ lang?: string; segments?: Segment[]; warnings?: string[] }>(media.mediaKey, "translate")).find(
    (row) => row.lang === lang && !!row.segments?.length && (row.warnings || []).length < row.segments.length,
  );
  if (saved?.segments?.length) {
    return { segments: saved.segments, srt: toSrt(saved.segments), vtt: toVtt(saved.segments), warnings: saved.warnings || [], cached: true };
  }
  const spoken = await ensureTranscript(media, false);
  const warnings: string[] = [];
  const blocks = packSegments(spoken.segments);
  let lines: string[] = [];
  try {
    lines = await translateBlock(blocks, name);
  } catch (err) {
    if (err instanceof Error && err.message === "Detenido") throw err;
    lines = [];
  }
  if (!lines.some(Boolean) && blocks.length > 1) {
    lines = [];
    const mid = Math.ceil(blocks.length / 2);
    for (const part of [blocks.slice(0, mid), blocks.slice(mid)]) {
      if (!part.length) continue;
      try {
        lines.push(...(await translateBlock(part, name)));
      } catch (err) {
        if (err instanceof Error && err.message === "Detenido") throw err;
        lines.push(...part.map(() => ""));
      }
    }
  }
  const translated = blocks.map((seg, n) => {
    const line = lines[n]?.trim();
    if (!line) {
      warnings.push(`No se tradujo el tramo ${stamp(seg.start)}. Se dejó el original.`);
      return seg;
    }
    return { ...seg, text: line };
  });
  if (warnings.length < translated.length) {
    await pool.query(
      `INSERT INTO tool_results (id, media_key, tool, status, payload) VALUES ($1,$2,'translate','completed',$3)`,
      [randomUUID(), media.mediaKey, JSON.stringify({ lang, segments: translated, warnings })],
    );
  }
  return { segments: translated, srt: toSrt(translated), vtt: toVtt(translated), warnings };
}

const COPY_STYLE = "latino-1";

function toneGuide(tone: string): string {
  if (tone === "profesional") return "Español latino neutro, serio y claro, igual con gancho. Sin slang.";
  if (tone === "intrigante") return "Español latino. Gancho de curiosidad o pregunta. No reveles el final.";
  if (tone === "educativo") return "Español latino, cercano. Se entiende al instante y el título igual engancha.";
  if (tone === "polémico") return "Español latino. Opinión que invita a comentar. Fuerte, sin insultos.";
  return "Español latino juvenil, como un story a un amigo. Energía, jaja, bro, literal, no puede ser. Nada formal y nada de España: sin tío, mola, flipar ni vosotros.";
}

export async function generateTitles(media: MediaRow, tone: string, network: string): Promise<{ titles: string[]; cached?: boolean }> {
  const saved = (await loadSaved<{ tone?: string; network?: string; style?: string; titles?: string[] }>(media.mediaKey, "titles")).find(
    (row) => row.tone === tone && row.network === network && row.style === COPY_STYLE && row.titles?.length,
  );
  if (saved?.titles?.length) return { titles: saved.titles, cached: true };
  const spoken = await ensureTranscript(media, false);
  const raw = await ollamaChat([
    {
      role: "system",
      content: `Escribes 5 títulos para ${network}. ${toneGuide(tone)} Máximo 8 palabras, hablados y llamativos. El gancho es una reacción a lo que SÍ se dijo (no puede ser, mira esto, se quedó frío), nunca un dato nuevo. Prohibido nombrar juegos, personas o acciones que no estén en el texto. Solo 5 líneas numeradas. Empieza en 1. Sin saludo.`,
    },
    { role: "user", content: briefText(spoken.text, 700) },
  ], { numPredict: 90, numCtx: 640, temperature: 0.45, timeoutMs: 16_000 });
  const titles = raw
    .split(/\n+/)
    .filter((line) => /^\s*\d+[\.\)\-]/.test(line))
    .map((line) => line.replace(/^\s*\d+[\.\)\-]\s*/, "").replace(/^["“”]+|["“”]+$/g, "").trim())
    .filter((line) => line.length > 2)
    .slice(0, 5);
  if (!titles.length) throw new Error("No salieron títulos.");
  await pool.query(
    `INSERT INTO tool_results (id, media_key, tool, status, payload) VALUES ($1,$2,'titles','completed',$3)`,
    [randomUUID(), media.mediaKey, JSON.stringify({ tone, network, style: COPY_STYLE, titles })],
  );
  return { titles };
}

export async function generateCopy(
  media: MediaRow,
  tone: string,
  network: string,
): Promise<{ options: Array<{ description: string; hashtags: string[] }>; cached?: boolean }> {
  const saved = (await loadSaved<{ tone?: string; network?: string; style?: string; options?: Array<{ description: string; hashtags: string[] }> }>(media.mediaKey, "description")).find(
    (row) => row.tone === tone && row.network === network && row.style === COPY_STYLE && row.options?.length,
  );
  if (saved?.options?.length) return { options: saved.options, cached: true };
  const spoken = await ensureTranscript(media, false);
  const raw = await ollamaChat([
    {
      role: "system",
      content: `Escribes 3 descripciones para ${network}. ${toneGuide(tone)} Cada opción son dos líneas: la descripción (máximo 2 frases, la primera es el gancho sobre lo que sí se dijo) y 4 hashtags en español. Prohibido inventar juegos, nombres o acciones. Separa opciones con una línea ---. Sin saludo y sin numerar.`,
    },
    { role: "user", content: briefText(spoken.text, 700) },
  ], { numPredict: 160, numCtx: 768, temperature: 0.4, timeoutMs: 18_000 });
  const options = raw
    .split(/\n---\n|\n---\r?\n/)
    .map((block) => {
      const rows = block.split(/\n+/).map((row) => row.trim()).filter(Boolean);
      const tags = rows.filter((row) => row.includes("#")).join(" ");
      const description = rows.filter((row) => !row.includes("#") && row !== "---").join(" ").trim();
      const hashtags = tags.split(/\s+/).filter((tag) => tag.startsWith("#"));
      return { description, hashtags };
    })
    .filter((option) => option.description)
    .slice(0, 3);
  if (!options.length) throw new Error("No salió una descripción.");
  await pool.query(
    `INSERT INTO tool_results (id, media_key, tool, status, payload) VALUES ($1,$2,'description','completed',$3)`,
    [randomUUID(), media.mediaKey, JSON.stringify({ tone, network, style: COPY_STYLE, options })],
  );
  return { options };
}

export async function chat(media: MediaRow, question: string): Promise<{ answer: string; history: Array<{ role: string; content: string }> }> {
  const spoken = await ensureTranscript(media, false);
  const timed = spoken.segments
    .slice(0, 40)
    .map((s) => `[${clock(s.start)}] ${s.text}`)
    .join("\n")
    .slice(0, 1800);
  const prev = await pool.query(
    "SELECT role, content FROM chat_messages WHERE media_key = $1 ORDER BY created_at DESC LIMIT 8",
    [media.mediaKey],
  );
  const history = (prev.rows as Array<{ role: string; content: string }>).reverse();
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    {
      role: "system",
      content: "Responde solo con la transcripción. Cita el momento como [mm:ss]. Si no está, di exactamente: No aparece en el video. No inventes.",
    },
    { role: "user", content: `Transcripción:\n${timed}` },
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: question },
  ];
  const answer = await ollamaChat(messages, { numPredict: 220, timeoutMs: 40_000 });
  const qid = randomUUID();
  const aid = randomUUID();
  await pool.query("INSERT INTO chat_messages (id, media_key, role, content) VALUES ($1,$2,'user',$3), ($4,$2,'assistant',$5)", [
    qid,
    media.mediaKey,
    question,
    aid,
    answer,
  ]);
  history.push({ role: "user", content: question }, { role: "assistant", content: answer });
  return { answer, history };
}

export async function chatHistory(mediaKey: string): Promise<Array<{ role: string; content: string }>> {
  const { rows } = await pool.query(
    "SELECT role, content FROM chat_messages WHERE media_key = $1 ORDER BY created_at ASC LIMIT 40",
    [mediaKey],
  );
  return rows as Array<{ role: string; content: string }>;
}

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export async function makeThumbnail(
  media: MediaRow,
  atSec: number,
  title: string,
  format: "youtube" | "vertical" | "jpg",
): Promise<{ outputPath: string; filename: string; cached?: boolean }> {
  const t = Math.min(Math.max(0, atSec), Math.max(0, media.probe.durationSec - 0.2));
  const rounded = Math.round(t);
  const saved = (await loadSaved<{ atSec?: number; title?: string; format?: string }>(media.mediaKey, "thumbnail")).find(
    (row) => row.format === format && row.title === title && Math.round(row.atSec || 0) === rounded,
  );
  if (saved) {
    const ext = format === "jpg" ? "jpg" : "png";
    const filename = `thumb-${rounded}.${ext}`;
    const outputPath = path.join(path.dirname(media.path), filename);
    try {
      await fs.access(outputPath);
      return { outputPath, filename, cached: true };
    } catch {
      // the file was removed; make it again
    }
  }
  const dir = path.dirname(media.path);
  const frame = path.join(dir, `.frame-${media.mediaKey}.png`);
  const shot = await runCommand(
    "ffmpeg",
    ["-y", "-ss", t.toFixed(2), "-i", media.path, "-frames:v", "1", frame],
    { timeoutMs: 30_000 },
  );
  if (shot.code !== 0) throw new Error("No se pudo leer ese fotograma.");
  const ext = format === "jpg" ? "jpg" : "png";
  const filename = `thumb-${Math.round(t)}.${ext}`;
  const outputPath = path.join(path.dirname(media.path), filename);
  const font = await resolveFont();
  const targetW = format === "vertical" ? 1080 : 1280;
  const targetH = format === "vertical" ? 1920 : 720;
  const made = await runCommand(
    python(),
    [THUMB, frame, outputPath, font, String(targetW), String(targetH), title || "", "fit"],
    { timeoutMs: 20_000 },
  );
  if (made.code !== 0) throw new Error(made.stderr.slice(-200) || "No se pudo armar la miniatura.");
  await pool.query(
    `INSERT INTO tool_results (id, media_key, tool, status, payload, output_path) VALUES ($1,$2,'thumbnail','completed',$3,$4)`,
    [randomUUID(), media.mediaKey, JSON.stringify({ atSec: t, title, format }), outputPath],
  );
  return { outputPath, filename };
}

export async function suggestFrames(media: MediaRow): Promise<number[]> {
  const d = media.probe.durationSec;
  return [d * 0.15, d * 0.5, d * 0.8].map((t) => Math.max(0, Math.min(d - 0.2, t)));
}

const stops = new Map<string, AbortController>();

export function cancelTool(id: string): boolean {
  const job = running.get(id);
  const stop = stops.get(id);
  if (!job || job.status !== "processing") return false;
  job.status = "error";
  job.progress = "Detenido";
  job.error = "Detenido";
  stop?.abort();
  return true;
}

export function startTool(work: (job: ToolJob) => Promise<unknown>): ToolJob {
  const job: ToolJob = { id: randomUUID(), status: "processing", progress: "Procesando…" };
  const stop = new AbortController();
  running.set(job.id, job);
  stops.set(job.id, stop);
  void toolAbort.run(stop.signal, () => work(job))
    .then((result) => {
      if (job.error === "Detenido") return;
      job.status = "completed";
      job.progress = "Listo";
      job.result = result;
    })
    .catch((err: unknown) => {
      if (job.error === "Detenido") return;
      const message = err instanceof Error ? err.message : String(err);
      job.status = "error";
      job.progress = message === "Detenido" ? "Detenido" : "Error";
      job.error = message === "Detenido" ? "Detenido" : message;
    })
    .finally(() => {
      stops.delete(job.id);
    });
  return job;
}

export async function listResults(mediaKey: string): Promise<unknown[]> {
  const { rows } = await pool.query(
    "SELECT tool, status, payload, output_path, error, created_at FROM tool_results WHERE media_key = $1 ORDER BY created_at DESC LIMIT 20",
    [mediaKey],
  );
  return rows;
}
