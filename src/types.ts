/** Normalized crop rect as fractions of source width/height (0–1). */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type WebcamPreset =
  | "auto"
  | "bottom-left"
  | "top-left"
  | "bottom-right"
  | "top-right"
  | "custom";

export interface CropConfig {
  webcamPreset: WebcamPreset;
  webcam: CropRect;
  gameplay: CropRect;
  /** Face position inside the webcam crop (0–1). Used to keep the head centered when scaling. */
  webcamFocus?: { x: number; y: number };
}

export type ClipLayout = "dual" | "full" | "pair";
export type ClipQuality = "360" | "720" | "1080" | "1440" | "2160";
/** split = cortar el vídeo en N trozos. highlights = mejores momentos. full = el vídeo entero, con las mismas opciones. */
export type ClipPickMode = "split" | "highlights" | "full";

export interface ClipOptions {
  /** Dual = cam arriba / juego abajo. Full = fotograma completo sin dividir. */
  layout: ClipLayout;
  /** Target download + export quality. */
  quality: ClipQuality;
  /** Target output resolution (derived from layout + quality). */
  /** WxH actually exported. Never larger than the source. */
  output: string;
  /** Desired clip duration in seconds (padded around peaks). */
  clipDurationSec: number;
  /** Min/max bounds for auto duration. */
  minClipSec: number;
  maxClipSec: number;
  /** How many clips to produce. */
  maxClips: number;
  /** split = timeline slices. highlights = best moments. full = one export of the whole source. */
  clipPickMode: ClipPickMode;
  /** Seconds of padding before peak. */
  padBeforeSec: number;
  /** Seconds of padding after peak. */
  padAfterSec: number;
  /** Audio energy percentile threshold (0–100). Higher = fewer peaks. */
  audioPeakPercentile: number;
  /** Scene-change score threshold for ffmpeg scdet (0–1-ish). */
  sceneThreshold: number;
  /** 0 = VOD completo. >0 = últimos N minutos (directo / DVR). */
  liveLastMinutes: number;
  /** Browser whose YouTube cookies yt-dlp should use, or auto/none. */
  cookiesBrowser: "auto" | "chrome" | "safari" | "firefox" | "brave" | "edge" | "none";
  /** Two-file stack: a-top = vídeo 1 arriba. */
  pairOrder: "a-top" | "b-top";
  /** Which of the two files to scan for highlights. */
  pairHighlight: "a" | "b";
  /** Include audio from vídeo 1 / vídeo 2 in the stacked clip. */
  pairAudioA: boolean;
  pairAudioB: boolean;
  /** Burn the phrase on the video. The copy below the clip is always available. */
  burnOverlay: boolean;
  /** Burn timed subtitles on the exported clip. */
  burnSubs: boolean;
  /** frase, barra, or palabra. Used when burnSubs is on. */
  subLook: "frase" | "barra" | "palabra";
  subColor: string;
  subSize: "chico" | "normal" | "grande";
  subPosition: "top" | "middle" | "bottom";
}

export interface HighlightCandidate {
  /** Peak timestamp in source seconds. */
  peakSec: number;
  /** Start of clip window. */
  startSec: number;
  /** End of clip window. */
  endSec: number;
  /** Combined score (higher = better). */
  score: number;
  /** Why this was picked. */
  reasons: string[];
}

export interface ClipResult {
  id: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  score: number;
  reasons: string[];
  filename: string;
  path: string;
  url: string;
  /** Short hook for the card header. */
  title?: string;
  /** Full TikTok/Reels copy, ready to paste. */
  caption?: string;
  /** Phrase to put on the video (CapCut / TikTok text). */
  overlay?: string;
  /** Detected vibe used for overlay + copy. */
  mood?: string;
}

export type JobStatus =
  | "queued"
  | "downloading"
  | "analyzing"
  | "exporting"
  | "done"
  | "error"
  | "cancelled";

export interface Job {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  sourceFilename: string;
  sourcePath: string;
  sourceUrl?: string;
  sourcePathB?: string;
  sourceFilenameB?: string;
  sourceUrlB?: string;
  sourceDurationSec?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  crop: CropConfig;
  options: ClipOptions;
  progress: string;
  highlights?: HighlightCandidate[];
  clips?: ClipResult[];
  error?: string;
  /** Set when the requested resolution is higher than the source. */
  qualityNote?: string;
}

export const DEFAULT_WEBCAM_PRESETS: Record<Exclude<WebcamPreset, "custom" | "auto">, CropRect> = {
  // Typical Twitch overlay cam in the lower-left corner.
  "bottom-left": { x: 0.01, y: 0.66, w: 0.26, h: 0.33 },
  // Cam docked top-left (common for some layouts / FaceIT-style).
  "top-left": { x: 0.01, y: 0.015, w: 0.26, h: 0.33 },
  // Cam bottom-right.
  "bottom-right": { x: 0.73, y: 0.66, w: 0.26, h: 0.33 },
  // Cam top-right.
  "top-right": { x: 0.73, y: 0.015, w: 0.26, h: 0.33 },
};

/** Full-frame gameplay crop (MVP: use whole frame; refine later). */
export const DEFAULT_GAMEPLAY_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };

const LANDSCAPE: Record<ClipQuality, string> = {
  "360": "640x360",
  "720": "1280x720",
  "1080": "1920x1080",
  "1440": "2560x1440",
  "2160": "3840x2160",
};
const VERTICAL: Record<ClipQuality, string> = {
  "360": "360x640",
  "720": "720x1280",
  "1080": "1080x1920",
  "1440": "1440x2560",
  "2160": "2160x3840",
};

export function outputLabel(layout: ClipLayout, quality: ClipQuality): string {
  return layout === "full" ? LANDSCAPE[quality] : VERTICAL[quality];
}

function evenSize(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/** Do not invent pixels the source does not have. */
export function capExportSize(
  label: string,
  sourceW: number,
  sourceH: number,
): { output: string; note?: string } {
  const [w, h] = label.split("x").map(Number);
  if (!w || !h) return { output: label };
  const sourceLong = Math.max(sourceW, sourceH);
  const wantLong = Math.max(w, h);
  if (sourceLong + 8 >= wantLong) return { output: label };
  const scale = sourceLong / wantLong;
  const nw = evenSize(w * scale);
  const nh = evenSize(h * scale);
  const output = `${nw}x${nh}`;
  return {
    output,
    note: `Origen ${sourceW}×${sourceH}. Pediste ${w}×${h}. Se exporta en ${output}, sin inventar detalle de una resolución mayor.`,
  };
}

export const DEFAULT_CLIP_OPTIONS: ClipOptions = {
  layout: "dual",
  quality: "720",
  output: "720x1280",
  clipDurationSec: 30,
  minClipSec: 30,
  maxClipSec: 30,
  maxClips: 12,
  clipPickMode: "highlights",
  padBeforeSec: 9,
  padAfterSec: 21,
  audioPeakPercentile: 88,
  sceneThreshold: 0.35,
  liveLastMinutes: 0,
  cookiesBrowser: "none",
  pairOrder: "a-top",
  pairHighlight: "b",
  pairAudioA: true,
  pairAudioB: false,
  burnOverlay: true,
  burnSubs: false,
  subLook: "frase",
  subColor: "#ffffff",
  subSize: "normal",
  subPosition: "bottom",
};

export function resolveWebcamCrop(config: CropConfig): CropRect {
  if (config.webcamPreset === "custom" || config.webcamPreset === "auto") {
    return clampRect(config.webcam);
  }
  return clampRect(DEFAULT_WEBCAM_PRESETS[config.webcamPreset]);
}

export function clampRect(r: CropRect): CropRect {
  const x = Math.min(Math.max(r.x, 0), 0.98);
  const y = Math.min(Math.max(r.y, 0), 0.98);
  const w = Math.min(Math.max(r.w, 0.02), 1 - x);
  const h = Math.min(Math.max(r.h, 0.02), 1 - y);
  return { x, y, w, h };
}
