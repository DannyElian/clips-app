import path from "node:path";
import { fileURLToPath } from "node:url";
import { FFMPEG_THREADS, runCommand } from "./ffmpeg.js";
import { clampRect, DEFAULT_WEBCAM_PRESETS, type CropRect } from "../types.js";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/detect_webcam.py");

function pythonBin(): string {
  return process.env.PYTHON_BIN || "python3.11";
}

async function grabFrame(sourcePath: string, atSec: number, outPath: string): Promise<boolean> {
  const { code } = await runCommand(
    "ffmpeg",
    [
      "-y",
      "-ss",
      Math.max(0, atSec).toFixed(2),
      "-i",
      sourcePath,
      "-threads",
      String(FFMPEG_THREADS),
      "-an",
      "-frames:v",
      "1",
      "-q:v",
      "5",
      outPath,
    ],
    { timeoutMs: 45_000 },
  );
  return code === 0;
}

export async function detectWebcamRect(
  sourcePath: string,
  durationSec: number,
  workDir: string,
): Promise<{
  rect: CropRect;
  method: "face" | "fallback";
  position?: string;
  focus?: { x: number; y: number };
}> {
  const unique = [Math.min(Math.max(durationSec * 0.22, 0.8), Math.max(1, durationSec - 0.6))];

  const frames = (
    await Promise.all(
      unique.map(async (t, i) => {
        const out = path.join(workDir, `face-${i}.jpg`);
        return (await grabFrame(sourcePath, t, out)) ? out : null;
      }),
    )
  ).filter((p): p is string => Boolean(p));

  if (frames.length) {
    try {
      const { stdout, code } = await runCommand(pythonBin(), [SCRIPT, ...frames], {
        timeoutMs: 60_000,
      });
      if (code === 0 && stdout.trim()) {
        const parsed = JSON.parse(stdout.trim().split("\n").at(-1) || "{}") as {
          ok?: boolean;
          webcam?: CropRect & { focus?: { x: number; y: number } };
          position?: string;
        };
        if (parsed.ok && parsed.webcam) {
          const { focus, ...box } = parsed.webcam;
          return {
            rect: clampRect(box),
            method: "face",
            position: parsed.position,
            focus,
          };
        }
      }
    } catch {
      // fall through
    }
  }

  return { rect: clampRect(DEFAULT_WEBCAM_PRESETS["bottom-right"]), method: "fallback" };
}
