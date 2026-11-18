import path from "node:path";
import { promises as fs } from "node:fs";
import { probeVideo, runCommand } from "./ffmpeg.js";
import { downloadHlsWindow } from "./hlsWindow.js";

const DIRECT_VIDEO = /\.(mp4|mkv|mov|webm|m4v|avi)(\?|#|$)/i;
const YTDLP_CANDIDATES: Array<{ cmd: string; prefix: string[] }> = [
  { cmd: "python3.11", prefix: ["-m", "yt_dlp"] },
  { cmd: path.join(process.env.HOME ?? "", "Library/Python/3.11/bin/yt-dlp"), prefix: [] },
  { cmd: "yt-dlp", prefix: [] },
  { cmd: path.join(process.env.HOME ?? "", ".local/bin/yt-dlp"), prefix: [] },
  { cmd: "python3", prefix: ["-m", "yt_dlp"] },
];

export function parseVideoUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Falta el enlace del vídeo");
  const withProto = /^(https?:\/\/)/i.test(trimmed)
    ? trimmed
    : trimmed.startsWith("www.")
      ? `https://${trimmed}`
      : trimmed;
  let parsed: URL;
  try {
    parsed = new URL(withProto);
  } catch {
    throw new Error("El enlace no es válido");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Solo se aceptan enlaces http o https");
  }
  return parsed.toString();
}

function downloadError(stderr: string, fallback: string): Error {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const errorLine = [...lines].reverse().find((l) => /^ERROR:/i.test(l));
  let text = (errorLine ?? lines.at(-1) ?? fallback).replace(/^ERROR:\s*/i, "");
  if (/cookies database|cookies-from-browser|could not find edge/i.test(text + stderr)) {
    text = canUseBrowserCookies()
      ? "No se encontraron cookies del navegador. Abre YouTube en Chrome e inténtalo de nuevo, o sube el archivo."
      : "En el servidor no hay Chrome/Edge. Sube el vídeo como archivo, o usa un VOD que no pida login. Los directos de YouTube aquí no pueden leer cookies del PC.";
  } else if (/not a bot|Sign in to confirm/i.test(text + stderr) && !canUseBrowserCookies()) {
    text =
      "YouTube bloqueó la descarga en la nube. Sube el archivo, o usa el programa en tu Mac (ahí sí se usan las cookies de Chrome).";
  }
  return new Error(`No se pudo descargar el enlace: ${text}`);
}

let cachedYtdlp: { cmd: string; prefix: string[] } | null = null;

async function resolveYtdlp(): Promise<{ cmd: string; prefix: string[] }> {
  if (cachedYtdlp) return cachedYtdlp;
  for (const candidate of YTDLP_CANDIDATES) {
    try {
      const { code } = await runCommand(candidate.cmd, [...candidate.prefix, "--version"], {
        timeoutMs: 15_000,
      });
      if (code === 0) {
        cachedYtdlp = candidate;
        return candidate;
      }
    } catch {
      // try next
    }
  }
  throw new Error(
    "Para descargar por enlace instala yt-dlp (python3.11 -m pip install --user -U yt-dlp)",
  );
}

function qualityHeight(maxHeight: number): 360 | 720 | 1080 {
  if (maxHeight >= 1080) return 1080;
  if (maxHeight >= 720) return 720;
  return 360;
}

/** Formats capped at the chosen height. Prefer H.264 MP4 (faster download + decode). Never fall back to unrestricted best. */
function vodFormat(height: number): { fmt: string; sort: string } {
  const h = qualityHeight(height);
  const cap = `bv*[height<=${h}][vcodec^=avc]+ba[acodec^=mp4a]/bv*[height<=${h}]+ba/b[height<=${h}]`;
  if (h <= 360) {
    return { fmt: `18/${cap}`, sort: "res:360,codec:h264:vp9,ext:mp4:m4a" };
  }
  if (h <= 720) {
    return {
      fmt: `22/bv*[height<=720][height>=480][vcodec^=avc]+ba[acodec^=mp4a]/${cap}`,
      sort: "res:720,codec:h264:vp9,ext:mp4:m4a",
    };
  }
  return {
    fmt: `bv*[height<=1080][height>=720][vcodec^=avc]+ba[acodec^=mp4a]/${cap}`,
    sort: "res:1080,codec:h264:vp9,ext:mp4:m4a",
  };
}

function ytdlpSpeedArgs(): string[] {
  return [
    "--concurrent-fragments",
    "8",
    "--fragment-retries",
    "8",
    "--retries",
    "3",
    "--no-keep-fragments",
  ];
}

async function runOrTimeout(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; onChunk?: (text: string) => void },
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    return await runCommand(cmd, args, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: "", stderr: message, code: 1 };
  }
}

function recordTimeoutMs(minutes: number): number {
  return (minutes + 8) * 60 * 1000;
}

function cookiesTxtPath(): string {
  return path.join(process.cwd(), "data", "youtube-cookies.txt");
}

/** Browser cookie DBs only exist on a real desktop, not on Render/Docker. */
export function canUseBrowserCookies(): boolean {
  if (process.env.RENDER || process.env.K_SERVICE || process.env.RAILWAY_ENVIRONMENT) return false;
  if (process.platform !== "darwin" && process.platform !== "win32") return false;
  return true;
}

async function cookieAttempts(
  preferred: string,
  opts: { includeNone?: boolean; browsers?: string[] } = {},
): Promise<Array<{ label: string; args: string[] }>> {
  const out: Array<{ label: string; args: string[] }> = [];
  try {
    await fs.access(cookiesTxtPath());
    out.push({ label: "youtube-cookies.txt", args: ["--cookies", cookiesTxtPath()] });
  } catch {
    // optional file
  }
  const useBrowser = canUseBrowserCookies() && preferred !== "none";
  const browsers = !useBrowser
    ? []
    : preferred === "auto"
      ? (opts.browsers ?? ["chrome", "safari", "firefox", "brave", "edge"])
      : [preferred];
  for (const b of browsers) {
    out.push({ label: b, args: ["--cookies-from-browser", b] });
  }
  if (opts.includeNone !== false) {
    out.push({ label: "sin cookies", args: [] });
  }
  return out;
}

function progressFromChunk(chunk: string): string | null {
  const lines = chunk.split(/\r|\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const dl = line.match(/\[download\]\s+(.+)/i);
    if (dl) {
      const body = dl[1];
      if (/destination|extracting|merging/i.test(body)) continue;
      return `Descarga: ${body.slice(0, 140)}`;
    }
    const frag = line.match(/\[hls@|fragment|Total fragments/i);
    if (frag) return line.slice(0, 140);
    const speed = line.match(/(\d+(?:\.\d+)?(?:K|M|G)iB\/s)/);
    const pct = line.match(/(\d+(?:\.\d+)?%)/);
    if (pct && speed) return `Descarga ${pct[1]} · ${speed[1]}`;
    const time = line.match(/time=(\d+:\d+:\d+)/);
    if (time) return `Procesando ${time[1]}`;
  }
  return null;
}

function withProgress(onProgress?: (msg: string) => void) {
  let last = 0;
  return (chunk: string) => {
    if (!onProgress) return;
    const msg = progressFromChunk(chunk);
    if (!msg) return;
    const now = Date.now();
    if (now - last < 900) return;
    last = now;
    onProgress(msg);
  };
}

function startSizeProgress(
  destDir: string,
  fileId: string,
  onProgress?: (msg: string) => void,
): () => void {
  if (!onProgress) return () => {};
  let lastSize = 0;
  let lastAt = Date.now();
  const timer = setInterval(() => {
    void (async () => {
      try {
        const files = await fs.readdir(destDir);
        const hit = files.find((f) => f.startsWith(`${fileId}.`));
        if (!hit) return;
        const st = await fs.stat(path.join(destDir, hit));
        const now = Date.now();
        const dt = Math.max(0.2, (now - lastAt) / 1000);
        const mbps = (st.size - lastSize) / dt / (1024 * 1024);
        lastSize = st.size;
        lastAt = now;
        const mb = st.size / (1024 * 1024);
        onProgress(
          mbps > 0.15
            ? `Descargando DVR… ${mb.toFixed(0)} MB · ${mbps.toFixed(1)} MB/s`
            : `Descargando DVR… ${mb.toFixed(0)} MB`,
        );
      } catch {
        // not created yet
      }
    })();
  }, 1000);
  return () => clearInterval(timer);
}

async function pickDownloaded(destDir: string, fileId: string): Promise<{ path: string; filename: string } | null> {
  const files = await fs.readdir(destDir);
  const match = files.find((f) => f.startsWith(fileId + ".") && !f.endsWith(".part"));
  return match ? { path: path.join(destDir, match), filename: match } : null;
}

export async function keepLastMinutes(
  filePath: string,
  minutes: number,
  destDir: string,
): Promise<{ path: string; filename: string }> {
  const probe = await probeVideo(filePath);
  const want = minutes * 60;
  if (!Number.isFinite(probe.durationSec) || probe.durationSec <= want + 2) {
    return { path: filePath, filename: path.basename(filePath) };
  }
  await fs.mkdir(destDir, { recursive: true });
  const parsed = path.parse(filePath);
  const filename = `${parsed.name}.last${minutes}m.mp4`;
  const outPath = path.join(destDir, filename);
  const start = Math.max(0, probe.durationSec - want);
  const copyArgs = [
    "-y",
    "-ss",
    start.toFixed(3),
    "-i",
    filePath,
    "-t",
    String(want),
    "-c",
    "copy",
    "-avoid_negative_ts",
    "make_zero",
    "-movflags",
    "+faststart",
    outPath,
  ];
  let { code, stderr } = await runCommand("ffmpeg", copyArgs, { timeoutMs: 10 * 60 * 1000 });
  if (code !== 0) {
    const retry = await runCommand(
      "ffmpeg",
      [
        "-y",
        "-ss",
        start.toFixed(3),
        "-i",
        filePath,
        "-t",
        String(want),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        outPath,
      ],
      { timeoutMs: 20 * 60 * 1000 },
    );
    code = retry.code;
    stderr = retry.stderr;
  }
  if (code !== 0) {
    throw new Error(`No se pudo recortar los últimos ${minutes} min: ${stderr.slice(-400)}`);
  }
  return { path: outPath, filename };
}

export async function downloadSourceVideo(
  url: string,
  destDir: string,
  fileId: string,
  maxHeight = 720,
  liveLastMinutes?: number,
  onProgress?: (msg: string) => void,
  cookiesBrowser = "auto",
): Promise<{ path: string; filename: string }> {
  const safeUrl = parseVideoUrl(url);
  await fs.mkdir(destDir, { recursive: true });
  const wantSec = (liveLastMinutes ?? 0) * 60;
  const onChunk = withProgress(onProgress);

  if (DIRECT_VIDEO.test(safeUrl) || /\.m3u8(\?|#|$)/i.test(safeUrl)) {
    const filename = `${fileId}.mp4`;
    const outPath = path.join(destDir, filename);
    const attempts: string[][] = [];
    if (wantSec > 0) {
      attempts.push(["-y", "-sseof", `-${wantSec}`, "-i", safeUrl, "-t", String(wantSec), "-c", "copy", "-movflags", "+faststart", outPath]);
      attempts.push(["-y", "-t", String(wantSec), "-i", safeUrl, "-c", "copy", "-movflags", "+faststart", outPath]);
    } else {
      attempts.push(["-y", "-i", safeUrl, "-c", "copy", "-movflags", "+faststart", outPath]);
    }
    let lastErr = "";
    for (const args of attempts) {
      const { code, stderr } = await runCommand("ffmpeg", args, {
        timeoutMs: wantSec > 0 ? recordTimeoutMs(liveLastMinutes!) : 30 * 60 * 1000,
        onChunk,
      });
      lastErr = stderr;
      if (code === 0) return { path: outPath, filename };
    }
    throw new Error(`No se pudo descargar el vídeo: ${lastErr.slice(-400)}`);
  }

  const ytdlp = await resolveYtdlp();
  if (liveLastMinutes) {
    return downloadLiveYoutube(
      ytdlp,
      safeUrl,
      destDir,
      fileId,
      maxHeight,
      liveLastMinutes,
      cookiesBrowser,
      onProgress,
      onChunk,
    );
  }
  return downloadVodYoutube(ytdlp, safeUrl, destDir, fileId, maxHeight, onProgress, onChunk);
}

async function downloadVodYoutube(
  ytdlp: { cmd: string; prefix: string[] },
  url: string,
  destDir: string,
  fileId: string,
  maxHeight: number,
  onProgress?: (msg: string) => void,
  onChunk?: (text: string) => void,
  lastMinutes = 0,
): Promise<{ path: string; filename: string }> {
  const h = qualityHeight(maxHeight);
  onProgress?.(
    lastMinutes
      ? `Descargando los últimos ${lastMinutes} min en ${h}p (VOD)…`
      : `Descargando vídeo en ${h}p…`,
  );
  const outTpl = path.join(destDir, `${fileId}.%(ext)s`);
  const { fmt, sort } = vodFormat(h);
  const sectionArgs =
    lastMinutes > 0 ? ["--download-sections", `*-${lastMinutes}:00-inf`] : [];
  const baseArgs = [
    ...ytdlp.prefix,
    "--no-playlist",
    "--restrict-filenames",
    "--no-mtime",
    "--newline",
    "--progress",
    "--js-runtimes",
    "node",
    "--remote-components",
    "ejs:github",
    ...ytdlpSpeedArgs(),
    "-S",
    sort,
    "-f",
    fmt,
    "--merge-output-format",
    "mp4",
    "-o",
    outTpl,
    ...sectionArgs,
  ];

  const timeoutMs = lastMinutes
    ? Math.min(12, Math.max(4, lastMinutes * 1.2 + 3)) * 60 * 1000
    : 45 * 60 * 1000;
  const run = (extra: string[]) =>
    runCommand(ytdlp.cmd, [...baseArgs, ...extra, "--", url], {
      timeoutMs,
      onChunk,
    });

  let { code, stderr } = await run(["--extractor-args", "youtube:player_client=tv,android,ios,web"]);
  let lastStderr = stderr;
  if (code === 0) {
    const match = await pickDownloaded(destDir, fileId);
    if (match) return match;
  }

  // YouTube bot-check: reuse the browser session without showing a cookies UI.
  if (/not a bot|Sign in to confirm/i.test(lastStderr) || lastMinutes) {
    onProgress?.(
      lastMinutes ? `Reintentando últimos ${lastMinutes} min…` : `Descargando vídeo en ${h}p…`,
    );
    const cookieTries = await cookieAttempts("auto");
    for (const cookies of cookieTries) {
      if (!cookies.args.length) continue;
      const retry = await run([
        "--extractor-args",
        "youtube:player_client=web,android,ios",
        ...cookies.args,
      ]);
      lastStderr = retry.stderr;
      if (retry.code === 0) {
        const match = await pickDownloaded(destDir, fileId);
        if (match) return match;
      }
    }
    if (/not a bot|Sign in to confirm/i.test(lastStderr)) {
      throw new Error(
        "YouTube pide confirmar que no eres un bot. Abre YouTube en Chrome (sesión iniciada), recarga y vuelve a exportar. Si macOS pide la clave del llavero, acéptala.",
      );
    }
  }

  throw downloadError(lastStderr, "formato no disponible");
}

function liveFormat(height: number): string {
  const h = qualityHeight(height);
  return [
    `bv*[height<=${h}][protocol^=m3u8]+ba`,
    `b[height<=${h}][protocol^=m3u8]`,
    `bv*[height<=${h}]+ba`,
    `b[height<=${h}]`,
    "bv*+ba/b",
  ].join("/");
}

function parseStreamUrls(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//i.test(l));
}

async function ytdlpLiveStatus(
  ytdlp: { cmd: string; prefix: string[] },
  url: string,
  cookieArgs: string[],
): Promise<string> {
  const { stdout, code } = await runOrTimeout(
    ytdlp.cmd,
    [
      ...ytdlp.prefix,
      "--skip-download",
      "--no-playlist",
      "--print",
      "live_status",
      "--extractor-args",
      "youtube:player_client=web,android",
      ...cookieArgs,
      "--",
      url,
    ],
    { timeoutMs: 25_000 },
  );
  if (code !== 0) return "unknown";
  return stdout.trim().split(/\s+/)[0]?.toLowerCase() || "unknown";
}

async function ytdlpGetUrls(
  ytdlp: { cmd: string; prefix: string[] },
  url: string,
  fmt: string,
  cookieArgs: string[],
): Promise<{ urls: string[]; stderr: string }> {
  const { stdout, stderr, code } = await runOrTimeout(
    ytdlp.cmd,
    [
      ...ytdlp.prefix,
      "-g",
      "-f",
      fmt,
      "--no-playlist",
      "--js-runtimes",
      "node",
      "--remote-components",
      "ejs:github",
      "--extractor-args",
      "youtube:player_client=web,mweb,tv,android",
      ...cookieArgs,
      "--",
      url,
    ],
    { timeoutMs: 40_000 },
  );
  if (code !== 0) return { urls: [], stderr };
  return { urls: parseStreamUrls(stdout), stderr };
}

async function downloadLiveYoutube(
  ytdlp: { cmd: string; prefix: string[] },
  url: string,
  destDir: string,
  fileId: string,
  maxHeight: number,
  liveLastMinutes: number,
  cookiesBrowser: string,
  onProgress?: (msg: string) => void,
  onChunk?: (text: string) => void,
): Promise<{ path: string; filename: string }> {
  const filename = `${fileId}.mp4`;
  const outPath = path.join(destDir, filename);
  const wantSec = liveLastMinutes * 60;
  const fmt = liveFormat(maxHeight);
  const cookieTries = await cookieAttempts(cookiesBrowser, {
    includeNone: true,
    browsers: ["chrome"],
  });

  const firstCookies = cookieTries[0]?.args ?? [];
  const status = await ytdlpLiveStatus(ytdlp, url, firstCookies);
  const stillLive = status === "is_live" || status === "true";

  if (!stillLive && status !== "unknown") {
    onProgress?.(`Ya no es un live (${status}). Cortando los últimos ${liveLastMinutes} min del VOD…`);
    return downloadVodYoutube(
      ytdlp,
      url,
      destDir,
      fileId,
      maxHeight,
      onProgress,
      onChunk,
      liveLastMinutes,
    );
  }

  onProgress?.(
    `Snapshot: ${liveLastMinutes} min hacia atrás desde ahora. El vivo que sigue no se descarga.`,
  );

  let lastStderr = "";
  const workDir = path.join(destDir, `${fileId}-hls`);
  try {
    for (const cookies of cookieTries) {
      onProgress?.(`Leyendo playlist DVR…`);
      const got = await ytdlpGetUrls(ytdlp, url, fmt, cookies.args);
      lastStderr = got.stderr;
      if (!got.urls.length) continue;
      const hlsUrls = got.urls.filter((u) => /m3u8/i.test(u));
      if (!hlsUrls.length) continue;
      const parallel = await downloadHlsWindow(
        hlsUrls,
        wantSec,
        qualityHeight(maxHeight),
        workDir,
        outPath,
        onProgress,
      );
      if (parallel) return { path: outPath, filename };
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  if (/not a bot|Sign in to confirm/i.test(lastStderr)) {
    throw new Error(
      "YouTube pide cookies para el directo. Abre YouTube en Chrome, recarga y vuelve a exportar.",
    );
  }
  throw new Error(
    `No hay replay/DVR para cortar hacia atrás. ${lastStderr.slice(-200)}`,
  );
}
