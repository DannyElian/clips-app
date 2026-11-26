import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "./env.js";
import { initDb } from "./db.js";
import {
  cancelJob,
  createJob,
  getJob,
  initStorage,
  listJobs,
  parseClipOptions,
  parseCropConfig,
  UPLOADS_DIR,
  JOBS_DIR,
} from "./services/jobs.js";
import { cancelTranscript, createTranscript, getTranscript } from "./services/transcripts.js";
import { downloadSourceVideo, parseVideoUrl } from "./services/download.js";
import {
  applySilence,
  burnSubtitles,
  chat,
  chatHistory,
  cancelTool,
  detectSilence,
  generateCopy,
  generateTitles,
  getToolJob,
  LANGS,
  listResults,
  makeThumbnail,
  outputFile,
  outputUrl,
  resolveMedia,
  saveUpload,
  startTool,
  subtitlePreview,
  suggestFrames,
  transcribeMedia,
  translateSegments,
} from "./services/tools.js";
import {
  clearTikTokSession,
  exchangeTikTokCode,
  getTikTokStatus,
  publishClipToTikTok,
  tiktokConfigured,
  tiktokLoginUrl,
} from "./services/tiktok.js";
import {
  DEFAULT_CLIP_OPTIONS,
  DEFAULT_GAMEPLAY_CROP,
  DEFAULT_WEBCAM_PRESETS,
  outputLabel,
} from "./types.js";

loadEnvFile();
const PORT = Number(process.env.PORT ?? 8787);
const ROOT = path.resolve(process.cwd());

async function main() {
  try {
    await initDb();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Postgres no está listo. Revisa DATABASE_URL. ${message}`);
    process.exit(1);
  }
  await initStorage();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  app.use(express.static(path.join(ROOT, "public")));

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^\w.\-]+/g, "_");
      cb(null, `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`);
    },
  });
  const upload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
    fileFilter: (_req, file, cb) => {
      const ok =
        file.mimetype.startsWith("video/") ||
        /\.(mp4|mkv|mov|webm|avi|m4v)$/i.test(file.originalname);
      if (!ok) {
        cb(new Error("Solo se aceptan archivos de vídeo"));
        return;
      }
      cb(null, true);
    },
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "clips-app", defaults: {
      webcamPresets: DEFAULT_WEBCAM_PRESETS,
      gameplay: DEFAULT_GAMEPLAY_CROP,
      options: DEFAULT_CLIP_OPTIONS,
    }});
  });

  app.get("/api/defaults", (_req, res) => {
    res.json({
      webcamPresets: DEFAULT_WEBCAM_PRESETS,
      gameplay: DEFAULT_GAMEPLAY_CROP,
      options: DEFAULT_CLIP_OPTIONS,
      layout: {
        outputTopPercent: 40,
        outputBottomPercent: 60,
        assumption:
          "El origen es una captura a pantalla completa (VOD típico de Twitch) con overlay de webcam. El recorte por defecto de la cámara es abajo-izquierda (~24%×30%). El gameplay usa el fotograma completo. La salida apila la cámara ARRIBA (40%) y el juego ABAJO (60%) en 9:16.",
      },
    });
  });

  app.get("/api/jobs", (_req, res) => {
    res.json({
      jobs: listJobs().map(publicJob),
    });
  });

  app.get("/api/jobs/:id", (req, res) => {
    const job = getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Trabajo no encontrado" });
      return;
    }
    res.json(publicJob(job));
  });

  app.get("/api/jobs/:id/clips/:filename", (req, res) => {
    const job = getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Trabajo no encontrado" });
      return;
    }
    const safe = path.basename(req.params.filename);
    const filePath = path.join(JOBS_DIR, job.id, "clips", safe);
    res.sendFile(filePath, (err) => {
      if (!err || res.headersSent) return;
      res.status(404).json({ error: "Clip no encontrado" });
    });
  });

  app.get("/api/tiktok/status", async (_req, res) => {
    try {
      res.json(await getTikTokStatus());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/tiktok/login", (_req, res) => {
    if (!tiktokConfigured()) {
      res.status(500).send("Falta configurar TikTok en .env");
      return;
    }
    res.redirect(tiktokLoginUrl());
  });

  app.get("/api/tiktok/callback", async (req, res) => {
    const err = typeof req.query.error === "string" ? req.query.error : "";
    const errDesc =
      typeof req.query.error_description === "string" ? req.query.error_description : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    try {
      if (err) throw new Error(errDesc || err);
      if (!code) throw new Error("TikTok no devolvió el código de autorización");
      await exchangeTikTokCode(code, state);
      res.type("html").send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>TikTok</title></head>
<body style="font-family:system-ui;background:#0b0b10;color:#fff;padding:2rem">
  <p>TikTok conectado. Ya puedes publicar clips.</p>
  <p><a href="/" style="color:#ff3cac">Volver a CLIPS</a></p>
  <script>setTimeout(() => { location.href = "/"; }, 900);</script>
</body></html>`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(400).type("html").send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>TikTok</title></head>
<body style="font-family:system-ui;background:#0b0b10;color:#fff;padding:2rem">
  <p>No se pudo conectar TikTok: ${message.replace(/</g, "")}</p>
  <p>En el portal de desarrolladores de TikTok añade este Redirect URI:</p>
  <code>http://localhost:8787/api/tiktok/callback</code>
  <p><a href="/" style="color:#ff3cac">Volver</a></p>
</body></html>`);
    }
  });

  app.post("/api/tiktok/logout", async (_req, res) => {
    await clearTikTokSession();
    res.json({ ok: true, connected: false, configured: tiktokConfigured() });
  });

  app.post("/api/tiktok/publish", async (req, res) => {
    try {
      const jobId = String(req.body?.jobId || "");
      const filename = path.basename(String(req.body?.filename || ""));
      const title = String(req.body?.title || filename.replace(/\.[^.]+$/, "") || "Clip");
      const job = getJob(jobId);
      if (!job) {
        res.status(404).json({ error: "Trabajo no encontrado" });
        return;
      }
      const filePath = path.join(JOBS_DIR, job.id, "clips", filename);
      if (!filename || !existsSync(filePath)) {
        res.status(404).json({ error: "Clip no encontrado" });
        return;
      }
      const result = await publishClipToTikTok(filePath, title);
      res.json({
        ok: true,
        ...result,
        message:
          result.mode === "inbox"
            ? "Vídeo enviado a tu bandeja de TikTok. Ábrelo en el móvil para publicar."
            : "Subido a TikTok (privado hasta que TikTok audite la app).",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  app.get("/api/tools/langs", (_req, res) => {
    res.json({ langs: LANGS });
  });

  app.post("/api/tools/open", (req, res, next) => {
    if (req.is("application/json")) {
      next();
      return;
    }
    upload.single("video")(req, res, (err) => {
      if (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      next();
    });
  }, async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      let sourceUrl: string | undefined;
      try {
        sourceUrl = optionalUrl(body.sourceUrl ?? body.url);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (!req.file && sourceUrl) {
        const url = sourceUrl;
        const job = startTool(async (tool) => {
          tool.progress = "Descargando el enlace…";
          const downloaded = await downloadSourceVideo(url, path.join(ROOT, "data", "library"), randomUUID().slice(0, 8), 1080, undefined, (msg) => {
            tool.progress = msg;
          });
          const media = await resolveMedia({ filePath: downloaded.path, filename: downloaded.filename });
          return {
            mediaKey: media.mediaKey,
            filename: media.filename,
            jobId: media.jobId,
            filePath: media.path,
            probe: media.probe,
            frames: await suggestFrames(media),
            previewUrl: outputUrl(media, "source"),
            results: await listResults(media.mediaKey),
          };
        });
        res.status(202).json(job);
        return;
      }
      const media = req.file
        ? await saveUpload(req.file.path, req.file.originalname)
        : await resolveMedia({
            jobId: String(body.jobId || "") || undefined,
            filename: String(body.filename || "") || undefined,
            filePath: typeof body.filePath === "string" ? body.filePath : undefined,
          });
      res.json({
        mediaKey: media.mediaKey,
        filename: media.filename,
        jobId: media.jobId,
        filePath: media.path,
        probe: media.probe,
        frames: await suggestFrames(media),
        previewUrl: outputUrl(media, "source"),
        results: await listResults(media.mediaKey),
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/tools/jobs/:id/cancel", (req, res) => {
    res.json({ ok: cancelTool(req.params.id) });
  });

  app.get("/api/tools/jobs/:id", (req, res) => {
    const job = getToolJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Trabajo no encontrado" });
      return;
    }
    res.json(job);
  });

  app.post("/api/tools/transcript", async (req, res) => {
    try {
      const body = req.body as { jobId?: string; filename?: string; filePath?: string };
      const media = await resolveMedia(body);
      const job = startTool(async (tool) => {
        tool.progress = "Transcribiendo como se dice…";
        return transcribeMedia(media);
      });
      res.status(202).json(job);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/tools/subtitles", async (req, res) => {
    try {
      const body = req.body as { jobId?: string; filename?: string; filePath?: string; style?: string; burn?: boolean; position?: "top" | "middle" | "bottom"; color?: string; size?: string };
      const media = await resolveMedia(body);
      const job = startTool(async () => {
        const preview = await subtitlePreview(media, body.style || "frase");
        if (!body.burn) return preview;
        const burned = await burnSubtitles(media, {
          position: body.position || "bottom",
          color: body.color,
          look: body.style,
          size: body.size,
        });
        return { ...preview, fileUrl: outputUrl(media, burned.filename), filename: burned.filename, exported: burned.probe };
      });
      res.status(202).json(job);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/tools/silence", async (req, res) => {
    try {
      const body = req.body as { jobId?: string; filename?: string; filePath?: string; minSec?: number; noiseDb?: number; apply?: Array<{ start: number; end: number }> };
      const media = await resolveMedia(body);
      const job = startTool(async () => {
        if (body.apply) {
          const out = await applySilence(media, body.apply);
          return { fileUrl: outputUrl(media, out.filename), filename: out.filename, exported: out.probe };
        }
        return detectSilence(media, Number(body.minSec) || 0.8, Number(body.noiseDb) || -35);
      });
      res.status(202).json(job);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/tools/translate", async (req, res) => {
    try {
      const body = req.body as { jobId?: string; filename?: string; filePath?: string; lang?: string; burn?: boolean };
      const media = await resolveMedia(body);
      const job = startTool(async () => {
        const translated = await translateSegments(media, body.lang || "en");
        if (!body.burn) return translated;
        const burned = await burnSubtitles(media, { position: "bottom", color: "#fff" }, translated.segments);
        return { ...translated, fileUrl: outputUrl(media, burned.filename), filename: burned.filename };
      });
      res.status(202).json(job);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/tools/titles", async (req, res) => {
    try {
      const body = req.body as { jobId?: string; filename?: string; filePath?: string; tone?: string; network?: string };
      const media = await resolveMedia(body);
      const job = startTool(() => generateTitles(media, body.tone || "divertido", body.network || "TikTok"));
      res.status(202).json(job);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/tools/description", async (req, res) => {
    try {
      const body = req.body as { jobId?: string; filename?: string; filePath?: string; tone?: string; network?: string };
      const media = await resolveMedia(body);
      const job = startTool(() => generateCopy(media, body.tone || "divertido", body.network || "TikTok"));
      res.status(202).json(job);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/tools/chat", async (req, res) => {
    try {
      const body = req.body as { jobId?: string; filename?: string; filePath?: string; question?: string };
      const media = await resolveMedia(body);
      const question = String(body.question || "").trim();
      if (!question) {
        res.json({ history: await chatHistory(media.mediaKey), mediaKey: media.mediaKey });
        return;
      }
      const job = startTool(() => chat(media, question));
      res.status(202).json(job);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/tools/thumbnail", async (req, res) => {
    try {
      const body = req.body as { jobId?: string; filename?: string; filePath?: string; atSec?: number; title?: string; format?: "youtube" | "vertical" | "jpg" };
      const media = await resolveMedia(body);
      const job = startTool(async () => {
        const made = await makeThumbnail(media, Number(body.atSec) || 0, body.title || "", body.format || "youtube");
        return { fileUrl: outputUrl(media, made.filename), filename: made.filename, cached: made.cached };
      });
      res.status(202).json(job);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/tools/file/:key/:name", async (req, res) => {
    try {
      const file = await outputFile(req.params.key, req.params.name);
      res.sendFile(file);
    } catch {
      res.status(404).json({ error: "Archivo no encontrado" });
    }
  });

  app.post("/api/transcripts", (req, res, next) => {
    upload.single("video")(req, res, (err) => {
      if (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
        return;
      }
      next();
    });
  }, async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const file = req.file;
      let url: string | undefined;
      try {
        url = optionalUrl(body.sourceUrl ?? body.url);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
        return;
      }
      if (!file && !url) {
        res.status(400).json({ error: "Sube un vídeo o pega un enlace." });
        return;
      }
      const job = await createTranscript({
        sourcePath: file?.path,
        sourceUrl: file ? undefined : url,
        sourceFilename: file?.originalname ?? url ?? "vídeo",
      });
      res.status(202).json(job);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/transcripts/:id", (req, res) => {
    const job = getTranscript(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Transcripción no encontrada" });
      return;
    }
    res.json(job);
  });

  app.post("/api/transcripts/:id/cancel", (req, res) => {
    const job = cancelTranscript(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Transcripción no encontrada" });
      return;
    }
    res.json(job);
  });

  app.post("/api/jobs/:id/cancel", (req, res) => {
    const job = cancelJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Trabajo no encontrado" });
      return;
    }
    res.json(publicJob(job));
  });

  app.post("/api/jobs", (req, res, next) => {
    upload.fields([
      { name: "video", maxCount: 1 },
      { name: "videoB", maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
        return;
      }
      next();
    });
  }, async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const files = req.files as { video?: Express.Multer.File[]; videoB?: Express.Multer.File[] } | undefined;
      const fileA = files?.video?.[0];
      const fileB = files?.videoB?.[0];
      let options = parseClipOptions(body);

      let urlA: string | undefined;
      let urlB: string | undefined;
      try {
        urlA = optionalUrl(body.sourceUrl ?? body.url ?? body.sourceUrlA);
        urlB = optionalUrl(body.sourceUrlB ?? body.urlB);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
        return;
      }

      const isPair = Boolean(fileB || urlB);
      if (isPair) {
        if (!fileA && !urlA) {
          res.status(400).json({ error: "Falta el vídeo 1 (enlace o archivo)." });
          return;
        }
        if (!fileB && !urlB) {
          res.status(400).json({ error: "Falta el vídeo 2 (enlace o archivo)." });
          return;
        }
        options = {
          ...options,
          layout: "pair",
          output: outputLabel("dual", options.quality),
        };
        const crop = parseCropConfig(body);
        const job = await createJob({
          sourcePath: fileA?.path,
          sourceUrl: fileA ? undefined : urlA,
          sourceFilename: fileA?.originalname ?? urlA ?? "vídeo 1",
          sourcePathB: fileB?.path,
          sourceUrlB: fileB ? undefined : urlB,
          sourceFilenameB: fileB?.originalname ?? urlB ?? "vídeo 2",
          crop,
          options,
        });
        res.status(202).json(publicJob(job));
        return;
      }

      if (!fileA && !urlA) {
        res.status(400).json({
          error: "Sube un archivo de vídeo o pega un enlace (YouTube, Twitch u otro).",
        });
        return;
      }
      const crop = parseCropConfig(body);
      const job = await createJob({
        sourcePath: fileA?.path,
        sourceUrl: fileA ? undefined : urlA,
        sourceFilename: fileA?.originalname ?? urlA ?? "enlace",
        crop,
        options,
      });
      res.status(202).json(publicJob(job));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  });

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Clips MVP listening on http://localhost:${PORT}`);
  });
}

function optionalUrl(raw: unknown): string | undefined {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return undefined;
  return parseVideoUrl(text);
}

function publicJob(job: ReturnType<typeof getJob>) {
  if (!job) return null;
  const { sourcePath: _sp, sourcePathB: _spb, ...rest } = job;
  return {
    ...rest,
    clips: job.clips?.map(({ path: _p, ...c }) => c),
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
