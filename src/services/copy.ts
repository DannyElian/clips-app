export type ClipMood = "comedia" | "fail" | "clutch" | "rabia" | "hype" | "reaccion";

export interface SocialCopy {
  title: string;
  caption: string;
  overlay: string;
  mood: ClipMood;
}

const OVERLAY: Record<ClipMood, string[]> = {
  comedia: [
    "SE ESTÁ RINDO SOLO",
    "NO ERA PARA TANTO",
    "BRO SE FUE",
    "EL CLIP DEL DÍA",
    "MIRA NADA MÁS",
    "ESTO NO ES NORMAL",
  ],
  fail: [
    "AQUÍ SE ACABÓ",
    "Y SE CAYÓ",
    "EL FAIL",
    "NO LO IBA A LOGRAR",
    "SE FUE TODO",
    "NI MODO",
  ],
  clutch: [
    "CÓMO LO HIZO",
    "1 CONTRA TODO",
    "IMPOSIBLE",
    "NO TENÍA DERECHO",
    "EL CLUTCH",
    "LO SACÓ",
  ],
  rabia: [
    "SE ENOJÓ",
    "NO LO AGUANTA",
    "YA BASTA",
    "SE QUEBRÓ",
    "LA ROMPIÓ",
    "ESTO NO",
  ],
  hype: [
    "VAMOS VAMOS",
    "EL MOMENTO",
    "AHÍ ESTÁ",
    "SE PUSO BUENO",
    "NO PARES",
    "ESO ES TODO",
  ],
  reaccion: [
    "LA CARA LO DICE",
    "NO LO ESPERABA",
    "ESPERA",
    "MIRA SU CARA",
    "QUÉ FUE ESO",
    "SE QUEDÓ ASÍ",
  ],
};

const TITLES: Record<ClipMood, string[]> = {
  comedia: [
    "Esto no era un clip… hasta que pasó esto",
    "Me reí más de lo que debería",
    "El momento random que pega más que el clutch",
    "Nadie pidió este clip y aquí está",
  ],
  fail: [
    "Iba perfecto… hasta que no",
    "El fail que duele ver",
    "Casi lo logra. Casi.",
    "Así se tira una partida en 3 segundos",
  ],
  clutch: [
    "No tenía derecho a ganar esto",
    "El clutch que no iba a pasar",
    "Uno contra todos y aún así",
    "Guárdalo. Este sí vale",
  ],
  rabia: [
    "Cuando el juego se pasa de listo",
    "Se le acabó la paciencia",
    "El tilt en tiempo real",
    "No lo iba a aguantar",
  ],
  hype: [
    "El momento que para el scroll",
    "Aquí se pone bueno de verdad",
    "Míralo otra vez, pega igual",
    "Este es el recorte del VOD",
  ],
  reaccion: [
    "La cara lo dice todo",
    "No se lo esperaba ni él",
    "Reacción honesta. Sin acting.",
    "Mira nada más esa cara",
  ],
};

const BODIES: Record<ClipMood, string[]> = {
  comedia: [
    "Comedia pura. Si no te saca una risa, rebobina.",
    "No es el highlight más épico. Es el más gracioso.",
    "De esos clips que mandas al grupo y listo.",
  ],
  fail: [
    "Fail limpio. Duele, pero se ve.",
    "Iba bien y se desarmó solo. Clásico.",
    "El tipo de error que no se puede explicar.",
  ],
  clutch: [
    "Jugada sucia, justa y perfecta.",
    "Cuando ya nadie creía y lo saca igual.",
    "Ese segundo en el que cambia todo.",
  ],
  rabia: [
    "Tilt con audio. No hace falta contexto.",
    "La rabia se escucha. El clip se entiende.",
    "Cuando el juego te gana la cabeza.",
  ],
  hype: [
    "Energía alta. El recorte que para el feed.",
    "Pega porque se siente en vivo.",
    "Sin relleno. Solo el momento.",
  ],
  reaccion: [
    "La reacción vale más que la jugada.",
    "No actúa. Se le ve en la cara.",
    "Cam + momento. Eso es el clip.",
  ],
};

function pick<T>(list: T[], index: number): T {
  return list[((index % list.length) + list.length) % list.length]!;
}

function cleanSpeech(text: string): string {
  let s = text
    .replace(/\s+/g, " ")
    .replace(/["“”«»]/g, "")
    .replace(/\b(eh|um|uh|este|eee+|mmm+)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  s = s.replace(/^[a-zàáéíóúñ]/, (c) => c.toUpperCase());
  if (!/[.!?…]$/.test(s)) s += ".";
  return s;
}

function usableQuote(text: string): string | undefined {
  const raw = cleanSpeech(text);
  if (!raw) return undefined;
  const words = raw.replace(/[.!?…]/g, "").split(" ").filter(Boolean);
  if (words.length < 4 || words.length > 16) return undefined;
  const letters = raw.replace(/[^a-záéíóúüñ]/gi, "");
  if (letters.length < 12) return undefined;
  const vowels = (letters.match(/[aeiouáéíóúü]/gi) || []).length;
  if (vowels / letters.length < 0.28) return undefined;
  return raw.replace(/\.$/, "");
}

function detectMood(transcript: string, reasons: string[]): ClipMood {
  const t = (transcript || "").toLowerCase();
  const laugh =
    /\b(jaja+|jeje+|lol|lmao|me rio|me río|risa|gracioso|comedia|meme)\b/.test(t) ||
    /\b(bro|hermano|imbecil|imbécil|idiota|tonto)\b/.test(t);
  const fail = /\b(fail|ca[ií]|me muero|se cayo|se cayó|crash|perdi|perdí|nooo+)\b/.test(t);
  const clutch =
    /\b(clutch|ace|1v|gano|gané|lo saque|lo saqué|imposible|ultimo|último)\b/.test(t);
  const rage = /\b(puta|mierda|odio|rabia|enojo|enoj|carajo|joder|tilt)\b/.test(t);
  const hype = /\b(vamos|vamosss|loco|dios|madre|lets go|let's go|increible|increíble)\b/.test(t);

  if (rage) return "rabia";
  if (laugh) return "comedia";
  if (fail) return "fail";
  if (clutch) return "clutch";
  if (hype) return "hype";
  if (reasons.includes("audio-energy") && reasons.includes("scene-change")) return "hype";
  if (reasons.includes("audio-energy")) return "reaccion";
  return "comedia";
}

function gameTags(sourceName?: string, sourceUrl?: string): string[] {
  const blob = `${sourceName || ""} ${sourceUrl || ""}`.toLowerCase();
  const extra: string[] = ["#fyp", "#parati", "#viral"];
  if (/\bgta\b|gtav|gta5|gta_/.test(blob)) extra.push("#GTA", "#GTA5", "#roleplay");
  else if (/fortnite/.test(blob)) extra.push("#Fortnite");
  else if (/valorant/.test(blob)) extra.push("#Valorant");
  else if (/warzone/.test(blob)) extra.push("#Warzone");
  else if (/minecraft/.test(blob)) extra.push("#Minecraft");
  else extra.push("#gaming", "#clips");
  extra.push("#Clips_GTA");
  return [...new Set(extra)];
}

function moodTags(mood: ClipMood): string[] {
  if (mood === "comedia") return ["#comedia", "#funny"];
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
  const mood = detectMood(`${opts.transcript || ""} ${opts.hook || ""}`, opts.reasons || []);
  const quote = usableQuote(opts.transcript || "") || usableQuote(opts.hook || "");
  const overlay = pick(OVERLAY[mood], i);
  const title = pick(TITLES[mood], i);
  const body = pick(BODIES[mood], i);
  const tags = [...moodTags(mood), ...gameTags(opts.sourceName, opts.sourceUrl)].join(" ");
  const caption = quote
    ? `${title}\n\n${body}\n“${quote}”\n\n${tags}`
    : `${title}\n\n${body}\n\n${tags}`;
  return { title, caption, overlay, mood };
}
