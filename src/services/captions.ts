import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { FFMPEG_THREADS, runCommand } from "./ffmpeg.js";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/transcribe_es.py");
const LINES_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/transcribe_lines.py");

const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/Library/Fonts/Arial Unicode.ttf",
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
];

export interface Transcript {
  title: string;
  srtPath?: string;
  text: string;
}

function pythonBin(): string {
  return process.env.PYTHON_BIN || "python3.11";
}

export async function resolveFont(): Promise<string> {
  for (const p of FONT_CANDIDATES) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // next
    }
  }
  return FONT_CANDIDATES[0]!;
}

export function wrapHeadline(text: string, limit = 36): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return "";
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const trial = (cur + " " + w).trim();
    if (trial.length <= limit) {
      cur = trial;
      continue;
    }
    if (cur) lines.push(cur);
    cur = w;
    if (lines.length >= 2) break;
  }
  if (cur && lines.length < 2) lines.push(cur);
  return lines.slice(0, 2).join("\n");
}

async function extractWav(
  sourcePath: string,
  startSec: number,
  durationSec: number,
  wav: string,
  limitSec = 45,
): Promise<boolean> {
  const { code } = await runCommand(
    "ffmpeg",
    [
      "-y",
      "-ss",
      startSec.toFixed(2),
      "-i",
      sourcePath,
      "-t",
      Math.min(durationSec, limitSec).toFixed(2),
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-threads",
      String(FFMPEG_THREADS),
      wav,
    ],
    { timeoutMs: 2 * 60 * 1000 },
  );
  return code === 0;
}

export interface TimedLine {
  text: string;
  segments: Array<{ start: number; end: number; text: string; words?: Array<{ start: number; end: number; word: string }> }>;
}

async function readLineItems(
  wavs: Array<string | null>,
  outJson: string,
  timed: boolean,
  onProgress?: (msg: string) => void,
): Promise<TimedLine[]> {
  const texts: TimedLine[] = wavs.map(() => ({ text: "", segments: [] }));
  const ready = wavs.filter((w): w is string => Boolean(w));
  if (!ready.length) return texts;
  const args = [LINES_SCRIPT, outJson, ...(timed ? ["--timed"] : []), ...ready];
  const { code } = await runCommand(pythonBin(), args, {
    timeoutMs: Math.min(40, Math.max(8, ready.length)) * 60 * 1000,
    onChunk: (chunk) => {
      const line = chunk.trim().split("\n").at(-1) || "";
      try {
        const parsed = JSON.parse(line) as { progress?: number };
        if (typeof parsed.progress === "number") {
          onProgress?.(`Escuchando los clips… ${Math.round(parsed.progress * 100)}%`);
        }
      } catch {
        // ignore model logs
      }
    },
  });
  if (code !== 0) return texts;
  const parsed = JSON.parse(await fs.readFile(outJson, "utf8")) as {
    items?: Array<{ ok?: boolean; text?: string; segments?: TimedLine["segments"] }>;
  };
  let k = 0;
  for (let i = 0; i < wavs.length; i++) {
    if (!wavs[i]) continue;
    const item = parsed.items?.[k++];
    texts[i] = { text: item?.text || "", segments: item?.segments || [] };
  }
  return texts;
}

/** A few seconds around each peak, so the phrase matches that moment. */
export async function transcribeMomentLines(
  clips: Array<{ sourcePath: string; startSec: number; endSec: number; peakSec: number; clipId: string }>,
  workDir: string,
  onProgress?: (msg: string) => void,
): Promise<string[]> {
  await fs.mkdir(workDir, { recursive: true });
  const wavs: Array<string | null> = clips.map(() => null);
  let next = 0;
  const workers = Math.min(4, clips.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const i = next++;
        if (i >= clips.length) return;
        const clip = clips[i]!;
        const span = Math.max(0.5, clip.endSec - clip.startSec);
        const window = Math.min(14, span);
        const start = Math.max(clip.startSec, Math.min(clip.peakSec - 4, clip.endSec - window));
        const wav = path.join(workDir, `${clip.clipId}.wav`);
        const ok = await extractWav(clip.sourcePath, start, window, wav);
        wavs[i] = ok ? wav : null;
      }
    }),
  );
  const outJson = path.join(workDir, "lines.json");
  onProgress?.("Escuchando lo que se dice en cada clip…");
  let lines: TimedLine[] = wavs.map(() => ({ text: "", segments: [] }));
  try {
    lines = await readLineItems(wavs, outJson, false, onProgress);
  } catch {
    // leave blanks; copy falls back
  }
  for (const wav of wavs) {
    if (wav) await fs.unlink(wav).catch(() => undefined);
  }
  return lines.map((line) => line.text);
}

/** Full clip window with timestamps, for burned subtitles. */
export async function transcribeClipSegments(
  clips: Array<{ sourcePath: string; startSec: number; endSec: number; clipId: string }>,
  workDir: string,
  onProgress?: (msg: string) => void,
): Promise<TimedLine[]> {
  await fs.mkdir(workDir, { recursive: true });
  const wavs: Array<string | null> = clips.map(() => null);
  let next = 0;
  const workers = Math.min(4, clips.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const i = next++;
        if (i >= clips.length) return;
        const clip = clips[i]!;
        const span = Math.max(0.5, clip.endSec - clip.startSec);
        const wav = path.join(workDir, `${clip.clipId}.wav`);
        const ok = await extractWav(clip.sourcePath, clip.startSec, span, wav, Math.min(span, 180));
        wavs[i] = ok ? wav : null;
      }
    }),
  );
  const outJson = path.join(workDir, "cues.json");
  onProgress?.("Escuchando el clip entero para los subtítulos…");
  let lines: TimedLine[] = wavs.map(() => ({ text: "", segments: [] }));
  try {
    lines = await readLineItems(wavs, outJson, true, onProgress);
  } catch {
    // leave blanks
  }
  for (const wav of wavs) {
    if (wav) await fs.unlink(wav).catch(() => undefined);
  }
  return lines;
}

export async function transcribeClipSpanish(
  sourcePath: string,
  startSec: number,
  durationSec: number,
  workDir: string,
  clipId: string,
): Promise<Transcript | null> {
  const many = await transcribeClipsBatch(
    [{ sourcePath, startSec, durationSec, clipId }],
    workDir,
  );
  return many[0] ?? null;
}

export async function transcribeClipsBatch(
  clips: Array<{ sourcePath: string; startSec: number; durationSec: number; clipId: string }>,
  workDir: string,
): Promise<Array<Transcript | null>> {
  await fs.mkdir(workDir, { recursive: true });
  const jobs: Array<{ wav: string; srt: string; clipId: string } | null> = [];
  for (const clip of clips) {
    const wav = path.join(workDir, `${clip.clipId}.wav`);
    const srt = path.join(workDir, `${clip.clipId}.srt`);
    const ok = await extractWav(clip.sourcePath, clip.startSec, clip.durationSec, wav);
    jobs.push(ok ? { wav, srt, clipId: clip.clipId } : null);
  }
  const args: string[] = [];
  for (const j of jobs) {
    if (j) args.push(j.wav, j.srt);
  }
  const out: Array<Transcript | null> = clips.map(() => null);
  if (!args.length) return out;
  try {
    const { stdout, code } = await runCommand(pythonBin(), [SCRIPT, ...args], {
      timeoutMs: 12 * 60 * 1000,
    });
    const line = stdout.trim().split("\n").at(-1) || "{}";
    const parsed = JSON.parse(line) as {
      ok?: boolean;
      items?: Array<{ ok?: boolean; title?: string; text?: string; srt?: string }>;
      title?: string;
      text?: string;
    };
    const items = parsed.items ?? (parsed.ok ? [parsed] : []);
    let k = 0;
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      if (!job) continue;
      const item = items[k++];
      if (code !== 0 || !item?.ok) continue;
      const hasSrt = (await fs.stat(job.srt).catch(() => null))?.size;
      out[i] = {
        title: item.title || "",
        text: item.text || "",
        srtPath: hasSrt ? job.srt : undefined,
      };
    }
  } catch {
    // leave nulls
  }
  for (const j of jobs) {
    if (j) await fs.unlink(j.wav).catch(() => undefined);
  }
  return out;
}

export function ffmpegPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export interface OverlayCue {
  file: string;
  start: number;
  end: number;
  kind: string;
  x?: number;
  y?: number;
}

const RENDER = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/render_overlays.py");

export async function renderTextOverlays(
  outDir: string,
  width: number,
  height: number,
  title: string,
  srtPath: string | undefined,
): Promise<OverlayCue[]> {
  await fs.mkdir(outDir, { recursive: true });
  const { stdout, code } = await runCommand(
    pythonBin(),
    [RENDER, outDir, String(width), String(height), title || "", srtPath || "-"],
    { timeoutMs: 60_000 },
  );
  if (code !== 0) return [];
  try {
    const parsed = JSON.parse(stdout.trim().split("\n").at(-1) || "{}") as {
      ok?: boolean;
      overlays?: OverlayCue[];
    };
    return parsed.ok ? parsed.overlays ?? [] : [];
  } catch {
    return [];
  }
}
