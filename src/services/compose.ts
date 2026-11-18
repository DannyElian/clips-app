import path from "node:path";
import { FFMPEG_THREADS, runCommand } from "./ffmpeg.js";
import {
  clampRect,
  outputLabel,
  resolveWebcamCrop,
  type ClipOptions,
  type ClipResult,
  type CropConfig,
  type HighlightCandidate,
} from "../types.js";

function outputSize(options: ClipOptions): { w: number; h: number } {
  const label = options.output || outputLabel(options.layout, options.quality);
  const [w, h] = label.split("x").map(Number);
  return { w: w || 720, h: h || 1280 };
}

function videoBitrate(quality: ClipOptions["quality"]): string {
  if (quality === "1080") return "8M";
  if (quality === "360") return "1.5M";
  return "4M";
}

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

function splitStack(outW: number, outH: number, topRatio = 0.4): { outW: number; topH: number; botH: number } {
  const w = even(outW);
  let topH = even(Math.round(outH * topRatio));
  let botH = outH - topH;
  if (botH % 2) {
    topH -= 1;
    botH += 1;
  }
  return { outW: w, topH, botH };
}

function fillSlot(w: number, h: number): string {
  const W = even(w);
  const H = even(h);
  return `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=${W}:${H},setsar=1`;
}

function vstackFilter(topIn: string, botIn: string, W: number, topH: number, botH: number, out = "vout"): string {
  return [
    `${topIn}${fillSlot(W, topH)}[top]`,
    `${botIn}${fillSlot(W, botH)}[bot]`,
    `[top][bot]vstack=inputs=2,format=yuv420p[${out}]`,
  ].join(";");
}

/** Crop a source rect so it matches the output slot aspect and stays centered on the cam. */
function fitRectToAspect(
  rect: { x: number; y: number; w: number; h: number },
  aspect: number,
): { x: number; y: number; w: number; h: number } {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  let w = Math.max(0.08, rect.w * 0.9);
  let h = w / aspect;
  if (h < rect.h * 0.9) {
    h = rect.h * 0.9;
    w = h * aspect;
  }
  if (w > 1) {
    w = 1;
    h = w / aspect;
  }
  if (h > 1) {
    h = 1;
    w = h * aspect;
  }
  let x = cx - w / 2;
  let y = cy - h / 2;
  x = Math.min(Math.max(0, x), 1 - w);
  y = Math.min(Math.max(0, y), 1 - h);
  return { x, y, w, h };
}

function videoEncodeFlags(options: ClipOptions): string[] {
  if (process.platform === "darwin") {
    return ["-c:v", "h264_videotoolbox", "-b:v", videoBitrate(options.quality), "-realtime", "false"];
  }
  return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-b:v", videoBitrate(options.quality)];
}

function encodeArgs(options: ClipOptions, last: string, outPath: string): string[] {
  return [
    "-map",
    last.startsWith("[") ? last : `[${last}]`,
    "-map",
    "0:a?",
    "-threads",
    String(FFMPEG_THREADS),
    "-filter_threads",
    String(FFMPEG_THREADS),
    ...videoEncodeFlags(options),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outPath,
  ];
}

async function runEncode(args: string[]): Promise<void> {
  let { code, stderr } = await runCommand("ffmpeg", args, { timeoutMs: 10 * 60 * 1000 });
  if (code !== 0) {
    const fallback = args.slice();
    const codecAt = fallback.indexOf("h264_videotoolbox");
    if (codecAt >= 0) {
      fallback.splice(codecAt, 1, "libx264", "-preset", "veryfast", "-crf", "23");
      const rt = fallback.indexOf("-realtime");
      if (rt >= 0) fallback.splice(rt, 2);
    }
    const retry = await runCommand("ffmpeg", fallback, { timeoutMs: 10 * 60 * 1000 });
    code = retry.code;
    stderr = retry.stderr;
  }
  if (code !== 0) {
    throw new Error(`compose failed: ${stderr.slice(-600)}`);
  }
}

export async function exportDualClip(
  sourcePath: string,
  highlight: HighlightCandidate,
  crop: CropConfig,
  options: ClipOptions,
  outDir: string,
  clipIndex: number,
  sourcePathB?: string,
): Promise<ClipResult> {
  const { w: outW, h: outH } = outputSize(options);
  const id = `clip-${String(clipIndex + 1).padStart(2, "0")}-${Math.round(highlight.startSec)}s`;
  const filename = `${id}.mp4`;
  const outPath = path.join(outDir, filename);
  const duration = Math.max(0.5, highlight.endSec - highlight.startSec);

  if (options.layout === "pair") {
    if (!sourcePathB) throw new Error("Falta el segundo vídeo para el stack");
    const topPath = options.pairOrder === "b-top" ? sourcePathB : sourcePath;
    const botPath = options.pairOrder === "b-top" ? sourcePath : sourcePathB;
    const topIsA = options.pairOrder !== "b-top";
    const useTopA = topIsA ? options.pairAudioA : options.pairAudioB;
    const useBotA = topIsA ? options.pairAudioB : options.pairAudioA;
    const stack = splitStack(outW, outH);
    const W = stack.outW;
    const filterParts = [
      vstackFilter("[0:v]", "[1:v]", W, stack.topH, stack.botH),
    ];
    const maps = ["-map", "[vout]"];
    if (useTopA && useBotA) {
      filterParts.push(`[0:a][1:a]amix=inputs=2:duration=shortest:dropout_transition=0[aout]`);
      maps.push("-map", "[aout]", "-c:a", "aac", "-b:a", "160k");
    } else if (useTopA) {
      maps.push("-map", "0:a?", "-c:a", "aac", "-b:a", "160k");
    } else if (useBotA) {
      maps.push("-map", "1:a?", "-c:a", "aac", "-b:a", "160k");
    } else {
      maps.push("-an");
    }
    const args = [
      "-y",
      "-ss",
      highlight.startSec.toFixed(2),
      "-i",
      topPath,
      "-ss",
      highlight.startSec.toFixed(2),
      "-i",
      botPath,
      "-t",
      duration.toFixed(2),
      "-filter_complex",
      filterParts.join(";"),
      ...maps,
      "-threads",
      String(FFMPEG_THREADS),
      ...videoEncodeFlags(options),
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outPath,
    ];
    await runEncode(args);
    return {
      id,
      startSec: highlight.startSec,
      endSec: highlight.endSec,
      durationSec: Number(duration.toFixed(2)),
      score: highlight.score,
      reasons: highlight.reasons,
      filename,
      path: outPath,
      url: "",
    };
  }

  let filter: string;
  let last = "vout";
  if (options.layout === "full") {
    filter = `[0:v]scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[${last}]`;
  } else {
    const stack = splitStack(outW, outH);
    const W = stack.outW;
    const cam = fitRectToAspect(resolveWebcamCrop(crop), W / stack.topH);
    const game = clampRect(crop.gameplay);
    const camPrefix = `[0:v]crop=iw*${cam.w}:ih*${cam.h}:iw*${cam.x}:ih*${cam.y},`;
    const gamePrefix =
      game.w > 0.94 && game.h > 0.94
        ? "[0:v]"
        : `[0:v]crop=iw*${game.w}:ih*${game.h}:iw*${game.x}:ih*${game.y},`;
    filter = vstackFilter(camPrefix, gamePrefix, W, stack.topH, stack.botH, last);
  }

  const args = [
    "-y",
    "-ss",
    highlight.startSec.toFixed(2),
    "-i",
    sourcePath,
    "-t",
    duration.toFixed(2),
    "-filter_complex",
    filter,
    ...encodeArgs(options, `[${last}]`, outPath),
  ];

  try {
    await runEncode(args);
  } catch (err) {
    throw new Error(`compose failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    id,
    startSec: highlight.startSec,
    endSec: highlight.endSec,
    durationSec: Number(duration.toFixed(2)),
    score: highlight.score,
    reasons: highlight.reasons,
    filename,
    path: outPath,
    url: "",
  };
}

export async function exportAllClips(
  sourcePath: string,
  highlights: HighlightCandidate[],
  crop: CropConfig,
  options: ClipOptions,
  outDir: string,
  onProgress?: (msg: string) => void,
  sourcePathB?: string,
): Promise<ClipResult[]> {
  const results: ClipResult[] = new Array(highlights.length);
  let next = 0;
  const workers = Math.min(options.quality === "1080" ? 2 : 3, highlights.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const i = next++;
        if (i >= highlights.length) return;
        onProgress?.(`Exportando clip ${i + 1}/${highlights.length} (${options.quality}p)…`);
        results[i] = await exportDualClip(
          sourcePath,
          highlights[i]!,
          crop,
          options,
          outDir,
          i,
          sourcePathB,
        );
      }
    }),
  );
  return results;
}
