import os from "node:os";
import pg from "pg";

const user = os.userInfo().username;
export const databaseUrl =
  process.env.DATABASE_URL || `postgresql://${user}@/clips?host=/tmp&port=5432`;

export const pool = new pg.Pool({ connectionString: databaseUrl });

export async function initDb(): Promise<void> {
  await pool.query("SELECT 1");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media (
      media_key text PRIMARY KEY,
      path text NOT NULL,
      filename text NOT NULL,
      width integer,
      height integer,
      fps real,
      duration_sec real,
      codec text,
      bitrate bigint,
      job_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS transcripts (
      media_key text NOT NULL,
      with_words boolean NOT NULL DEFAULT false,
      language text,
      full_text text NOT NULL,
      segments jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (media_key, with_words)
    );
    CREATE TABLE IF NOT EXISTS tool_results (
      id text PRIMARY KEY,
      media_key text NOT NULL,
      tool text NOT NULL,
      status text NOT NULL,
      payload jsonb,
      output_path text,
      error text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id text PRIMARY KEY,
      media_key text NOT NULL,
      role text NOT NULL,
      content text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS tool_results_media_tool ON tool_results (media_key, tool, created_at DESC);
    CREATE TABLE IF NOT EXISTS source_videos (
      video_key text NOT NULL,
      height integer NOT NULL,
      url text NOT NULL,
      path text NOT NULL,
      filename text NOT NULL,
      saved_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (video_key, height)
    );
  `);
}
