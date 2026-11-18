import { promises as fs } from "node:fs";
import path from "node:path";
import { probeVideo, runCommand } from "./ffmpeg.js";

const HLS_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  origin: "https://www.youtube.com",
  referer: "https://www.youtube.com/",
  accept: "*/*",
};

interface Seg {
  url: string;
  duration: number;
}

function resolveUri(base: string, uri: string): string {
  if (/^https?:\/\//i.test(uri)) return uri;
  return new URL(uri, base).href;
}

async function fetchBuffer(url: string, timeoutMs = 25_000): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: HLS_HEADERS, redirect: "follow", signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string): Promise<string> {
  return (await fetchBuffer(url, 20_000)).toString("utf8");
}

function parseVariants(text: string, playlistUrl: string): Array<{ height: number; bw: number; url: string }> {
  const lines = text.split(/\r?\n/);
  const out: Array<{ height: number; bw: number; url: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const bw = Number(line.match(/BANDWIDTH=(\d+)/i)?.[1] ?? 0);
    const height = Number(line.match(/RESOLUTION=\d+x(\d+)/i)?.[1] ?? 0);
    const next = lines[i + 1]?.trim();
    if (!next || next.startsWith("#")) continue;
    out.push({ height, bw, url: resolveUri(playlistUrl, next) });
  }
  return out;
}

function parseMedia(text: string, playlistUrl: string): { init?: string; segs: Seg[]; encrypted: boolean } {
  const lines = text.split(/\r?\n/);
  const segs: Seg[] = [];
  let init: string | undefined;
  let encrypted = false;
  let nextDur = 2;
  let targetDur = 2;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDur = Number.parseFloat(line.slice(22)) || targetDur;
    }
    if (line.startsWith("#EXT-X-KEY:") && /METHOD=AES/i.test(line)) encrypted = true;
    if (line.startsWith("#EXT-X-MAP:")) {
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      if (uri) init = resolveUri(playlistUrl, uri);
    }
    if (line.startsWith("#EXTINF:")) {
      nextDur = Number.parseFloat(line.slice(8)) || targetDur;
      continue;
    }
    if (line && !line.startsWith("#")) {
      segs.push({ url: resolveUri(playlistUrl, line), duration: nextDur || targetDur });
    }
  }
  return { init, segs, encrypted };
}

function parseSq(url: string): { kind: "path" | "query"; n: number } | null {
  const pathM = url.match(/\/sq\/(\d+)/);
  if (pathM) return { kind: "path", n: Number(pathM[1]) };
  const q = url.match(/[?&]sq=(\d+)/i);
  if (q) return { kind: "query", n: Number(q[1]) };
  return null;
}

function setSq(url: string, n: number, kind: "path" | "query"): string {
  if (kind === "path") return url.replace(/\/sq\/\d+/, `/sq/${n}`);
  return url.replace(/([?&]sq=)\d+/i, `$1${n}`);
}

/** YouTube live playlists often list ~30s; older chunks are still on the CDN as /sq/N. */
function rewindWindow(segs: Seg[], wantSec: number): Seg[] {
  if (!segs.length) return segs;
  const listed = lastWindow(segs, wantSec);
  const listedDur = listed.reduce((s, x) => s + x.duration, 0);
  if (listedDur >= wantSec - 2) return listed;
  const last = segs[segs.length - 1]!;
  const parsed = parseSq(last.url);
  if (!parsed) return listed;
  const segDur = last.duration || 2;
  const need = Math.max(listed.length, Math.ceil(wantSec / segDur) + 2);
  const endN = parsed.n;
  const startN = Math.max(0, endN - need + 1);
  const out: Seg[] = [];
  for (let n = startN; n <= endN; n++) {
    out.push({ url: setSq(last.url, n, parsed.kind), duration: segDur });
  }
  return out;
}

async function loadMediaPlaylist(
  url: string,
  maxHeight: number,
): Promise<{ init?: string; segs: Seg[]; encrypted: boolean }> {
  const text = await fetchText(url);
  if (/#EXT-X-STREAM-INF/i.test(text)) {
    const variants = parseVariants(text, url);
    const capped = variants.filter((v) => !v.height || v.height <= maxHeight);
    const pool = capped.length ? capped : variants;
    pool.sort((a, b) => (b.height || 0) - (a.height || 0) || b.bw - a.bw);
    const pick = pool[0];
    if (!pick) throw new Error("playlist maestro vacío");
    return loadMediaPlaylist(pick.url, maxHeight);
  }
  return parseMedia(text, url);
}

function lastWindow(segs: Seg[], wantSec: number): Seg[] {
  let acc = 0;
  const out: Seg[] = [];
  for (let i = segs.length - 1; i >= 0 && acc < wantSec + 1; i--) {
    out.unshift(segs[i]!);
    acc += segs[i]!.duration;
  }
  return out;
}

async function downloadMany(
  urls: string[],
  dir: string,
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  await fs.mkdir(dir, { recursive: true });
  const paths = urls.map((_, i) => path.join(dir, `${String(i).padStart(5, "0")}.seg`));
  let next = 0;
  let done = 0;
  const workers = Math.min(24, urls.length || 1);
  const run = async () => {
    while (true) {
      const i = next++;
      if (i >= urls.length) return;
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const buf = await fetchBuffer(urls[i]!, 30_000);
          await fs.writeFile(paths[i]!, buf);
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          if (/HTTP 404|HTTP 403/.test(msg)) break;
        }
      }
      done += 1;
      onProgress?.(done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: workers }, run));
  return paths;
}

async function concatFiles(files: string[], outPath: string): Promise<void> {
  const fh = await fs.open(outPath, "w");
  try {
    for (const file of files) {
      await fh.writeFile(await fs.readFile(file));
    }
  } finally {
    await fh.close();
  }
}

async function remuxCopy(input: string, outPath: string): Promise<boolean> {
  const head = ["-y", "-probesize", "100M", "-analyzeduration", "100M", "-fflags", "+genpts+discardcorrupt"];
  const tries = [
    [...head, "-i", input, "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", outPath],
    [...head, "-f", "mpegts", "-i", input, "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", outPath],
    ["-y", "-f", "concat", "-safe", "0", "-i", input, "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", outPath],
  ];
  for (const args of tries) {
    const { code } = await runCommand("ffmpeg", args, { timeoutMs: 120_000 });
    if (code === 0) {
      try {
        const st = await fs.stat(outPath);
        if (st.size > 80_000) return true;
      } catch {
        // empty
      }
    }
  }
  return false;
}

async function pullOnePlaylist(
  playlistUrl: string,
  wantSec: number,
  maxHeight: number,
  workDir: string,
  label: string,
  onProgress?: (msg: string) => void,
  minRatio = 0,
): Promise<{ path: string; duration: number }> {
  const media = await loadMediaPlaylist(playlistUrl, maxHeight);
  if (media.encrypted) throw new Error("HLS cifrado");
  if (media.segs.length < 2) throw new Error("sin ventana DVR");
  const window = rewindWindow(media.segs, wantSec);
  const totalDur = window.reduce((s, x) => s + x.duration, 0);
  if (totalDur < 8 || (minRatio > 0 && totalDur < wantSec * minRatio)) {
    throw new Error(`DVR ${label} solo ${Math.round(totalDur)}s`);
  }

  const urls = window.map((s) => s.url);
  onProgress?.(
    `${label}: ${Math.round(Math.min(totalDur, wantSec))}s hacia atrás · ${urls.length} fragmentos`,
  );
  const parts = (
    await downloadMany(urls, path.join(workDir, label), (done, total) => {
      onProgress?.(`${label}: ${done}/${total} fragmentos`);
    })
  ).filter((p) => p);
  const existing: string[] = [];
  for (const p of parts) {
    try {
      const st = await fs.stat(p);
      if (st.size > 64) existing.push(p);
    } catch {
      // 404 skip
    }
  }
  if (existing.length < 3) throw new Error(`DVR ${label}: muy pocos fragmentos`);
  const ordered = media.init ? [path.join(workDir, `${label}.init`), ...existing] : existing;
  if (media.init) {
    await fs.writeFile(ordered[0]!, await fetchBuffer(media.init));
  }
  const bin = path.join(workDir, `${label}.bin`);
  await concatFiles(ordered, bin);
  const listPath = path.join(workDir, `${label}.ffconcat`);
  await fs.writeFile(
    listPath,
    existing.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
  );
  const out = path.join(workDir, `${label}.mp4`);
  let ok = await remuxCopy(bin, out);
  if (!ok) ok = await remuxCopy(listPath, out);
  if (!ok) throw new Error(`no se pudo remux ${label}`);
  try {
    const probed = await probeVideo(out);
    return { path: out, duration: probed.durationSec };
  } catch {
    return { path: out, duration: existing.length * (window[0]?.duration || 2) };
  }
}

export async function downloadHlsWindow(
  playlistUrls: string[],
  wantSec: number,
  maxHeight: number,
  workDir: string,
  outPath: string,
  onProgress?: (msg: string) => void,
): Promise<boolean> {
  await fs.mkdir(workDir, { recursive: true });
  if (!playlistUrls.length) return false;
  try {
    if (playlistUrls.length === 1) {
      const file = await pullOnePlaylist(playlistUrls[0]!, wantSec, maxHeight, workDir, "mux", onProgress);
      await fs.copyFile(file.path, outPath);
      return true;
    }
    const [video, audio] = await Promise.all([
      pullOnePlaylist(playlistUrls[0]!, wantSec, maxHeight, workDir, "video", onProgress),
      pullOnePlaylist(playlistUrls[1]!, wantSec, maxHeight, workDir, "audio", onProgress, 0.15).catch(
        () => null,
      ),
    ]);
    const muxArgs = audio
      ? [
          "-y",
          "-i",
          video.path,
          "-i",
          audio.path,
          "-map",
          "0:v:0?",
          "-map",
          "1:a:0?",
          "-c",
          "copy",
          "-t",
          String(wantSec),
          "-movflags",
          "+faststart",
          outPath,
        ]
      : ["-y", "-i", video.path, "-c", "copy", "-movflags", "+faststart", outPath];
    const { code } = await runCommand("ffmpeg", muxArgs, { timeoutMs: 90_000 });
    if (code !== 0) {
      const fallback = await runCommand(
        "ffmpeg",
        ["-y", "-i", video.path, "-c", "copy", "-movflags", "+faststart", outPath],
        { timeoutMs: 60_000 },
      );
      if (fallback.code !== 0) return false;
    }
    const st = await fs.stat(outPath);
    return st.size > 80_000;
  } catch (err) {
    onProgress?.(`DVR paralelo: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
