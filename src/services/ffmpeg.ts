import { spawn, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import os from "node:os";

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
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: Boolean(jobId),
    });
    if (jobId) track(jobId, child);
    let stdout = "";
    let stderr = "";
    const timer =
      opts.timeoutMs != null
        ? setTimeout(() => {
            try {
              if (child.pid) process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
            reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
          }, opts.timeoutMs)
        : null;

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
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
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
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
    }>;
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  const hasAudio = Boolean(data.streams?.some((s) => s.codec_type === "audio"));
  const durationSec = Number(data.format?.duration ?? 0);
  if (!video?.width || !video?.height || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("No se pudieron leer las dimensiones/duración del vídeo");
  }
  return {
    durationSec,
    width: video.width,
    height: video.height,
    hasAudio,
  };
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}
