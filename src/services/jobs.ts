import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { detectHighlights } from "./highlight.js";
import { exportAllClips } from "./compose.js";
import { downloadSourceVideo, keepLastMinutes } from "./download.js";
import { probeVideo, ensureDir, jobContext, killJobProcesses, CancelledError, makeSeekable } from "./ffmpeg.js";
import { detectWebcamRect } from "./webcam.js";
import { transcribeClipSegments, transcribeMomentLines } from "./captions.js";
import { buildSocialCopies, moodLabel } from "./copy.js";
import {
  DEFAULT_CLIP_OPTIONS,
  DEFAULT_GAMEPLAY_CROP,
  DEFAULT_WEBCAM_PRESETS,
  capExportSize,
  outputLabel,
  type ClipOptions,
  type ClipQuality,
  type CropConfig,
  type HighlightCandidate,
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
  const quality = (["360", "720", "1080", "1440", "2160"].includes(qualityRaw) ? qualityRaw : "720") as ClipQuality;
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
    clipPickMode: parsePickMode(body.clipPickMode),
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
    burnOverlay: liveOn(body.burnOverlay),
    burnSubs: liveOn(body.burnSubs),
    subLook: parseSubLook(body.subLook),
    subColor: /^#[0-9a-fA-F]{6}$/.test(String(body.subColor || "")) ? String(body.subColor) : "#ffffff",
    subSize: body.subSize === "chico" || body.subSize === "grande" ? body.subSize : "normal",
    subPosition: body.subPosition === "top" || body.subPosition === "middle" ? body.subPosition : "bottom",
  };
}

function parsePickMode(v: unknown): ClipOptions["clipPickMode"] {
  const s = String(v ?? "");
  if (s === "split" || s === "full") return s;
  return "highlights";
}

function parseSubLook(v: unknown): ClipOptions["subLook"] {
  const s = String(v || "");
  if (s === "barra" || s === "palabra") return s;
  return "frase";
}

function parseCookiesBrowser(v: unknown): ClipOptions["cookiesBrowser"] {
  const s = String(v ?? "auto").trim().toLowerCase();
  if (s === "chrome" || s === "safari" || s === "firefox" || s === "brave" || s === "edge" || s === "none") {
    return s;
  }
  return "auto";
}

function pickProgress(options: ClipOptions): string {
  if (options.clipPickMode === "full") return "Preparando el vídeo completo…";
  if (options.clipPickMode === "split") {
    return `Partiendo el vídeo en ${options.maxClips} clips de ${options.clipDurationSec}s…`;
  }
  return "Buscando los mejores momentos en el vídeo completo…";
}

function sliceHeard(
  segments: HeardClip["segments"],
  start: number,
  end: number,
): HeardClip {
  const cues: HeardClip["segments"] = [];
  for (const seg of segments) {
    if (seg.end <= start + 0.02 || seg.start >= end - 0.02) continue;
    const words = seg.words
      ?.filter((word) => word.end > start + 0.02 && word.start < end - 0.02)
      .map((word) => ({
        word: word.word,
        start: Math.max(0, word.start - start),
        end: Math.max(0.05, Math.min(end - start, word.end - start)),
      }));
    cues.push({
      start: Math.max(0, seg.start - start),
      end: Math.min(end - start, seg.end - start),
      text: words?.length ? words.map((word) => word.word).join(" ") : seg.text,
      words: words?.length ? words : undefined,
    });
  }
  return { text: cues.map((cue) => cue.text).join(" "), segments: cues };
}

function sampleSpeech(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 1200) return clean;
  const mid = Math.floor(clean.length / 2);
  return `${clean.slice(0, 450)} … ${clean.slice(mid, mid + 350)} … ${clean.slice(-350)}`;
}

type HeardClip = {
  text: string;
  segments: Array<{ start: number; end: number; text: string; words?: Array<{ start: number; end: number; word: string }> }>;
};

async function hearClipWindows(
  id: string,
  highlightPath: string,
  highlights: HighlightCandidate[],
  hasAudio: boolean,
  burnSubs: boolean,
): Promise<HeardClip[]> {
  touch(jobs.get(id)!, {
    progress: burnSubs
      ? "Escuchando cada clip para los subtítulos, la frase y la descripción…"
      : "Escuchando lo que se dice para la frase y la descripción…",
  });
  if (!hasAudio) return highlights.map(() => ({ text: "", segments: [] }));
  const { cachedTranscript } = await import("./tools.js");
  const saved = await cachedTranscript(highlightPath, path.basename(highlightPath)).catch(() => null);
  if (saved?.segments.length) {
    touch(jobs.get(id)!, { progress: "Este vídeo ya estaba escuchado. Se reutiliza para los clips." });
    return highlights.map((h) => sliceHeard(saved.segments, h.startSec, h.endSec));
  }
  const workDir = path.join(JOBS_DIR, id, "work", "lines");
  if (burnSubs) {
    return transcribeClipSegments(
      highlights.map((h, i) => ({
        sourcePath: highlightPath,
        startSec: h.startSec,
        endSec: h.endSec,
        clipId: `line-${String(i + 1).padStart(2, "0")}`,
      })),
      workDir,
      (msg) => touch(jobs.get(id)!, { progress: msg }),
    );
  }
  const lines = await transcribeMomentLines(
    highlights.map((h, i) => ({
      sourcePath: highlightPath,
      startSec: h.startSec,
      endSec: h.endSec,
      peakSec: h.peakSec,
      clipId: `line-${String(i + 1).padStart(2, "0")}`,
    })),
    workDir,
    (msg) => touch(jobs.get(id)!, { progress: msg }),
  );
  return lines.map((text) => ({ text, segments: [] }));
}

async function hearWholeVideo(
  id: string,
  sourcePath: string,
  filename: string,
  durationSec: number,
  hasAudio: boolean,
  burnSubs: boolean,
): Promise<HeardClip[]> {
  if (!hasAudio) return [{ text: "", segments: [] }];
  touch(jobs.get(id)!, {
    progress: burnSubs
      ? "Escuchando el vídeo entero para la frase, la descripción y los subtítulos…"
      : "Escuchando el vídeo entero para la frase y la descripción…",
  });
  try {
    const { resolveMedia, ensureTranscript } = await import("./tools.js");
    const media = await resolveMedia({ jobId: id, filePath: sourcePath, filename });
    const spoken = await ensureTranscript(media, burnSubs);
    const segments = spoken.segments
      .filter((seg) => seg.start < durationSec && seg.text.trim())
      .map((seg) => ({
        start: seg.start,
        end: Math.min(seg.end, durationSec),
        text: seg.text,
        words: seg.words
          ?.filter((word) => word.start < durationSec && word.word.trim())
          .map((word) => ({ ...word, end: Math.min(word.end, durationSec) })),
      }));
    return [{ text: sampleSpeech(spoken.text), segments }];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    touch(jobs.get(id)!, { progress: `No se pudo escuchar el audio (${message}). El vídeo se exporta igual.` });
    return [{ text: "", segments: [] }];
  }
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
          : `Buscando ${label} (caché o descarga)…`,
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

    current = touch(jobs.get(id)!, { status: "analyzing", progress: "Indexando el vídeo para cortes rápidos…" });
    const seekable = await makeSeekable(current.sourcePath);
    current = touch(jobs.get(id)!, { sourcePath: seekable });
    if (current.sourcePathB) {
      const seekableB = await makeSeekable(current.sourcePathB);
      current = touch(jobs.get(id)!, { sourcePathB: seekableB });
    }
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
    const capped = capExportSize(current.options.output, probe.width, probe.height);
    const originNote = capped.note || `Origen ${probe.width}x${probe.height} · ${probe.fps || "?"} fps · ${probe.codec || "vídeo"}`;
    current = touch(jobs.get(id)!, {
      sourceDurationSec: durationSec,
      sourceWidth: probe.width,
      sourceHeight: probe.height,
      qualityNote: capped.note,
      options: { ...current.options, output: capped.output },
      progress:
        current.options.layout === "pair"
          ? `Dos vídeos · ${durationSec.toFixed(1)}s en común · ${originNote}`
          : `${originNote}, ${probe.durationSec.toFixed(1)}s`,
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
        crop: {
          ...current.crop,
          webcam: detected.rect,
          webcamFocus: detected.focus,
          webcamPreset: "auto",
        },
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
    const fullVideo = current.options.clipPickMode === "full";
    const highlights = fullVideo
      ? [
          {
            peakSec: durationSec / 2,
            startSec: 0,
            endSec: durationSec,
            score: 1,
            reasons: ["vídeo completo"],
          },
        ]
      : await detectHighlights(highlightPath, durationSec, highlightProbe.hasAudio, current.options, workDir);
    current = touch(jobs.get(id)!, {
      highlights,
      status: "exporting",
      progress: fullVideo
        ? `Vídeo completo — exportando en ${current.options.quality}p…`
        : current.options.clipPickMode === "split"
          ? `Partido en ${highlights.length} clips — exportando en ${current.options.quality}p…`
          : `Encontrados ${highlights.length} momentos — exportando en ${current.options.quality}p…`,
    });

    assertRunning(id);
    const heard = fullVideo
      ? await hearWholeVideo(id, highlightPath, current.sourceFilename, durationSec, highlightProbe.hasAudio, current.options.burnSubs)
      : await hearClipWindows(id, highlightPath, highlights, highlightProbe.hasAudio, current.options.burnSubs);
    assertRunning(id);
    touch(jobs.get(id)!, { progress: "Ollama escribe la frase y la descripción…" });
    const copies = await buildSocialCopies({
      transcripts: heard.map((line) => line.text),
      sourceName: current.sourceFilename,
      sourceUrl: current.sourceUrl,
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
      current.options.burnOverlay ? copies.map((c) => c.overlay) : undefined,
    );

    if (current.options.burnSubs) {
      const { burnSubtitles, resolveMedia } = await import("./tools.js");
      for (let i = 0; i < clips.length; i++) {
        assertRunning(id);
        const cues = heard[i]?.segments.filter((cue) => cue.end > cue.start && cue.text.trim()) ?? [];
        if (!cues.length) continue;
        touch(jobs.get(id)!, {
          progress:
            clips.length === 1 && current.options.clipPickMode === "full"
              ? "Poniendo subtítulos en el vídeo completo…"
              : `Poniendo subtítulos en el clip ${i + 1} de ${clips.length}…`,
        });
        try {
          const clip = clips[i]!;
          const media = await resolveMedia({ jobId: id, filePath: clip.path, filename: clip.filename });
          const burned = await burnSubtitles(
            media,
            {
              position: current.options.subPosition,
              color: current.options.subColor,
              look: current.options.subLook,
              size: current.options.subSize,
            },
            cues,
            (msg) => touch(jobs.get(id)!, { progress: msg }),
          );
          await fs.rm(clip.path, { force: true });
          await fs.rename(burned.outputPath, clip.path);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          touch(jobs.get(id)!, { progress: `El clip ${i + 1} quedó sin subtítulos: ${message}` });
        }
      }
    }

    const { rememberTranscript } = await import("./tools.js");
    for (let i = 0; i < clips.length; i++) {
      const line = heard[i];
      const clip = clips[i];
      if (!clip || !line?.text.trim()) continue;
      await rememberTranscript(clip.path, clip.filename, line).catch(() => undefined);
    }

    const withUrls = clips.map((c, i) => {
      const copy = copies[i]!;
      return {
        ...c,
        url: `/api/jobs/${id}/clips/${c.filename}`,
        title: copy.title,
        caption: copy.caption,
        overlay: copy.overlay,
        mood: moodLabel(copy.mood),
      };
    });

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
      progress:
        jobs.get(id)!.options.clipPickMode === "full"
          ? "Listo — el vídeo completo está para descargar"
          : `Listo — ${withUrls.length} clips disponibles`,
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
