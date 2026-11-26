import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { downloadSourceVideo } from "./download.js";
import {
  CancelledError,
  ensureDir,
  jobContext,
  killJobProcesses,
  probeVideo,
  runCommand,
} from "./ffmpeg.js";

const ROOT = path.resolve(process.cwd());
const DATA_DIR = path.join(ROOT, "data");
export const TRANSCRIPTS_DIR = path.join(DATA_DIR, "transcripts");
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/transcribe_verbatim.py");

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export type TranscriptStatus = "queued" | "downloading" | "transcribing" | "done" | "error" | "cancelled";

export interface TranscriptJob {
  id: string;
  status: TranscriptStatus;
  createdAt: string;
  updatedAt: string;
  sourceFilename: string;
  sourceUrl?: string;
  progress: string;
  error?: string;
  language?: string;
  text?: string;
  segments?: TranscriptSegment[];
}

const jobs = new Map<string, TranscriptJob>();

function touch(job: TranscriptJob, patch: Partial<TranscriptJob>): TranscriptJob {
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(job.id, next);
  return next;
}

function assertRunning(id: string): void {
  if (jobs.get(id)?.status === "cancelled") throw new CancelledError();
}

export function getTranscript(id: string): TranscriptJob | undefined {
  return jobs.get(id);
}

export function cancelTranscript(id: string): TranscriptJob | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  if (job.status === "done" || job.status === "error" || job.status === "cancelled") return job;
  touch(job, { status: "cancelled", progress: "Detenido", error: "Cancelado por el usuario" });
  killJobProcesses(id);
  return jobs.get(id);
}

export async function createTranscript(input: {
  sourcePath?: string;
  sourceUrl?: string;
  sourceFilename: string;
}): Promise<TranscriptJob> {
  await ensureDir(TRANSCRIPTS_DIR);
  const id = randomUUID();
  const now = new Date().toISOString();
  const job: TranscriptJob = {
    id,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    sourceFilename: input.sourceFilename,
    sourceUrl: input.sourceUrl,
    progress: input.sourceUrl ? "En cola — descargando enlace…" : "En cola",
  };
  jobs.set(id, job);
  void jobContext.run(id, () => processTranscript(id, input.sourcePath));
  return job;
}

async function extractWav(sourcePath: string, wav: string): Promise<void> {
  const { code, stderr } = await runCommand(
    "ffmpeg",
    ["-y", "-i", sourcePath, "-vn", "-ac", "1", "-ar", "16000", wav],
    { timeoutMs: 20 * 60 * 1000 },
  );
  if (code !== 0) {
    throw new Error(`No se pudo extraer el audio: ${stderr.slice(-400)}`);
  }
}

function srtStamp(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

export function transcriptSrt(job: TranscriptJob): string {
  const cues = job.segments ?? [];
  return cues
    .map((cue, i) => `${i + 1}\n${srtStamp(cue.start)} --> ${srtStamp(cue.end)}\n${cue.text}\n`)
    .join("\n");
}

async function processTranscript(id: string, uploadedPath?: string): Promise<void> {
  const job = jobs.get(id);
  if (!job) return;
  const dir = path.join(TRANSCRIPTS_DIR, id);
  try {
    await ensureDir(dir);
    assertRunning(id);
    let media = uploadedPath ?? "";
    if (job.sourceUrl) {
      touch(jobs.get(id)!, { status: "downloading", progress: "Descargando el vídeo…" });
      const file = await downloadSourceVideo(
        job.sourceUrl,
        dir,
        id,
        360,
        undefined,
        (msg) => {
          const current = jobs.get(id);
          if (current && current.status !== "cancelled") touch(current, { progress: msg });
        },
        "auto",
      );
      media = file.path;
    }
    assertRunning(id);
    const probe = await probeVideo(media);
    if (!probe.hasAudio) throw new Error("Este vídeo no tiene audio para transcribir.");
    touch(jobs.get(id)!, { status: "transcribing", progress: "Transcribiendo palabra por palabra…" });
    const wav = path.join(dir, "audio.wav");
    await extractWav(media, wav);
    assertRunning(id);
    const outJson = path.join(dir, "transcript.json");
    const timeoutMs = Math.round(Math.min(4 * 60, Math.max(20, probe.durationSec / 60 * 3 + 10)) * 60 * 1000);
    const { code, stderr, stdout } = await runCommand(
      process.env.PYTHON_BIN || "python3.11",
      [SCRIPT, wav, outJson],
      {
        timeoutMs,
        onChunk: (chunk) => {
          const current = jobs.get(id);
          if (!current || current.status === "cancelled") return;
          const line = chunk.trim().split("\n").at(-1) || "";
          try {
            const parsed = JSON.parse(line) as { progress?: number };
            if (typeof parsed.progress === "number") {
              const pct = Math.round(parsed.progress * 100);
              touch(current, { progress: `Transcribiendo… ${pct}%` });
            }
          } catch {
            // model logs are not json
          }
        },
      },
    );
    assertRunning(id);
    if (code !== 0) {
      const tail = (stderr || stdout).trim().split("\n").at(-1) || "falló la transcripción";
      throw new Error(tail.slice(0, 400));
    }
    const raw = JSON.parse(await fs.readFile(outJson, "utf8")) as {
      ok?: boolean;
      error?: string;
      language?: string;
      text?: string;
      segments?: TranscriptSegment[];
    };
    if (!raw.ok) throw new Error(raw.error || "La transcripción no salió.");
    await fs.unlink(wav).catch(() => undefined);
    touch(jobs.get(id)!, {
      status: "done",
      progress: "Listo",
      language: raw.language || "",
      text: raw.text || "",
      segments: raw.segments ?? [],
    });
  } catch (err) {
    if (err instanceof CancelledError || jobs.get(id)?.status === "cancelled") {
      touch(jobs.get(id)!, { status: "cancelled", progress: "Detenido" });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    touch(jobs.get(id)!, { status: "error", progress: "Error", error: message });
  }
}
