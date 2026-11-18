import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
import { canUseBrowserCookies, hasYoutubeCookiesFile, parseVideoUrl } from "./services/download.js";
import {
  DEFAULT_CLIP_OPTIONS,
  DEFAULT_GAMEPLAY_CROP,
  DEFAULT_WEBCAM_PRESETS,
  outputLabel,
} from "./types.js";

const PORT = Number(process.env.PORT ?? 8787);
const ROOT = path.resolve(process.cwd());

async function main() {
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
      if (file.fieldname === "cookies") {
        const ok =
          file.mimetype.startsWith("text/") ||
          /\.txt$/i.test(file.originalname) ||
          file.mimetype === "application/octet-stream";
        cb(ok ? null : new Error("Las cookies deben ser un .txt (formato Netscape)"), ok);
        return;
      }
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

  app.get("/api/defaults", async (_req, res) => {
    res.json({
      browserCookies: canUseBrowserCookies(),
      youtubeCookiesFile: await hasYoutubeCookiesFile(),
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
      { name: "cookies", maxCount: 1 },
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
      const files = req.files as {
        video?: Express.Multer.File[];
        videoB?: Express.Multer.File[];
        cookies?: Express.Multer.File[];
      } | undefined;
      const fileA = files?.video?.[0];
      const fileB = files?.videoB?.[0];
      const cookiesFile = files?.cookies?.[0]?.path;
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
          cookiesFile,
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
        cookiesFile,
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Clips MVP listening on http://0.0.0.0:${PORT}`);
  });
}

function optionalUrl(raw: unknown): string | undefined {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return undefined;
  return parseVideoUrl(text);
}

function publicJob(job: ReturnType<typeof getJob>) {
  if (!job) return null;
  const { sourcePath: _sp, sourcePathB: _spb, cookiesFile: _cf, ...rest } = job;
  return {
    ...rest,
    clips: job.clips?.map(({ path: _p, ...c }) => c),
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
