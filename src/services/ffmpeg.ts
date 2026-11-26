import { spawn, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolAbort } from "./cancel.js";

export const jobContext = new AsyncLocalStorage<string>();
const jobProcs = new Map<string, Set<ChildProcess>>();

export class CancelledError extends Error {
  constructor(message = "Cancelado") {
    super(message);
    this.name = "CancelledError";
  }
}

function track(jobId: string, child: ChildProcess): void {
  let set = jobProcs.get(jobId);
  if (!set) {
    set = new Set();
    jobProcs.set(jobId, set);
  }
  set.add(child);
  const drop = () => set!.delete(child);
  child.on("close", drop);
  child.on("error", drop);
}

export function killJobProcesses(jobId: string): void {
  const set = jobProcs.get(jobId);
  if (!set) return;
  for (const child of set) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  set.clear();
}

export interface ProbeInfo {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
  fps: number;
  codec: string;
  bitrate: number;
}

const cpuCount = os.cpus()?.length || 4;
/** Use most cores; leave a couple free so the UI/yt-dlp stay responsive. */
export const FFMPEG_THREADS = Math.max(
  2,
  Math.min(8, Number(process.env.FFMPEG_THREADS) || Math.max(2, cpuCount - 2)),
);

const MAX_LOG = 400_000;

function appendCapped(prev: string, chunk: string): string {
  const next = prev + chunk;
  return next.length > MAX_LOG ? next.slice(-MAX_LOG) : next;
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs?: number;
    onChunk?: (text: string) => void;
  } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const jobId = jobContext.getStore();
    const stop = toolAbort.getStore();
    if (stop?.aborted) {
      reject(new Error("Detenido"));
      return;
    }
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: Boolean(jobId),
    });
    if (jobId) track(jobId, child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer =
      opts.timeoutMs != null
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            kill();
            reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
          }, opts.timeoutMs)
        : null;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      kill();
      reject(new Error("Detenido"));
    };
    stop?.addEventListener("abort", onAbort, { once: true });

    const take = (d: Buffer) => {
      const text = d.toString();
      opts.onChunk?.(text);
      return text;
    };
    child.stdout.on("data", (d) => {
      stdout = appendCapped(stdout, take(d));
    });
    child.stderr.on("data", (d) => {
      stderr = appendCapped(stderr, take(d));
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stop?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stop?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

export async function probeVideo(filePath: string): Promise<ProbeInfo> {
  const { stdout, code, stderr } = await runCommand("ffprobe", [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  if (code !== 0) {
    throw new Error(`ffprobe failed: ${stderr.slice(-500)}`);
  }
  const data = JSON.parse(stdout) as {
    format?: { duration?: string; bit_rate?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      bit_rate?: string;
    }>;
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  const hasAudio = Boolean(data.streams?.some((s) => s.codec_type === "audio"));
  const durationSec = Number(data.format?.duration ?? 0);
  if (!video?.width || !video?.height || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("No se pudieron leer las dimensiones/duración del vídeo");
  }
  const [num, den] = (video.avg_frame_rate || "0/1").split("/").map(Number);
  const fps = den ? num / den : num || 0;
  return {
    durationSec,
    width: video.width,
    height: video.height,
    hasAudio,
    fps: Number.isFinite(fps) ? Math.round(fps * 100) / 100 : 0,
    codec: video.codec_name || "",
    bitrate: Number(video.bit_rate || data.format?.bit_rate || 0),
  };
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Remux so later -ss seeks don't decode from the start of the VOD. */
export async function makeSeekable(filePath: string): Promise<string> {
  if (!/\.(mp4|m4v|mov)$/i.test(filePath)) return filePath;
  const stamp = `${filePath}.faststart`;
  try {
    const st = await fs.stat(filePath);
    const marked = await fs.stat(stamp);
    if (st.size > 10_000 && marked.mtimeMs >= st.mtimeMs - 2000) return filePath;
  } catch {
    // index on first use
  }
  const tmp = `${filePath}.seek${path.extname(filePath) || ".mp4"}`;
  const { code } = await runCommand(
    "ffmpeg",
    [
      "-y",
      "-fflags",
      "+genpts",
      "-i",
      filePath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "-avoid_negative_ts",
      "make_zero",
      tmp,
    ],
    { timeoutMs: 180_000 },
  );
  if (code !== 0) {
    await fs.unlink(tmp).catch(() => undefined);
    return filePath;
  }
  try {
    await fs.rename(tmp, filePath);
  } catch {
    await fs.copyFile(tmp, filePath);
    await fs.unlink(tmp).catch(() => undefined);
  }
  await fs.writeFile(stamp, "1").catch(() => undefined);
  return filePath;
}
