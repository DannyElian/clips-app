import { toolAbort } from "./cancel.js";

const HOST = () => (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
export const OLLAMA_MODEL = () => process.env.OLLAMA_MODEL || "llama3.2";

export async function ollamaChat(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  opts?: { json?: boolean; numPredict?: number; timeoutMs?: number; numCtx?: number; temperature?: number },
): Promise<string> {
  const stop = toolAbort.getStore();
  if (stop?.aborted) throw new Error("Detenido");
  const signals = [AbortSignal.timeout(opts?.timeoutMs ?? 45_000)];
  if (stop) signals.push(stop);
  let res: Response;
  try {
    res = await fetch(`${HOST()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL(),
        messages,
        stream: false,
        keep_alive: "10m",
        format: opts?.json ? "json" : undefined,
        options: {
          temperature: opts?.temperature ?? (opts?.json ? 0.2 : 0.3),
          num_predict: opts?.numPredict ?? 220,
          num_ctx: opts?.numCtx ?? 2048,
        },
      }),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (stop?.aborted || (err instanceof Error && err.name === "AbortError" && stop?.aborted)) {
      throw new Error("Detenido");
    }
    throw err;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama no respondió (${res.status}). ¿Está encendido? ${text.slice(0, 180)}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content?.trim();
  if (!content) throw new Error("Ollama devolvió una respuesta vacía.");
  return content;
}

export function parseJsonBlock<T>(raw: string): T {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const slice = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  return JSON.parse(slice) as T;
}
