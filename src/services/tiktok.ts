import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./jobs.js";

const AUTH = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN = "https://open.tiktokapis.com/v2/oauth/token/";
const CREATOR = "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const INIT_DIRECT = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const INIT_INBOX = "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
const STATUS = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";
const USER = "https://open.tiktokapis.com/v2/user/info/";

const TOKEN_FILE = () => path.join(DATA_DIR, "tiktok-token.json");

let pendingOauth: { state: string; verifier: string } | null = null;

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export type TikTokSession = {
  accessToken: string;
  refreshToken: string;
  openId: string;
  expiresAt: number;
  scope: string;
  displayName?: string;
};

function clientKey(): string {
  return (process.env.TIKTOK_CLIENT_KEY || "").trim();
}

function clientSecret(): string {
  return (process.env.TIKTOK_CLIENT_SECRET || "").trim();
}

function redirectUri(): string {
  return (process.env.TIKTOK_REDIRECT_URI || "http://localhost:8787/api/tiktok/callback").trim();
}

export function tiktokConfigured(): boolean {
  return Boolean(clientKey() && clientSecret());
}

async function readSession(): Promise<TikTokSession | null> {
  try {
    const raw = JSON.parse(await fs.readFile(TOKEN_FILE(), "utf8")) as TikTokSession;
    if (!raw.accessToken) return null;
    return raw;
  } catch {
    return null;
  }
}

async function writeSession(session: TikTokSession): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(TOKEN_FILE(), JSON.stringify(session, null, 2));
}

export async function clearTikTokSession(): Promise<void> {
  await fs.unlink(TOKEN_FILE()).catch(() => undefined);
}

async function refreshIfNeeded(session: TikTokSession): Promise<TikTokSession> {
  if (Date.now() < session.expiresAt - 60_000) return session;
  const body = new URLSearchParams({
    client_key: clientKey(),
    client_secret: clientSecret(),
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
  });
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    open_id?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!json.access_token) {
    throw new Error(json.error_description || json.error || "No se pudo renovar TikTok");
  }
  const next: TikTokSession = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || session.refreshToken,
    openId: json.open_id || session.openId,
    expiresAt: Date.now() + Math.max(60, json.expires_in ?? 86400) * 1000,
    scope: json.scope || session.scope,
    displayName: session.displayName,
  };
  await writeSession(next);
  return next;
}

export async function getTikTokStatus(): Promise<{
  configured: boolean;
  connected: boolean;
  displayName?: string;
}> {
  if (!tiktokConfigured()) return { configured: false, connected: false };
  const session = await readSession();
  if (!session) return { configured: true, connected: false };
  try {
    const live = await refreshIfNeeded(session);
    return { configured: true, connected: true, displayName: live.displayName };
  } catch {
    return { configured: true, connected: false };
  }
}

export function tiktokLoginUrl(): string {
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("hex");
  pendingOauth = { state, verifier };
  const params = new URLSearchParams({
    client_key: clientKey(),
    response_type: "code",
    scope: "user.info.basic,video.upload,video.publish",
    redirect_uri: redirectUri(),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTH}?${params.toString()}`;
}

export async function exchangeTikTokCode(code: string, state: string): Promise<TikTokSession> {
  if (!pendingOauth || state !== pendingOauth.state) {
    throw new Error("Estado OAuth inválido. Vuelve a conectar TikTok.");
  }
  const verifier = pendingOauth.verifier;
  pendingOauth = null;
  const body = new URLSearchParams({
    client_key: clientKey(),
    client_secret: clientSecret(),
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    open_id?: string;
    scope?: string;
    error?: string;
    error_description?: string;
    message?: string;
  };
  if (!json.access_token) {
    throw new Error(json.error_description || json.message || json.error || "TikTok no dio el token");
  }
  const session: TikTokSession = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || "",
    openId: json.open_id || "",
    expiresAt: Date.now() + Math.max(60, json.expires_in ?? 86400) * 1000,
    scope: json.scope || "",
  };
  try {
    const info = await fetch(`${USER}?fields=display_name`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    const infoJson = (await info.json()) as {
      data?: { user?: { display_name?: string } };
    };
    session.displayName = infoJson.data?.user?.display_name;
  } catch {
    // optional
  }
  await writeSession(session);
  return session;
}

async function tiktokJson(
  url: string,
  token: string,
  body: unknown,
): Promise<{ data?: Record<string, unknown>; error?: { code?: string; message?: string } }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as {
    data?: Record<string, unknown>;
    error?: { code?: string; message?: string };
  };
}

function chunkPlan(size: number): { chunkSize: number; totalChunkCount: number } {
  if (size <= 10 * 1024 * 1024) return { chunkSize: size, totalChunkCount: 1 };
  const chunkSize = 10 * 1024 * 1024;
  return { chunkSize, totalChunkCount: Math.ceil(size / chunkSize) };
}

async function putVideo(uploadUrl: string, filePath: string, size: number): Promise<void> {
  const { chunkSize, totalChunkCount } = chunkPlan(size);
  const fh = await fs.open(filePath, "r");
  try {
    for (let i = 0; i < totalChunkCount; i++) {
      const start = i * chunkSize;
      const end = Math.min(size, start + chunkSize);
      const buf = Buffer.alloc(end - start);
      await fh.read(buf, 0, buf.length, start);
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(buf.length),
          "Content-Range": `bytes ${start}-${end - 1}/${size}`,
        },
        body: buf,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Subida TikTok ${res.status}: ${text.slice(0, 240)}`);
      }
    }
  } finally {
    await fh.close();
  }
}

export async function publishClipToTikTok(
  filePath: string,
  title: string,
): Promise<{ publishId: string; mode: "direct" | "inbox" }> {
  const session0 = await readSession();
  if (!session0) throw new Error("Conecta TikTok primero");
  const session = await refreshIfNeeded(session0);
  const st = await fs.stat(filePath);
  const { chunkSize, totalChunkCount } = chunkPlan(st.size);
  const source = {
    source: "FILE_UPLOAD",
    video_size: st.size,
    chunk_size: chunkSize,
    total_chunk_count: totalChunkCount,
  };

  const caption = title.slice(0, 150) || "Clip";
  let uploadUrl = "";
  let publishId = "";
  let mode: "direct" | "inbox" = "direct";

  const creator = await tiktokJson(CREATOR, session.accessToken, {});
  const levels = (creator.data?.privacy_level_options as string[] | undefined) ?? [];
  const privacy =
    levels.includes("SELF_ONLY") ? "SELF_ONLY" : levels[0] || "SELF_ONLY";

  if (creator.error?.code === "ok" && creator.data) {
    const init = await tiktokJson(INIT_DIRECT, session.accessToken, {
      post_info: {
        title: caption,
        privacy_level: privacy,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        video_cover_timestamp_ms: 500,
        brand_content_toggle: false,
        brand_organic_toggle: false,
      },
      source_info: source,
    });
    if (init.error?.code === "ok" && init.data?.upload_url && init.data?.publish_id) {
      uploadUrl = String(init.data.upload_url);
      publishId = String(init.data.publish_id);
    }
  }

  if (!uploadUrl) {
    mode = "inbox";
    const inbox = await tiktokJson(INIT_INBOX, session.accessToken, {
      source_info: source,
    });
    if (inbox.error?.code !== "ok" || !inbox.data?.upload_url || !inbox.data?.publish_id) {
      throw new Error(
        inbox.error?.message ||
          creator.error?.message ||
          "TikTok no autorizó publicar. En el portal activa Content Posting API y el redirect http://localhost:8787/api/tiktok/callback.",
      );
    }
    uploadUrl = String(inbox.data.upload_url);
    publishId = String(inbox.data.publish_id);
  }

  await putVideo(uploadUrl, filePath, st.size);
  await tiktokJson(STATUS, session.accessToken, { publish_id: publishId });
  return { publishId, mode };
}
