import { promises as fs } from "node:fs";
import path from "node:path";
import { FFMPEG_THREADS, runCommand } from "./ffmpeg.js";
import type { ClipOptions, HighlightCandidate } from "../types.js";

interface AudioSample {
  t: number;
  rms: number;
}

interface SceneHit {
  t: number;
  score: number;
}

/**
 * MVP highlight heuristic:
 * 1) Sample audio RMS energy via ffmpeg astats / volumedetect-style lavfi.
 * 2) Detect scene changes via ffmpeg select=gt(scene,N).
 * 3) Rank peaks, merge nearby ones, pad into 15–45s windows, return top N.
 */
export async function detectHighlights(
  sourcePath: string,
  durationSec: number,
  hasAudio: boolean,
  options: ClipOptions,
  workDir: string,
): Promise<HighlightCandidate[]> {
  await fs.mkdir(workDir, { recursive: true });

  const target = Math.min(options.clipDurationSec, durationSec);
  const want = Math.max(1, Math.round(options.maxClips));

  if (options.clipPickMode === "split") {
    const selected = packClips(durationSec, target, want, []);
    selected.sort((a, b) => a.startSec - b.startSec);
    return selected.map((s) => ({
      ...s,
      score: 0,
      reasons: ["split"],
    }));
  }

  const skipScenes = options.liveLastMinutes > 0;
  const [audioPeaks, sceneHits] = await Promise.all([
    hasAudio ? extractAudioPeaks(sourcePath, workDir) : Promise.resolve([] as AudioSample[]),
    skipScenes
      ? Promise.resolve([] as SceneHit[])
      : extractSceneChanges(sourcePath, options.sceneThreshold, workDir),
  ]);

  const peakMap = new Map<number, { score: number; reasons: string[] }>();

  // Bucket audio into ~1s bins and find high-energy moments.
  if (audioPeaks.length > 0) {
    const values = audioPeaks.map((s) => s.rms).sort((a, b) => a - b);
    const idx = Math.min(
      values.length - 1,
      Math.floor((options.audioPeakPercentile / 100) * (values.length - 1)),
    );
    const threshold = values[idx] ?? values[values.length - 1] ?? 0;

    for (const sample of audioPeaks) {
      if (sample.rms < threshold) continue;
      const bucket = Math.round(sample.t);
      const existing = peakMap.get(bucket) ?? { score: 0, reasons: [] };
      const boost = 1 + (sample.rms - threshold) / Math.max(threshold, 1e-6);
      existing.score += boost;
      if (!existing.reasons.includes("audio-energy")) existing.reasons.push("audio-energy");
      peakMap.set(bucket, existing);
    }
  }

  // Scene-change density: reward clusters of cuts (action / camera switches).
  for (const hit of sceneHits) {
    const bucket = Math.round(hit.t);
    for (const offset of [-1, 0, 1]) {
      const key = bucket + offset;
      if (key < 0 || key > durationSec) continue;
      const existing = peakMap.get(key) ?? { score: 0, reasons: [] };
      existing.score += 0.6 * (1 + hit.score);
      if (!existing.reasons.includes("scene-change")) existing.reasons.push("scene-change");
      peakMap.set(key, existing);
    }
  }

  const raw = [...peakMap.entries()]
    .map(([t, v]) => ({ t, ...v }))
    .sort((a, b) => b.score - a.score);

  const selected = packBestMoments(durationSec, target, want, raw);
  selected.sort((a, b) => a.startSec - b.startSec);
  return selected;
}

type Peak = { t: number; score: number; reasons: string[] };

function bestPeakIn(raw: Peak[], from: number, to: number): Peak | undefined {
  let best: Peak | undefined;
  for (const peak of raw) {
    if (peak.t < from || peak.t > to) continue;
    if (!best || peak.score > best.score) best = peak;
  }
  return best;
}

function rangesOverlap(
  a: { startSec: number; endSec: number },
  b: { startSec: number; endSec: number },
): boolean {
  return a.startSec < b.endSec - 0.05 && b.startSec < a.endSec - 0.05;
}

/** Top-scoring windows on the full video; no overlap unless the source is too short. */
function packBestMoments(
  durationSec: number,
  target: number,
  want: number,
  raw: Peak[],
): HighlightCandidate[] {
  const clipLen = Math.min(target, durationSec);
  if (clipLen <= 0) return [];

  const candidates = raw
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((p) => windowAround(p.t, durationSec, clipLen, p.score, p.reasons));

  const picked: HighlightCandidate[] = [];
  for (const c of candidates) {
    if (picked.length >= want) break;
    if (picked.some((p) => rangesOverlap(p, c))) continue;
    picked.push(c);
  }

  fillUnusedGaps(picked, want, clipLen, durationSec, raw);

  if (picked.length < want) {
    for (const c of candidates) {
      if (picked.length >= want) break;
      if (picked.some((p) => Math.abs(p.startSec - c.startSec) < 0.5)) continue;
      picked.push(c);
    }
  }

  if (picked.length < want) {
    const extra = packWithOverlap(durationSec, clipLen, want, raw);
    for (const e of extra) {
      if (picked.length >= want) break;
      if (picked.some((p) => Math.abs(p.startSec - e.startSec) < 0.5)) continue;
      picked.push(e);
    }
  }

  return picked;
}

function fillUnusedGaps(
  picked: HighlightCandidate[],
  want: number,
  clipLen: number,
  durationSec: number,
  raw: Peak[],
): void {
  while (picked.length < want) {
    const sorted = [...picked].sort((a, b) => a.startSec - b.startSec);
    const gaps: { from: number; to: number }[] = [];
    let cursor = 0;
    for (const p of sorted) {
      if (p.startSec > cursor + 0.05) gaps.push({ from: cursor, to: p.startSec });
      cursor = Math.max(cursor, p.endSec);
    }
    if (cursor < durationSec - 0.05) gaps.push({ from: cursor, to: durationSec });
    const room = gaps.filter((g) => g.to - g.from >= clipLen - 0.05);
    if (!room.length) return;

    let gap = room.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
    let peak: Peak | undefined;
    for (const g of room) {
      const hit = bestPeakIn(raw, g.from, g.to);
      if (hit && (!peak || hit.score > peak.score)) {
        peak = hit;
        gap = g;
      }
    }

    let start = peak ? peak.t - clipLen * 0.3 : gap.from;
    if (start < gap.from) start = gap.from;
    if (start + clipLen > gap.to) start = gap.to - clipLen;

    picked.push({
      peakSec: Number((peak?.t ?? start + clipLen * 0.3).toFixed(2)),
      startSec: Number(start.toFixed(2)),
      endSec: Number((start + clipLen).toFixed(2)),
      score: Number((peak?.score ?? 0.1).toFixed(3)),
      reasons: peak?.reasons ?? ["even-spacing-fallback"],
    });
  }
}

/** Prefer non-overlapping windows when the source is long enough for maxClips × duration. */
function packClips(
  durationSec: number,
  target: number,
  want: number,
  raw: Peak[],
): HighlightCandidate[] {
  const clipLen = Math.min(target, durationSec);
  if (clipLen <= 0) return [];
  const fits = want * clipLen <= durationSec + 0.05;
  if (fits) return packWithoutOverlap(durationSec, clipLen, want, raw);
  return packWithOverlap(durationSec, clipLen, want, raw);
}

function packWithoutOverlap(
  durationSec: number,
  clipLen: number,
  want: number,
  raw: Peak[],
): HighlightCandidate[] {
  const slack = Math.max(0, durationSec - want * clipLen);
  const gap = want <= 1 ? 0 : slack / (want - 1);
  const out: HighlightCandidate[] = [];
  for (let i = 0; i < want; i++) {
    const start = i * (clipLen + gap);
    const end = Math.min(durationSec, start + clipLen);
    const peak = bestPeakIn(raw, start, end);
    out.push({
      peakSec: Number((peak?.t ?? start + clipLen * 0.3).toFixed(2)),
      startSec: Number(start.toFixed(2)),
      endSec: Number(end.toFixed(2)),
      score: Number((peak?.score ?? 0.1).toFixed(3)),
      reasons: peak?.reasons ?? ["even-spacing-fallback"],
    });
  }
  return out;
}

function packWithOverlap(
  durationSec: number,
  clipLen: number,
  want: number,
  raw: Peak[],
): HighlightCandidate[] {
  const span = Math.max(0, durationSec - clipLen);
  const step = want <= 1 ? 0 : span / (want - 1);
  const out: HighlightCandidate[] = [];
  for (let i = 0; i < want; i++) {
    const slot0 = step * i;
    const slot1 = slot0 + clipLen;
    const peak = bestPeakIn(raw, slot0 - 1, slot1 + 1);
    if (peak) {
      out.push(windowAround(peak.t, durationSec, clipLen, peak.score, peak.reasons));
    } else {
      out.push(
        windowAround(slot0 + clipLen * 0.3, durationSec, clipLen, 0.1, ["even-spacing-fallback"]),
      );
    }
  }
  return out;
}

function windowAround(
  peakSec: number,
  durationSec: number,
  target: number,
  score: number,
  reasons: string[],
): HighlightCandidate {
  const len = Math.min(target, durationSec);
  let start = peakSec - len * 0.3;
  if (start < 0) start = 0;
  if (start + len > durationSec) start = Math.max(0, durationSec - len);
  const end = Math.min(durationSec, start + len);

  return {
    peakSec: Number(peakSec.toFixed(2)),
    startSec: Number(start.toFixed(2)),
    endSec: Number(end.toFixed(2)),
    score: Number(score.toFixed(3)),
    reasons,
  };
}

async function extractAudioPeaks(sourcePath: string, workDir: string): Promise<AudioSample[]> {
  // Decode mono PCM at 8kHz, then compute per-window RMS in Node (portable, no fancy filters).
  const pcmPath = path.join(workDir, "audio.pcm");
  const sampleRate = 8000;
  const { code, stderr } = await runCommand(
    "ffmpeg",
    [
      "-y",
      "-i",
      sourcePath,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-threads",
      String(FFMPEG_THREADS),
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "s16le",
      pcmPath,
    ],
    { timeoutMs: 10 * 60 * 1000 },
  );
  if (code !== 0) {
    throw new Error(`audio extract failed: ${stderr.slice(-400)}`);
  }

  const buf = await fs.readFile(pcmPath);
  const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  const windowSec = 0.25;
  const windowSize = Math.floor(sampleRate * windowSec);
  const out: AudioSample[] = [];

  for (let i = 0; i + windowSize <= samples.length; i += windowSize) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      const v = samples[i + j]! / 32768;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / windowSize);
    out.push({ t: i / sampleRate, rms });
  }

  // Clean up large PCM.
  await fs.unlink(pcmPath).catch(() => undefined);
  return out;
}

async function extractSceneChanges(
  sourcePath: string,
  threshold: number,
  workDir: string,
): Promise<SceneHit[]> {
  // Use showinfo on scene-selected frames; parse pts_time from stderr.
  // Downscale + lower fps to keep MVP fast on long VODs.
  const { stderr, code } = await runCommand(
    "ffmpeg",
    [
      "-y",
      "-i",
      sourcePath,
      "-threads",
      String(FFMPEG_THREADS),
      "-vf",
      `fps=1,scale=160:-1,select='gt(scene\\,${threshold})',showinfo`,
      "-an",
      "-f",
      "null",
      "-",
    ],
    { timeoutMs: 15 * 60 * 1000 },
  );

  // ffmpeg null mux often exits 0 even with filters; still parse stderr.
  if (code !== 0 && !stderr.includes("showinfo")) {
    // Soft-fail: scene detection is optional if it blows up.
    console.warn("scene detection soft-failed:", stderr.slice(-300));
    return [];
  }

  const hits: SceneHit[] = [];
  const re = /pts_time:([\d.]+).*?n:\s*(\d+)/g;
  // showinfo lines look like: [Parsed_showinfo_2 @ ...] n:   0 pts: ... pts_time:12.5 ...
  const re2 = /pts_time:([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re2.exec(stderr)) !== null) {
    const t = Number(m[1]);
    if (!Number.isFinite(t)) continue;
    hits.push({ t, score: 1 });
  }

  // Deduplicate near-identical timestamps.
  hits.sort((a, b) => a.t - b.t);
  const deduped: SceneHit[] = [];
  for (const h of hits) {
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(last.t - h.t) < 0.4) {
      last.score += 0.2;
      continue;
    }
    deduped.push({ ...h });
  }

  // Write debug artifact for inspection.
  await fs.writeFile(
    path.join(workDir, "scenes.json"),
    JSON.stringify(deduped, null, 2),
  ).catch(() => undefined);

  return deduped;
}
