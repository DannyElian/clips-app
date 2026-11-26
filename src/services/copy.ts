import { ollamaChat, parseJsonBlock } from "./ollama.js";

export type ClipMood =
  | "meme"
  | "info"
  | "comedia"
  | "fail"
  | "clutch"
  | "rabia"
  | "hype"
  | "reaccion";

export interface SocialCopy {
  title: string;
  caption: string;
  overlay: string;
  mood: ClipMood;
}

const LINES: Array<{ mood: ClipMood; overlay: string; body: string }> = [
  { mood: "meme", overlay: "ES EL MEME", body: "Este es el momento meme del video. Se entiende en cuanto lo ves." },
  { mood: "meme", overlay: "NO PUEDE SER", body: "Pasa algo tan raro que hay que verlo otra vez." },
  { mood: "meme", overlay: "MIRA ESTO", body: "Un corte corto. La gracia está en lo que pasa en pantalla." },
  { mood: "meme", overlay: "SE PASÓ", body: "Se le fue de las manos. Por eso este recorte es el meme." },
  { mood: "meme", overlay: "BRO QUÉ", body: "La reacción no cuadra con lo que pasa, y por eso funciona." },
  { mood: "meme", overlay: "QUÉ ES ESO", body: "Nadie se lo espera. El clip es esa sorpresa." },
  { mood: "meme", overlay: "ESTÁ MAL", body: "Está tan mal hecho que se vuelve el mejor momento." },
  { mood: "meme", overlay: "SIN CONTEXTO", body: "No hace falta saber qué pasó antes. El clip se basta solo." },
  { mood: "meme", overlay: "OTRA VEZ", body: "Vuelve a pasar y sigue sin tener explicación." },
  { mood: "meme", overlay: "AL GRUPO", body: "Este es el recorte que se manda al grupo sin decir nada." },
  { mood: "info", overlay: "EL DATO", body: "Este clip deja una idea clara. La frase de arriba es el resumen." },
  { mood: "info", overlay: "ASÍ ES", body: "En pocos segundos se dice lo importante. No hace falta más texto." },
  { mood: "info", overlay: "EN CORTO", body: "La información va directa. Mira el clip y lee la frase." },
  { mood: "info", overlay: "PON ATENCIÓN", body: "Aquí está el punto que hay que pillar. Dura un momento." },
  { mood: "info", overlay: "LO IMPORTANTE", body: "Solo queda lo que importa. El resto del video no entra." },
  { mood: "info", overlay: "ENTIÉNDELO", body: "Se explica solo si ves este tramo. La frase lo resume." },
  { mood: "info", overlay: "TOMA NOTA", body: "Un dato concreto, dicho en el momento justo del video." },
  { mood: "info", overlay: "LA CLAVE", body: "Esta parte es la clave. El clip se queda ahí." },
  { mood: "comedia", overlay: "QUÉ GRACIA", body: "Este clip es de risa. El chiste se ve sin explicar demasiado." },
  { mood: "comedia", overlay: "SE RÍE SOLO", body: "La risa es el momento. Por eso está este recorte." },
  { mood: "comedia", overlay: "NO ERA TANTO", body: "Empieza normal y se vuelve cómico. Ese es el clip." },
  { mood: "comedia", overlay: "ME QUEBRÉ", body: "El chiste llega de golpe. Hay que ver la cara." },
  { mood: "comedia", overlay: "JAJA NO", body: "Se ríe de lo que acaba de pasar. El audio lo dice todo." },
  { mood: "comedia", overlay: "QUÉ CHISTE", body: "Un chiste corto, en el segundo en que cae." },
  { mood: "comedia", overlay: "NO PUEDO", body: "No puede seguir en serio. La risa corta la escena." },
  { mood: "fail", overlay: "EL FAIL", body: "Aquí algo sale mal. El error se ve completo en el clip." },
  { mood: "fail", overlay: "CASI LO LOGRA", body: "Iba bien y se le escapa al final. Ese es el fail." },
  { mood: "fail", overlay: "SE CAYÓ", body: "El momento en el que se cae todo. Se entiende al verlo." },
  { mood: "fail", overlay: "SE FUE TODO", body: "Se desarma en un segundo. El clip enseña el error." },
  { mood: "fail", overlay: "NI MODO", body: "No había forma de salvarlo. El fail queda claro." },
  { mood: "fail", overlay: "AQUÍ ACABÓ", body: "Hasta aquí llegó. El final del intento es el clip." },
  { mood: "fail", overlay: "MALA IDEA", body: "La idea parecía buena y sale mal en este tramo." },
  { mood: "clutch", overlay: "EL CLUTCH", body: "Cuando ya parecía perdido, lo saca. Esa jugada es el clip." },
  { mood: "clutch", overlay: "CÓMO LO HIZO", body: "Una jugada difícil, en el momento justo." },
  { mood: "clutch", overlay: "LO SACÓ", body: "El clip es esa jugada que cambia el momento." },
  { mood: "clutch", overlay: "IMPOSIBLE", body: "No debía salir y sale. Por eso vale el recorte." },
  { mood: "clutch", overlay: "1 CONTRA TODO", body: "Se queda solo y aun así lo resuelve." },
  { mood: "clutch", overlay: "SIN DERECHO", body: "No tenía cómo ganarlo y lo gana igual." },
  { mood: "rabia", overlay: "SE ENOJÓ", body: "Se le acaba la paciencia. El clip es esa reacción." },
  { mood: "rabia", overlay: "YA BASTA", body: "El enojo se nota. No hace falta contar más." },
  { mood: "rabia", overlay: "ESTO NO", body: "La rabia es lo que hay que ver en este corte." },
  { mood: "rabia", overlay: "NO LO AGUANTA", body: "Llega al límite y se le ve. Ese es el momento." },
  { mood: "rabia", overlay: "SE QUEBRÓ", body: "Se le rompe la calma. El clip empieza justo ahí." },
  { mood: "hype", overlay: "EL MOMENTO", body: "Este es el punto más fuerte del video. Por eso está recortado." },
  { mood: "hype", overlay: "SE PUSO BUENO", body: "Aquí sube la energía. El clip se queda en esa parte." },
  { mood: "hype", overlay: "ESO ES TODO", body: "El mejor segundo del video, sin relleno." },
  { mood: "hype", overlay: "NO PARES", body: "La escena no baja. Este tramo es el que engancha." },
  { mood: "hype", overlay: "AHÍ ESTÁ", body: "El instante que estabas esperando acaba de pasar." },
  { mood: "hype", overlay: "VAMOS", body: "Sube el ritmo y el clip se queda con esa subida." },
  { mood: "hype", overlay: "PARA EL SCROLL", body: "Este segundo es el que frena el dedo. Mira por qué." },
  { mood: "hype", overlay: "SE PRENDIÓ", body: "De un momento a otro se pone intenso. Aquí empieza." },
  { mood: "reaccion", overlay: "MIRA SU CARA", body: "La reacción dice más que la jugada. Mira la cara." },
  { mood: "reaccion", overlay: "NO LO ESPERABA", body: "Le sorprende lo que pasa. Esa cara es el clip." },
  { mood: "reaccion", overlay: "QUÉ FUE ESO", body: "La reacción es inmediata. Se entiende sin contexto." },
  { mood: "reaccion", overlay: "SE QUEDÓ ASÍ", body: "Se queda congelado. La cara cuenta lo que pasó." },
  { mood: "reaccion", overlay: "LA CARA", body: "No hace falta oír la explicación. La cara lo dice." },
  { mood: "reaccion", overlay: "ESPERA QUÉ", body: "Tarda un segundo en entenderlo. Ese silencio es el clip." },
  { mood: "reaccion", overlay: "SIN PALABRAS", body: "No dice nada y aun así se entiende la reacción." },
  { mood: "meme", overlay: "CLIP DEL DÍA", body: "De todo el video, este es el corte que se queda." },
  { mood: "comedia", overlay: "ME MATÓ", body: "El chiste pega de verdad. Vale la pena el recorte." },
  { mood: "fail", overlay: "ERROR CLÁSICO", body: "El error de siempre, justo cuando parecía fácil." },
  { mood: "info", overlay: "OJO AQUÍ", body: "Fíjate en este detalle. Es lo único que hay que ver." },
  { mood: "hype", overlay: "EL RECORTE", body: "Saqué solo esta parte porque aquí pasa lo bueno." },
  { mood: "reaccion", overlay: "MIRA LA CARA", body: "Antes de la jugada, mira cómo reacciona." },
  { mood: "clutch", overlay: "EN EL ÚLTIMO", body: "Lo define en el último segundo. Ese es el clip." },
  { mood: "rabia", overlay: "LA ROMPIÓ", body: "Se le acaba y lo suelta. La rabia queda en cámara." },
  { mood: "meme", overlay: "Y ESTO QUÉ", body: "Aparece de la nada. No hay forma de anticiparlo." },
  { mood: "comedia", overlay: "RISA REAL", body: "No está actuando. La risa se le escapa sola." },
];

const MOOD_LABEL: Record<ClipMood, string> = {
  meme: "meme",
  info: "información",
  comedia: "comedia",
  fail: "fail",
  clutch: "clutch",
  rabia: "rabia",
  hype: "hype",
  reaccion: "reacción",
};

export function moodLabel(mood: ClipMood | string | undefined): string {
  if (!mood) return "";
  return MOOD_LABEL[mood as ClipMood] || mood;
}

function pick<T>(list: T[], index: number): T {
  return list[((index % list.length) + list.length) % list.length]!;
}

function normalizeSpeech(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/["“”«»]/g, "")
    .replace(/\b(eh+|um+|uh+|este+|eee+|mmm+|pues|o sea|tipo)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeSpeech(text: string): boolean {
  const s = normalizeSpeech(text);
  if (s.length < 16) return false;
  const letters = s.replace(/[^a-záéíóúüñ]/gi, "");
  if (letters.length < 12) return false;
  const vowels = (letters.match(/[aeiouáéíóúü]/gi) || []).length;
  if (vowels / letters.length < 0.28) return false;
  const words = s.toLowerCase().split(/\s+/).filter(Boolean);
  const unique = new Set(words);
  if (words.length >= 6 && unique.size < words.length * 0.35) return false;
  return true;
}

function splitSentences(text: string): string[] {
  const s = normalizeSpeech(text);
  if (!s) return [];
  return s
    .split(/(?<=[.!?…])\s+|;\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 12 && x.length <= 160)
    .map((x) => {
      let t = x.replace(/^[a-zàáéíóúñ]/, (c) => c.toUpperCase());
      if (!/[.!?…]$/.test(t)) t += ".";
      return t;
    });
}

function spokenLine(text: string): string | undefined {
  if (!looksLikeSpeech(text)) return undefined;
  const sents = splitSentences(text).filter((s) => {
    const words = s.replace(/[.!?…]/g, "").split(" ").filter(Boolean);
    return words.length >= 4 && words.length <= 22;
  });
  if (sents.length) return sents.sort((a, b) => b.length - a.length)[0];
  const words = normalizeSpeech(text).split(" ").filter(Boolean);
  if (words.length < 4) return undefined;
  let line = words.slice(0, 16).join(" ");
  line = line.replace(/^[a-zàáéíóúñ]/, (c) => c.toUpperCase());
  if (!/[.!?…]$/.test(line)) line += ".";
  return line;
}

function overlayFromLine(line: string): string {
  const words = line.replace(/[.!?…]/g, "").split(" ").filter(Boolean);
  const short = words.length > 6 ? words.slice(0, 6) : words;
  return short.join(" ").toUpperCase();
}

function wrapOverlay(raw: string): string {
  const s = raw.replace(/\s+/g, " ").trim();
  if (s.length <= 18) return s;
  const words = s.split(" ");
  const mid = Math.ceil(words.length / 2);
  return `${words.slice(0, mid).join(" ")}\n${words.slice(mid).join(" ")}`;
}

function titleFromOverlay(overlay: string): string {
  const one = overlay.replace(/\n/g, " ").toLowerCase();
  return one.replace(/(^|\s)\S/g, (c) => c.toUpperCase()).trim();
}

function gameTags(sourceName?: string, sourceUrl?: string): string[] {
  const blob = `${sourceName || ""} ${sourceUrl || ""}`.toLowerCase();
  const extra: string[] = ["#fyp", "#parati"];
  if (/\bgta\b|gtav|gta5|gta_/.test(blob)) extra.push("#GTA", "#GTA5");
  else if (/fortnite/.test(blob)) extra.push("#Fortnite");
  else if (/valorant/.test(blob)) extra.push("#Valorant");
  else if (/warzone/.test(blob)) extra.push("#Warzone");
  else if (/minecraft/.test(blob)) extra.push("#Minecraft");
  extra.push("#CLIPS");
  return [...new Set(extra)];
}

function moodFromSpeech(text: string): ClipMood {
  const t = text.toLowerCase();
  if (/\b(jaja+|jeje+|lol|lmao|risa|gracios|meme|chiste)\b/.test(t)) return "comedia";
  if (/\b(fail|caí|cai|cayó|cayo|perdí|perdi|error|mierda)\b/.test(t)) return "fail";
  if (/\b(clutch|gané|gane|lo saqué|lo saque|imposible)\b/.test(t)) return "clutch";
  if (/\b(odio|rabia|enoj|puta|joder|carajo|tilt)\b/.test(t)) return "rabia";
  if (/\b(vamos|dios|loco|increíble|increible)\b/.test(t)) return "hype";
  if (/\b(mira su cara|no me lo creo|qué fue eso|que fue eso)\b/.test(t)) return "reaccion";
  return "info";
}

function moodTags(mood: ClipMood): string[] {
  if (mood === "meme") return ["#meme"];
  if (mood === "info") return ["#datos"];
  if (mood === "comedia") return ["#comedia"];
  if (mood === "fail") return ["#fail"];
  if (mood === "clutch") return ["#clutch"];
  if (mood === "rabia") return ["#rage"];
  if (mood === "hype") return ["#highlight"];
  return ["#reaccion"];
}

export function buildSocialCopy(opts: {
  index: number;
  total: number;
  transcript?: string;
  hook?: string;
  sourceName?: string;
  sourceUrl?: string;
  reasons?: string[];
}): SocialCopy {
  const i = Math.max(0, opts.index);
  const heard = spokenLine(opts.transcript || "");
  const fallback = pick(LINES, i);
  const overlay = wrapOverlay(heard ? overlayFromLine(heard) : fallback.overlay);
  const title = heard ? heard.replace(/[.!?…]$/, "") : titleFromOverlay(overlay);
  const body = heard || fallback.body;
  const mood = heard ? moodFromSpeech(heard) : fallback.mood;
  const tags = [...moodTags(mood), ...gameTags(opts.sourceName, opts.sourceUrl)].join(" ");
  const caption = `${title}\n\n${body}\n\n${tags}`;
  return { title, caption, overlay, mood };
}

function quietCopy(sourceName?: string, sourceUrl?: string): SocialCopy {
  const tags = gameTags(sourceName, sourceUrl).join(" ");
  return {
    title: "No se entendió el audio",
    overlay: "NO SE\nENTENDIÓ",
    caption: `No se entendió lo que se dice en este tramo.\n\n${tags}`,
    mood: "info",
  };
}

function cleanOverlay(raw: string): string {
  const words = raw
    .replace(/[\n\r]+/g, " ")
    .replace(/[^\p{L}\p{N}\s']/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  if (words.length < 2) return "";
  return wrapOverlay(words.join(" ").toUpperCase());
}

function clipFromModel(
  item: { overlay?: string; title?: string; body?: string } | undefined,
  transcript: string,
  index: number,
  total: number,
  sourceName?: string,
  sourceUrl?: string,
): SocialCopy {
  const fallback = buildSocialCopy({ index, total, transcript, sourceName, sourceUrl });
  const title = String(item?.title || "").replace(/\s+/g, " ").trim().slice(0, 90);
  const body = String(item?.body || "").replace(/\s+/g, " ").trim().slice(0, 400);
  const overlay = cleanOverlay(String(item?.overlay || "")) || cleanOverlay(title);
  if (!overlay || !title || !body) return fallback;
  const tags = [...moodTags(fallback.mood), ...gameTags(sourceName, sourceUrl)].join(" ");
  return { title, overlay, caption: `${title}\n\n${body}\n\n${tags}`, mood: fallback.mood };
}

/** Phrase and description from Ollama, using only the heard words. */
export async function buildSocialCopies(opts: {
  transcripts: string[];
  sourceName?: string;
  sourceUrl?: string;
}): Promise<SocialCopy[]> {
  const total = opts.transcripts.length;
  const out: SocialCopy[] = new Array(total);
  const pending: number[] = [];
  opts.transcripts.forEach((text, i) => {
    if (spokenLine(text)) pending.push(i);
    else out[i] = quietCopy(opts.sourceName, opts.sourceUrl);
  });
  for (let offset = 0; offset < pending.length; offset += 4) {
    const indexes = pending.slice(offset, offset + 4);
    const block = indexes.map((i, n) => `CLIP ${n + 1}:\n${opts.transcripts[i]!.slice(0, 1200)}`).join("\n\n");
    let made: Array<{ overlay?: string; title?: string; body?: string }> = [];
    try {
      const raw = await ollamaChat([
        {
          role: "system",
          content:
            "Escribes la marca de agua y la descripción de clips. Usa solo lo que está en el texto de cada CLIP. No inventes nombres, juegos ni chistes que no estén escritos. overlay: de 2 a 6 palabras en MAYÚSCULAS, nunca vacío. title: una frase corta. body: una o dos frases entendibles, en el idioma de lo dicho. Devuelve JSON con la clave clips y un elemento por CLIP, en el mismo orden. Cada elemento tiene overlay, title y body con texto.",
        },
        { role: "user", content: block },
      ], { json: true });
      const parsed = parseJsonBlock<{ clips?: Array<{ overlay?: string; title?: string; body?: string }> }>(raw);
      made = Array.isArray(parsed.clips) ? parsed.clips : [];
    } catch {
      made = [];
    }
    indexes.forEach((i, n) => {
      out[i] = clipFromModel(made[n], opts.transcripts[i] || "", i, total, opts.sourceName, opts.sourceUrl);
    });
  }
  return out;
}
