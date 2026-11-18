import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { detectHighlights } from "./highlight.js";
import { exportAllClips } from "./compose.js";
import { downloadSourceVideo, keepLastMinutes } from "./download.js";
import { probeVideo, ensureDir, jobContext, killJobProcesses, CancelledError } from "./ffmpeg.js";
import { detectWebcamRect } from "./webcam.js";
import {
  DEFAULT_CLIP_OPTIONS,
  DEFAULT_GAMEPLAY_CROP,
  DEFAULT_WEBCAM_PRESETS,
  outputLabel,
  type ClipOptions,
  type ClipQuality,
  type CropConfig,
  type Job,
  type WebcamPreset,
} from "../types.js";

const ROOT = path.resolve(process.cwd());
export const DATA_DIR = path.join(ROOT, "data");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
export const JOBS_DIR = path.join(DATA_DIR, "jobs");

const jobs = new Map<string, Job>();

export async function initStorage(): Promise<void> {
  await ensureDir(UPLOADS_DIR);
  await ensureDir(JOBS_DIR);
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function touch(job: Job, patch: Partial<Job>): Job {
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(job.id, next);
  return next;
}

export function parseCropConfig(body: Record<string, unknown>): CropConfig {
  const preset = (String(body.webcamPreset ?? "auto") as WebcamPreset) || "auto";
  const webcam =
    preset === "custom"
      ? {
          x: num(body.webcamX, 0.01),
          y: num(body.webcamY, 0.68),
          w: num(body.webcamW, 0.24),
          h: num(body.webcamH, 0.3),
        }
      : preset === "auto"
        ? DEFAULT_WEBCAM_PRESETS["bottom-right"]
        : DEFAULT_WEBCAM_PRESETS[preset as Exclude<WebcamPreset, "custom" | "auto">] ??
          DEFAULT_WEBCAM_PRESETS["bottom-right"];

  const gameplay = {
    x: num(body.gameplayX, DEFAULT_GAMEPLAY_CROP.x),
    y: num(body.gameplayY, DEFAULT_GAMEPLAY_CROP.y),
    w: num(body.gameplayW, DEFAULT_GAMEPLAY_CROP.w),
    h: num(body.gameplayH, DEFAULT_GAMEPLAY_CROP.h),
  };

  return {
    webcamPreset:
      preset === "custom" || preset === "auto"
        ? preset
        : (preset as Exclude<WebcamPreset, "custom" | "auto">),
    webcam,
    gameplay,
  };
}

export function parseClipOptions(body: Record<string, unknown>): ClipOptions {
  const pair =
    String(body.sourceMode ?? "") === "pair" ||
    body.layout === "pair" ||
    Boolean(String(body.sourceUrlB ?? "").trim());
  const layout: ClipOptions["layout"] = pair ? "pair" : body.layout === "full" ? "full" : "dual";
  const qualityRaw = String(body.quality ?? DEFAULT_CLIP_OPTIONS.quality);
  const quality = (["360", "720", "1080"].includes(qualityRaw) ? qualityRaw : "720") as ClipQuality;
  const duration = clamp(num(body.clipDurationSec, DEFAULT_CLIP_OPTIONS.clipDurationSec), 5, 180);
  const padBeforeDefault = Math.min(Math.round(duration * 0.3), Math.max(0, duration - 1));
  const padAfterDefault = Math.max(1, duration - padBeforeDefault);
  return {
    ...DEFAULT_CLIP_OPTIONS,
    layout,
    quality,
    output: outputLabel(layout === "pair" ? "dual" : layout, quality),
    clipDurationSec: duration,
    minClipSec: duration,
    maxClipSec: duration,
    maxClips: clamp(Math.round(num(body.maxClips, DEFAULT_CLIP_OPTIONS.maxClips)), 1, 200),
    clipPickMode: String(body.clipPickMode ?? "") === "split" ? "split" : "highlights",
    padBeforeSec: clamp(num(body.padBeforeSec, padBeforeDefault), 0, duration),
    padAfterSec: clamp(num(body.padAfterSec, padAfterDefault), 1, duration),
    audioPeakPercentile: clamp(
      num(body.audioPeakPercentile, DEFAULT_CLIP_OPTIONS.audioPeakPercentile),
      50,
      99,
    ),
    sceneThreshold: clamp(num(body.sceneThreshold, DEFAULT_CLIP_OPTIONS.sceneThreshold), 0.1, 0.8),
    liveLastMinutes: liveOn(body.liveMode)
      ? clamp(Math.round(num(body.liveLastMinutes, 30)), 1, 180)
      : 0,
    cookiesBrowser: liveOn(body.liveMode) ? parseCookiesBrowser(body.cookiesBrowser) : "none",
    pairOrder: body.pairOrder === "b-top" ? "b-top" : "a-top",
    pairHighlight: body.pairHighlight === "b" ? "b" : "a",
    pairAudioA: pair ? liveOn(body.pairAudioA) : true,
    pairAudioB: pair ? liveOn(body.pairAudioB) : false,
  };
}

function parseCookiesBrowser(v: unknown): ClipOptions["cookiesBrowser"] {
  const s = String(v ?? "auto").trim().toLowerCase();
  if (s === "chrome" || s === "safari" || s === "firefox" || s === "brave" || s === "edge" || s === "none") {
    return s;
  }
  return "auto";
}

function pickProgress(options: ClipOptions): string {
  if (options.clipPickMode === "split") {
    return `Partiendo el vídeo en ${options.maxClips} clips de ${options.clipDurationSec}s…`;
  }
  return "Buscando los mejores momentos en el vídeo completo…";
}

function liveOn(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v !== "string") return false;
  return ["on", "true", "1", "yes", "sí", "si"].includes(v.trim().toLowerCase());
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export async function createJob(input: {
  sourcePath?: string;
  sourceUrl?: string;
  sourceFilename: string;
  sourcePathB?: string;
  sourceFilenameB?: string;
  sourceUrlB?: string;
  crop: CropConfig;
  options: ClipOptions;
}): Promise<Job> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const needsDl = (input.sourceUrl && !input.sourcePath) || (input.sourceUrlB && !input.sourcePathB);
  const job: Job = {
    id,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    sourceFilename: input.sourceFilename,
    sourcePath: input.sourcePath ?? "",
    sourceUrl: input.sourceUrl,
    sourcePathB: input.sourcePathB,
    sourceFilenameB: input.sourceFilenameB,
    sourceUrlB: input.sourceUrlB,
    crop: input.crop,
    options: input.options,
    progress: needsDl ? "En cola — descargando enlace…" : "En cola",
  };
  jobs.set(id, job);

  void jobContext.run(id, () => processJob(id));
  return job;
}

export function cancelJob(id: string): Job | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
    return job;
  }
  touch(job, { status: "cancelled", progress: "Detenido", error: "Cancelado por el usuario" });
  killJobProcesses(id);
  return jobs.get(id);
}

function assertRunning(id: string): void {
  if (jobs.get(id)?.status === "cancelled") throw new CancelledError();
}

async function processJob(id: string): Promise<void> {
  const job = jobs.get(id);
  if (!job) return;

  const jobDir = path.join(JOBS_DIR, id);
  const clipsDir = path.join(jobDir, "clips");
  const workDir = path.join(jobDir, "work");

  try {
    await ensureDir(clipsDir);
    await ensureDir(workDir);

    let current = jobs.get(id)!;
    assertRunning(id);

    const downloadOne = async (url: string, fileId: string, label: string, withLive: boolean) => {
      const liveMin = withLive ? current.options.liveLastMinutes : 0;
      touch(jobs.get(id)!, {
        status: "downloading",
        progress: liveMin
          ? `Descargando ${label}: últimos ${liveMin} min…`
          : `Descargando ${label}…`,
      });
      return downloadSourceVideo(
        url,
        path.join(jobDir, "source"),
        fileId,
        Number(current.options.quality) || 720,
        liveMin || undefined,
        (msg) => {
          const j = jobs.get(id);
          if (!j || j.status === "cancelled") return;
          touch(j, { progress: `${label}: ${msg}` });
        },
        current.options.cookiesBrowser,
      );
    };

    const downloads: Promise<void>[] = [];
    if (current.sourceUrl && !current.sourcePath) {
      downloads.push(
        downloadOne(current.sourceUrl, `${id.slice(0, 8)}a`, "vídeo 1", true).then((downloaded) => {
          current = touch(jobs.get(id)!, {
            sourcePath: downloaded.path,
            sourceFilename: downloaded.filename,
            progress: "Vídeo 1 listo…",
          });
        }),
      );
    }
    if (current.sourceUrlB && !current.sourcePathB) {
      downloads.push(
        downloadOne(current.sourceUrlB, `${id.slice(0, 8)}b`, "vídeo 2", false).then((downloaded) => {
          current = touch(jobs.get(id)!, {
            sourcePathB: downloaded.path,
            sourceFilenameB: downloaded.filename,
            progress: "Vídeo 2 listo…",
          });
        }),
      );
    }
    if (downloads.length) await Promise.all(downloads);
    current = jobs.get(id)!;
    assertRunning(id);

    assertRunning(id);
    if (!current.sourcePath) {
      throw new Error("Falta el vídeo de origen");
    }

    current = touch(jobs.get(id)!, { status: "analyzing", progress: "Analizando el vídeo de origen…" });
    let probe = await probeVideo(current.sourcePath);
    if (current.options.liveLastMinutes) {
      const want = current.options.liveLastMinutes * 60;
      if (probe.durationSec > want + 4) {
        current = touch(jobs.get(id)!, {
          progress: `Recortando a ${current.options.liveLastMinutes} min…`,
        });
        const trimmed = await keepLastMinutes(current.sourcePath, current.options.liveLastMinutes, path.join(jobDir, "source"));
        current = touch(jobs.get(id)!, { sourcePath: trimmed.path, sourceFilename: trimmed.filename });
        probe = await probeVideo(current.sourcePath);
      }
    }
    let probeB = probe;
    if (current.options.layout === "pair") {
      if (!current.sourcePathB) throw new Error("Falta el segundo vídeo");
      probeB = await probeVideo(current.sourcePathB);
    }
    const durationSec =
      current.options.layout === "pair"
        ? Math.min(probe.durationSec, probeB.durationSec)
        : probe.durationSec;
    current = touch(jobs.get(id)!, {
      sourceDurationSec: durationSec,
      sourceWidth: probe.width,
      sourceHeight: probe.height,
      progress:
        current.options.layout === "pair"
          ? `Dos vídeos · ${durationSec.toFixed(1)}s en común`
          : `Detectado ${probe.width}x${probe.height}, ${probe.durationSec.toFixed(1)}s`,
    });

    if (
      current.options.layout !== "full" &&
      current.options.layout !== "pair" &&
      current.crop.webcamPreset === "auto"
    ) {
      current = touch(jobs.get(id)!, {
        progress: "Buscando la cara del streamer (webcam)…",
      });
      const detected = await detectWebcamRect(current.sourcePath, probe.durationSec, workDir);
      current = touch(jobs.get(id)!, {
        crop: { ...current.crop, webcam: detected.rect, webcamPreset: "auto" },
        progress:
          detected.method === "face"
            ? `Cara detectada (${detected.position || "overlay"}) — ${pickProgress(current.options)}`
            : `No se vio cara clara; se usa webcam abajo-derecha — ${pickProgress(current.options)}`,
      });
    } else {
      current = touch(jobs.get(id)!, {
        progress: pickProgress(current.options),
      });
    }

    assertRunning(id);
    const highlightPath =
      current.options.layout === "pair" && current.sourcePathB
        ? current.options.pairHighlight === "a"
          ? current.sourcePath
          : current.sourcePathB
        : current.sourcePath;
    const highlightProbe =
      current.options.layout === "pair" && current.options.pairHighlight === "b" ? probeB : probe;
    const highlights = await detectHighlights(
      highlightPath,
      durationSec,
      highlightProbe.hasAudio,
      current.options,
      workDir,
    );
    current = touch(jobs.get(id)!, {
      highlights,
      status: "exporting",
      progress:
        current.options.clipPickMode === "split"
          ? `Partido en ${highlights.length} clips — exportando en ${current.options.quality}p…`
          : `Encontrados ${highlights.length} momentos — exportando en ${current.options.quality}p…`,
    });

    assertRunning(id);
    const clips = await exportAllClips(
      current.sourcePath,
      highlights,
      current.crop,
      current.options,
      clipsDir,
      (msg) => touch(jobs.get(id)!, { progress: msg }),
      current.sourcePathB,
    );

    const withUrls = clips.map((c) => ({
      ...c,
      url: `/api/jobs/${id}/clips/${c.filename}`,
    }));

    // Persist job summary.
    await fs.writeFile(
      path.join(jobDir, "summary.json"),
      JSON.stringify(
        {
          id,
          sourceFilename: jobs.get(id)!.sourceFilename,
          sourceUrl: jobs.get(id)!.sourceUrl,
          probe,
          crop: jobs.get(id)!.crop,
          options: jobs.get(id)!.options,
          highlights,
          clips: withUrls.map(({ path: _p, ...rest }) => rest),
        },
        null,
        2,
      ),
    );

    assertRunning(id);
    touch(jobs.get(id)!, {
      status: "done",
      progress: `Listo — ${withUrls.length} clips disponibles`,
      clips: withUrls,
      highlights,
    });
  } catch (err) {
    if (err instanceof CancelledError || jobs.get(id)?.status === "cancelled") {
      touch(jobs.get(id)!, { status: "cancelled", progress: "Detenido", error: "Cancelado por el usuario" });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[job ${id}]`, message);
    touch(jobs.get(id)!, {
      status: "error",
      progress: "Falló",
      error: message,
    });
  } finally {
    killJobProcesses(id);
  }
}
