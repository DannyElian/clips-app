import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { FFMPEG_THREADS, runCommand } from "./ffmpeg.js";
import { resolveFont } from "./captions.js";
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

function videoBitrate(quality: ClipOptions["quality"]): { b: string; max: string; buf: string } {
  if (quality === "1080") return { b: "20M", max: "24M", buf: "40M" };
  if (quality === "360") return { b: "3.5M", max: "4.5M", buf: "8M" };
  return { b: "10M", max: "12M", buf: "20M" };
}

const SCALE_HQ = "lanczos";

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

function fillSlot(
  w: number,
  h: number,
  flags = SCALE_HQ,
  focus?: { x: number; y: number },
  sharpen = false,
): string {
  const W = even(w);
  const H = even(h);
  const fx = Math.min(0.9, Math.max(0.1, focus?.x ?? 0.5));
  const fy = Math.min(0.9, Math.max(0.1, focus?.y ?? 0.5));
  const cx = focus ? `max(0\\,min(in_w-${W}\\,in_w*${fx}-${W}/2))` : `(in_w-${W})/2`;
  const cy = focus ? `max(0\\,min(in_h-${H}\\,in_h*${fy}-${H}/2))` : `(in_h-${H})/2`;
  const sharp = sharpen ? ",unsharp=5:5:0.55:5:5:0.0" : "";
  return `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=${flags},crop=${W}:${H}:${cx}:${cy}${sharp},setsar=1`;
}

const ENCODE_THREADS = process.platform === "darwin" ? 2 : Math.min(4, FFMPEG_THREADS);

function seekInput(filePath: string, startSec: number, durationSec: number): string[] {
  return [
    "-fflags",
    "+fastseek+discardcorrupt",
    "-analyzeduration",
    "1000000",
    "-probesize",
    "1000000",
    "-ss",
    startSec.toFixed(2),
    "-t",
    durationSec.toFixed(2),
    "-i",
    filePath,
  ];
}

function vstackFilter(topIn: string, botIn: string, W: number, topH: number, botH: number, out = "vout"): string {
  return [
    `${topIn}${fillSlot(W, topH)}[top]`,
    `${botIn}${fillSlot(W, botH)}[bot]`,
    `[top][bot]vstack=inputs=2,fps=30,format=yuv420p[${out}]`,
  ].join(";");
}

/** Keep the PIP as large as possible (more pixels). Shift to stay on-frame; never shrink around the face. */
function fitRectToAspect(
  rect: { x: number; y: number; w: number; h: number },
  aspect: number,
): { x: number; y: number; w: number; h: number } {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  let w = Math.max(0.2, Math.min(0.34, rect.w));
  let h = w / aspect;
  if (h < rect.h) {
    h = Math.min(0.38, rect.h);
    w = h * aspect;
  }
  w = Math.min(w, 0.34);
  h = w / aspect;
  let x = cx - w / 2;
  let y = cy - h / 2;
  x = Math.min(Math.max(0, x), 1 - w);
  y = Math.min(Math.max(0, y), 1 - h);
  return { x, y, w, h };
}

function x264Flags(quality: ClipOptions["quality"]): string[] {
  const crf = quality === "1080" ? "16" : quality === "360" ? "22" : "18";
  return ["-c:v", "libx264", "-preset", "fast", "-crf", crf, "-profile:v", "high"];
}

function videoEncodeFlags(options: ClipOptions): string[] {
  if (process.platform === "darwin") {
    const br = videoBitrate(options.quality);
    return [
      "-c:v",
      "h264_videotoolbox",
      "-b:v",
      br.b,
      "-maxrate",
      br.max,
      "-bufsize",
      br.buf,
      "-profile:v",
      "high",
      "-realtime",
      "false",
    ];
  }
  return x264Flags(options.quality);
}

const STAMP = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/stamp_text.py");

function appendWatermark(
  filter: string,
  last: string,
  overlayInput: number | undefined,
): { filter: string; last: string } {
  if (overlayInput == null) return { filter, last };
  const inL = last.replace(/[[\]]/g, "");
  return {
    filter: `${filter};[${inL}][${overlayInput}:v]overlay=(main_w-overlay_w)/2:main_h*0.045:format=auto[wm]`,
    last: "wm",
  };
}

async function writeOverlayPng(
  outDir: string,
  id: string,
  overlay: string | undefined,
  width: number,
  fontFile: string,
): Promise<string | undefined> {
  const text = (overlay || "").trim();
  if (!text) return undefined;
  const txt = path.join(outDir, `${id}-overlay.txt`);
  const png = path.join(outDir, `${id}-overlay.png`);
  await fs.writeFile(txt, text, "utf8");
  const py = process.env.PYTHON_BIN || "python3.11";
  const { code, stderr } = await runCommand(py, [STAMP, png, fontFile, String(width), txt], {
    timeoutMs: 20_000,
  });
  if (code !== 0) {
    throw new Error(`No se pudo pintar la frase: ${stderr.slice(-400)}`);
  }
  return png;
}

function encodeArgs(options: ClipOptions, last: string, outPath: string): string[] {
  return [
    "-map",
    last.startsWith("[") ? last : `[${last}]`,
    "-map",
    "0:a?",
    "-threads",
    String(ENCODE_THREADS),
    "-filter_threads",
    String(ENCODE_THREADS),
    ...videoEncodeFlags(options),
    "-pix_fmt",
    "yuv420p",
    "-sws_flags",
    SCALE_HQ,
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-c:a",
    "aac",
    "-b:a",
    options.quality === "1080" ? "256k" : "192k",
    "-movflags",
    "+faststart",
    outPath,
  ];
}

function stripFlag(args: string[], name: string): void {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 2);
}

function encodeTimeoutMs(durationSec: number): number {
  return Math.round(Math.min(6 * 60 * 60, Math.max(50, durationSec * 4))) * 1000;
}

function toSoftwareEncode(args: string[], quality: ClipOptions["quality"]): string[] {
  const fallback = args.slice();
  stripFlag(fallback, "-hwaccel");
  const codecAt = fallback.indexOf("h264_videotoolbox");
  if (codecAt >= 0) {
    fallback.splice(codecAt, 1, ...x264Flags(quality));
    for (const drop of ["-realtime", "-maxrate", "-bufsize", "-prio_speed"]) {
      stripFlag(fallback, drop);
    }
    stripFlag(fallback, "-b:v");
  }
  return fallback;
}

async function runEncode(args: string[], quality: ClipOptions["quality"], durationSec: number): Promise<void> {
  const timeoutMs = encodeTimeoutMs(durationSec);
  let code = 1;
  let stderr = "";
  try {
    const first = await runCommand("ffmpeg", args, { timeoutMs });
    if (first.code === 0) return;
    code = first.code;
    stderr = first.stderr;
  } catch (err) {
    stderr = err instanceof Error ? err.message : String(err);
  }
  if (code !== 0 && (args.includes("-hwaccel") || args.includes("-prio_speed"))) {
    const simplified = args.slice();
    stripFlag(simplified, "-hwaccel");
    stripFlag(simplified, "-prio_speed");
    try {
      const retryVt = await runCommand("ffmpeg", simplified, { timeoutMs });
      if (retryVt.code === 0) return;
      code = retryVt.code;
      stderr = retryVt.stderr;
    } catch (err) {
      stderr = err instanceof Error ? err.message : String(err);
    }
  }
  try {
    const retry = await runCommand("ffmpeg", toSoftwareEncode(args, quality), { timeoutMs });
    if (retry.code === 0) return;
    code = retry.code;
    stderr = retry.stderr || stderr;
  } catch (err) {
    stderr = err instanceof Error ? err.message : String(err);
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
  overlayText?: string,
  fontFile?: string,
): Promise<ClipResult> {
  const { w: outW, h: outH } = outputSize(options);
  const fullVideo = highlight.reasons.includes("vídeo completo");
  const id = fullVideo
    ? "video-completo"
    : `clip-${String(clipIndex + 1).padStart(2, "0")}-${Math.round(highlight.startSec)}s`;
  const filename = `${id}.mp4`;
  const outPath = path.join(outDir, filename);
  const duration = Math.max(0.5, highlight.endSec - highlight.startSec);
  const font = fontFile || (await resolveFont());
  const overlayPng = await writeOverlayPng(outDir, id, overlayText, outW, font);
  const overlayInput = overlayPng ? (options.layout === "pair" ? 2 : 1) : undefined;
  const overlayArgs = overlayPng ? ["-loop", "1", "-i", overlayPng] : [];

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
      maps.push("-map", "[aout]", "-c:a", "aac", "-b:a", options.quality === "1080" ? "256k" : "192k");
    } else if (useTopA) {
      maps.push("-map", "0:a?", "-c:a", "aac", "-b:a", options.quality === "1080" ? "256k" : "192k");
    } else if (useBotA) {
      maps.push("-map", "1:a?", "-c:a", "aac", "-b:a", options.quality === "1080" ? "256k" : "192k");
    } else {
      maps.push("-an");
    }
    const stamped = appendWatermark(filterParts.join(";"), "vout", overlayInput);
    maps[1] = `[${stamped.last}]`;
    const args = [
      "-y",
      ...seekInput(topPath, highlight.startSec, duration),
      ...seekInput(botPath, highlight.startSec, duration),
      ...overlayArgs,
      "-t",
      duration.toFixed(2),
      "-filter_complex",
      stamped.filter,
      ...maps,
      "-threads",
      String(ENCODE_THREADS),
      ...videoEncodeFlags(options),
      "-pix_fmt",
      "yuv420p",
      "-sws_flags",
      SCALE_HQ,
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-colorspace",
      "bt709",
      "-movflags",
      "+faststart",
      outPath,
    ];
    await runEncode(args, options.quality, duration);
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
    filter = `[0:v]scale=${outW}:${outH}:force_original_aspect_ratio=decrease:flags=${SCALE_HQ},pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30[${last}]`;
  } else {
    const stack = splitStack(outW, outH);
    const W = stack.outW;
    const srcCam = resolveWebcamCrop(crop);
    const cam = fitRectToAspect(srcCam, W / stack.topH);
    const game = clampRect(crop.gameplay);
    const camCrop = `crop=iw*${cam.w}:ih*${cam.h}:iw*${cam.x}:ih*${cam.y}`;
    let focus = crop.webcamFocus ?? { x: 0.5, y: 0.42 };
    const faceX = srcCam.x + focus.x * srcCam.w;
    const faceY = srcCam.y + focus.y * srcCam.h;
    focus = {
      x: Math.min(0.9, Math.max(0.1, (faceX - cam.x) / cam.w)),
      y: Math.min(0.9, Math.max(0.1, (faceY - cam.y) / cam.h)),
    };
    const topScale = fillSlot(W, stack.topH, SCALE_HQ, focus, true);
    const botScale = fillSlot(W, stack.botH, SCALE_HQ);
    const gameCrop =
      game.w > 0.94 && game.h > 0.94
        ? ""
        : `crop=iw*${game.w}:ih*${game.h}:iw*${game.x}:ih*${game.y},`;
    filter = [
      `[0:v]split=2[vc][vg]`,
      `[vc]${camCrop},${topScale}[top]`,
      `[vg]${gameCrop}${botScale}[bot]`,
      `[top][bot]vstack=inputs=2,fps=30,format=yuv420p,setsar=1[${last}]`,
    ].join(";");
  }

  const stamped = appendWatermark(filter, last, overlayInput);
  const args = [
    "-y",
    ...seekInput(sourcePath, highlight.startSec, duration),
    ...overlayArgs,
    "-t",
    duration.toFixed(2),
    "-filter_complex",
    stamped.filter,
    ...encodeArgs(options, `[${stamped.last}]`, outPath),
  ];

  try {
    await runEncode(args, options.quality, duration);
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
  overlays?: string[],
): Promise<ClipResult[]> {
  const fontFile = await resolveFont();
  const results: ClipResult[] = new Array(highlights.length);
  let next = 0;
  const workers = Math.min(process.platform === "darwin" ? 1 : 2, highlights.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const i = next++;
        if (i >= highlights.length) return;
        const fullVideo = highlights[i]?.reasons.includes("vídeo completo");
        onProgress?.(
          fullVideo
            ? `Exportando el vídeo completo (${options.quality}p)…`
            : `Exportando clip ${i + 1}/${highlights.length} (${options.quality}p)…`,
        );
        results[i] = await exportDualClip(
          sourcePath,
          highlights[i]!,
          crop,
          options,
          outDir,
          i,
          sourcePathB,
          overlays?.[i],
          fontFile,
        );
      }
    }),
  );
  return results;
}
