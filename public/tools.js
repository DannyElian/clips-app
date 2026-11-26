const root = document.getElementById("view-tools");
const TOOLS = [
  ["transcript", "Transcribir"],
  ["subs", "Subtítulos"],
  ["silence", "Silencios"],
  ["chat", "Chat"],
  ["thumb", "Miniatura"],
  ["translate", "Traducir"],
  ["titles", "Títulos"],
  ["copy", "Descripción"],
];

let source = null;
let videoUrl = "";
let activeId = null;
let activeTimer = 0;
let lastSubCues = [];

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shell() {
  root.innerHTML = `
    <header class="top tight">
      <h1>Herramientas del vídeo.</h1>
      <p class="lede">Cada acción corre sola. El archivo original no se reemplaza.</p>
      <p id="tool-source" class="note"></p>
    </header>
    <main class="grid">
      <section class="panel">
        <form id="tool-open">
          <p class="step">Vídeo completo</p>
          <label class="url-field">
            Enlace (YouTube, Twitch, Kick…)
            <input type="url" id="tool-url" placeholder="https://www.youtube.com/watch?v=…" autocomplete="off" />
          </label>
          <p class="or-split">o suelta un archivo</p>
          <label class="file-drop">
            <input type="file" id="tool-file" accept="video/*,.mp4,.mkv,.mov,.webm" />
            <span class="file-label" id="tool-file-label">O sube un vídeo aquí</span>
          </label>
          <button class="cta" type="submit">Usar este vídeo</button>
        </form>
        <div class="app-nav" id="tool-nav"></div>
        <div id="tool-form"></div>
      </section>
      <section class="panel preview">
        <video id="tool-video" controls playsinline class="hidden"></video>
        <div id="tool-status" class="status idle">Pega un enlace, sube un vídeo o elige un clip con Editar.</div>
        <button type="button" id="tool-stop" class="cta stop hidden">Detener</button>
        <div id="tool-result"></div>
      </section>
    </main>
  `;
  const nav = root.querySelector("#tool-nav");
  for (const [id, label] of TOOLS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-btn";
    btn.textContent = label;
    btn.addEventListener("click", () => drawForm(id));
    nav.appendChild(btn);
  }
  const toolUrl = root.querySelector("#tool-url");
  const toolFile = root.querySelector("#tool-file");
  toolUrl.addEventListener("input", () => {
    if (toolUrl.value.trim()) toolFile.value = "";
  });
  toolFile.addEventListener("change", () => {
    if (toolFile.files?.[0]) {
      toolUrl.value = "";
      root.querySelector("#tool-file-label").textContent = toolFile.files[0].name;
    }
  });
  root.querySelector("#tool-stop").addEventListener("click", () => stopActive());
  root.querySelector("#tool-open").addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = toolUrl.value.trim();
    const file = toolFile.files?.[0];
    if (!url && !file) return setStatus("Pega un enlace o sube un vídeo.");
    if (url) {
      setStatus("Descargando el enlace…");
      await stopActive(true);
      const res = await fetch("/api/tools/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUrl: url }),
      });
      const data = await res.json();
      if (!res.ok) return setStatus(data.error || "No se pudo abrir el enlace");
      activeId = data.id;
      showStop(true);
      pollOpen(data.id);
      return;
    }
    const fd = new FormData();
    fd.set("video", file);
    const res = await fetch("/api/tools/open", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) return setStatus(data.error || "No se pudo abrir");
    useMedia(data);
  });
  drawForm("subs");
}

function useMedia(data) {
  source = { filename: data.filename, filePath: data.filePath, probe: data.probe, frames: data.frames, uploaded: true };
  videoUrl = data.previewUrl || "";
  setStatus(`${data.filename} · ${data.probe.width}×${data.probe.height} · ${data.probe.fps} fps · ${data.probe.codec}`);
  const video = root.querySelector("#tool-video");
  if (video && videoUrl) {
    video.classList.remove("hidden");
    video.src = videoUrl;
  }
  drawForm("subs");
}

function showStop(on) {
  root.querySelector("#tool-stop")?.classList.toggle("hidden", !on);
}

async function stopActive(quiet) {
  const id = activeId;
  activeId = null;
  clearTimeout(activeTimer);
  showStop(false);
  if (!id) return;
  if (!quiet) setStatus("Detenido");
  await fetch(`/api/tools/jobs/${id}/cancel`, { method: "POST" }).catch(() => undefined);
}

async function pollOpen(id) {
  if (activeId !== id) return;
  const res = await fetch(`/api/tools/jobs/${id}`);
  const job = await res.json();
  if (activeId !== id) return;
  if (!res.ok) {
    showStop(false);
    return setStatus(job.error || "No se encontró la descarga");
  }
  if (job.status === "processing" || job.status === "pending") {
    setStatus(job.progress || "Descargando…");
    activeTimer = setTimeout(() => pollOpen(id), 1200);
    return;
  }
  showStop(false);
  activeId = null;
  if (job.status === "error") return setStatus(job.error === "Detenido" ? "Detenido" : job.error || "No se pudo bajar el enlace");
  useMedia(job.result || {});
}

function setStatus(text) {
  const el = root.querySelector("#tool-status");
  if (el) el.textContent = text;
}

function drawForm(id) {
  root.querySelectorAll("#tool-nav .nav-btn").forEach((btn) => {
    btn.classList.toggle("on", btn.textContent === TOOLS.find((t) => t[0] === id)?.[1]);
  });
  const box = root.querySelector("#tool-form");
  const tones = [
    ["divertido", "Divertido · juvenil"],
    ["profesional", "Profesional"],
    ["intrigante", "Intrigante"],
    ["educativo", "Educativo"],
    ["polémico", "Polémico"],
  ]
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");
  const nets = ["TikTok", "YouTube Shorts", "Instagram Reels", "Facebook"]
    .map((t) => `<option>${t}</option>`)
    .join("");
  const langs = ["en:Inglés", "es:Español", "pt:Portugués", "fr:Francés", "it:Italiano", "de:Alemán"]
    .map((pair) => {
      const [code, name] = pair.split(":");
      return `<option value="${code}">${name}</option>`;
    })
    .join("");
  if (id === "transcript") {
    box.innerHTML = `
      <p class="note">Sale como se dice, sin resumir. Si este vídeo ya se transcribió, no vuelve a escucharlo.</p>
      <button type="button" class="cta" id="run">Transcribir</button>`;
  } else if (id === "subs") {
    box.innerHTML = `
      <label>Estilo<select id="sub-style"><option value="frase">Frase con contorno</option><option value="barra">Barra</option><option value="palabra">Palabra resaltada</option></select></label>
      <label>Color<select id="sub-color"><option value="#ffffff">Blanco</option><option value="#ffe14a">Amarillo</option><option value="#7ee7ff">Cian</option><option value="#ff8ad4">Rosa</option></select></label>
      <label>Tamaño<select id="sub-size"><option value="chico">Chico</option><option value="normal" selected>Normal</option><option value="grande">Grande</option></select></label>
      <label>Posición<select id="sub-pos"><option value="bottom">Abajo</option><option value="middle">Centro</option><option value="top">Arriba</option></select></label>
      <p class="note">Se ve así en el reproductor. Al exportar, el vídeo usa el mismo estilo.</p>
      <button type="button" class="cta" id="run">Ver subtítulos</button>
      <button type="button" class="tiktok-btn" id="burn">Exportar con subtítulos</button>`;
  } else if (id === "silence") {
    box.innerHTML = `
      <label>Silencio mínimo (segundos)<input id="sil-min" type="number" min="0.3" max="5" step="0.1" value="0.8" /></label>
      <label>Sensibilidad (dB, más bajo = más estricto)<input id="sil-db" type="number" min="-50" max="-20" value="-35" /></label>
      <button type="button" class="cta" id="run">Ver silencios</button>`;
  } else if (id === "chat") {
    box.innerHTML = `<label>Pregunta<input id="chat-q" placeholder="¿De qué trata este video?" /></label><button type="button" class="cta" id="run">Preguntar</button>`;
  } else if (id === "thumb") {
    box.innerHTML = `
      <label>Segundo<input id="thumb-t" type="number" min="0" step="0.1" value="1" /></label>
      <label>Título<input id="thumb-title" /></label>
      <label>Formato<select id="thumb-fmt"><option value="youtube">YouTube</option><option value="vertical">Vertical</option><option value="jpg">JPG</option></select></label>
      <button type="button" class="cta" id="run">Crear miniatura</button>`;
  } else if (id === "translate") {
    box.innerHTML = `<label>Idioma<select id="lang">${langs}</select></label><button type="button" class="cta" id="run">Traducir</button><button type="button" class="tiktok-btn" id="burn">Exportar con subtítulos</button>`;
  } else if (id === "titles") {
    box.innerHTML = `<p class="note">Ganchos cortos, en español latino. Si el vídeo ya se escuchó, no vuelve a transcribir.</p><label>Tono<select id="tone">${tones}</select></label><label>Red<select id="net">${nets}</select></label><button type="button" class="cta" id="run">Generar títulos</button>`;
  } else {
    box.innerHTML = `<p class="note">La primera frase engancha. Si el vídeo ya se escuchó, solo escribe el texto.</p><label>Tono<select id="tone">${tones}</select></label><label>Red<select id="net">${nets}</select></label><button type="button" class="cta" id="run">Generar descripción</button>`;
  }
  box.querySelector("#run")?.addEventListener("click", () => run(id, false));
  box.querySelector("#burn")?.addEventListener("click", () => run(id, true));
  for (const field of ["sub-style", "sub-pos", "sub-color", "sub-size"]) {
    root.querySelector("#" + field)?.addEventListener("change", () => {
      paintSubLook();
      const video = root.querySelector("#tool-video");
      if (lastSubCues.length && video) previewSubs(video, lastSubCues);
    });
  }
  const label = root.querySelector("#tool-source");
  if (label) {
    label.textContent = source
      ? `${source.title || source.filename} · ${source.start != null ? `${Number(source.start).toFixed(1)}s–${Number(source.end).toFixed(1)}s` : "vídeo"} · ${source.probe ? `${source.probe.width}×${source.probe.height}` : ""}`
      : "Todavía no hay un vídeo cargado.";
  }
}

async function run(id, burn) {
  if (!source?.jobId && !source?.filePath) {
    setStatus("Primero elige un clip o sube un vídeo.");
    return;
  }
  await stopActive(true);
  setStatus("Procesando…");
  const body = { jobId: source.jobId, filename: source.filename, filePath: source.filePath, burn };
  if (id === "subs") {
    body.style = root.querySelector("#sub-style").value;
    body.position = root.querySelector("#sub-pos").value;
    body.color = root.querySelector("#sub-color").value;
    body.size = root.querySelector("#sub-size").value;
  }
  if (id === "silence") {
    body.minSec = Number(root.querySelector("#sil-min").value);
    body.noiseDb = Number(root.querySelector("#sil-db").value);
  }
  if (id === "chat") body.question = root.querySelector("#chat-q").value;
  if (id === "thumb") {
    body.atSec = Number(root.querySelector("#thumb-t").value);
    body.title = root.querySelector("#thumb-title").value;
    body.format = root.querySelector("#thumb-fmt").value;
  }
  if (id === "translate") body.lang = root.querySelector("#lang").value;
  if (id === "titles" || id === "copy") {
    body.tone = root.querySelector("#tone").value;
    body.network = root.querySelector("#net").value;
  }
  const pathName =
    id === "subs" ? "subtitles" : id === "copy" ? "description" : id === "thumb" ? "thumbnail" : id === "titles" ? "titles" : id;
  const res = await fetch(`/api/tools/${pathName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const job = await res.json();
  if (!res.ok) return setStatus(job.error || "Error");
  activeId = job.id;
  showStop(true);
  poll(job.id, id);
}

async function poll(id, tool) {
  if (activeId !== id) return;
  const res = await fetch(`/api/tools/jobs/${id}`);
  const job = await res.json();
  if (activeId !== id) return;
  if (!res.ok) {
    showStop(false);
    return setStatus(job.error || "No se encontró el trabajo");
  }
  if (job.status === "processing" || job.status === "pending") {
    setStatus(job.progress || "Procesando…");
    activeTimer = setTimeout(() => poll(id, tool), 1200);
    return;
  }
  showStop(false);
  activeId = null;
  if (job.status === "error") return setStatus(job.error === "Detenido" ? "Detenido" : job.error || "Error");
  setStatus(job.result?.cached ? "Listo, estaba guardado." : "Listo");
  showResult(tool, job.result);
}

function showResult(tool, result) {
  const box = root.querySelector("#tool-result");
  const video = root.querySelector("#tool-video");
  if (videoUrl) {
    video.classList.remove("hidden");
    video.src = videoUrl;
  }
  if (tool === "transcript") {
    box.innerHTML = `
      <p class="note">${esc(result.language || "")}</p>
      <div class="clip-btns">
        <button type="button" id="copy-text">Copiar</button>
        <button type="button" id="dl-txt">TXT</button>
        <button type="button" id="dl-srt">SRT</button>
        <button type="button" id="dl-vtt">VTT</button>
      </div>
      <textarea class="caption-text" rows="14" readonly></textarea>`;
    box.querySelector("textarea").value = result.text || "";
    box.querySelector("#copy-text").onclick = () => navigator.clipboard.writeText(result.text || "");
    box.querySelector("#dl-txt").onclick = () => download("transcripcion.txt", result.text || "");
    box.querySelector("#dl-srt").onclick = () => download("transcripcion.srt", result.srt || "");
    box.querySelector("#dl-vtt").onclick = () => download("transcripcion.vtt", result.vtt || "");
    return;
  }
  if (tool === "subs" || tool === "translate") {
    const cues = result.cues || result.segments || [];
    box.innerHTML = `
      <p class="note">${esc(result.language || "")} ${result.warnings?.length ? esc(result.warnings.join(" ")) : ""}</p>
      <div class="clip-btns">
        <button type="button" id="dl-srt">SRT</button>
        <button type="button" id="dl-vtt">VTT</button>
        ${result.fileUrl ? `<a href="${esc(result.fileUrl)}" download>Vídeo con subtítulos</a>` : ""}
      </div>
      <div class="cues" id="cues"></div>`;
    const cuesEl = box.querySelector("#cues");
    for (const cue of cues) {
      const row = document.createElement("p");
      row.className = "cue";
      row.innerHTML = `<time>${clock(cue.start)}</time><span></span>`;
      row.querySelector("span").textContent = cue.text;
      row.addEventListener("click", () => {
        if (video) video.currentTime = cue.start;
      });
      cuesEl.appendChild(row);
    }
    previewSubs(video, cues);
    box.querySelector("#dl-srt").onclick = () => download("subtitulos.srt", result.srt);
    box.querySelector("#dl-vtt").onclick = () => download("subtitulos.vtt", result.vtt);
    return;
  }
  if (tool === "silence") {
    if (result.fileUrl) {
      box.innerHTML = `<a href="${esc(result.fileUrl)}" download>Descargar sin esos silencios</a>`;
      return;
    }
    const spans = result.spans || [];
    box.innerHTML = `<p class="note">${spans.length} silencios. Quita la marca de los que quieras conservar.</p><div id="spans"></div><button type="button" class="cta" id="apply">Exportar sin los marcados</button>`;
    const list = box.querySelector("#spans");
    spans.forEach((span, i) => {
      const label = document.createElement("label");
      label.className = "check-line";
      label.innerHTML = `<input type="checkbox" checked data-i="${i}" /> ${clock(span.start)}–${clock(span.end)}`;
      list.appendChild(label);
    });
    box.querySelector("#apply").onclick = async () => {
      const apply = [...list.querySelectorAll("input:checked")].map((input) => spans[Number(input.dataset.i)]);
      source && (await sendSilence(apply));
    };
    return;
  }
  if (tool === "chat") {
    box.innerHTML = (result.history || [])
      .map((msg) => `<p class="note"><strong>${esc(msg.role)}</strong> ${linkTimes(msg.content)}</p>`)
      .join("");
    box.querySelectorAll("[data-t]").forEach((el) => {
      el.addEventListener("click", () => {
        if (video) video.currentTime = Number(el.dataset.t);
      });
    });
    return;
  }
  if (tool === "titles") {
    const titles = Array.isArray(result) ? result : result?.titles || [];
    box.innerHTML = titles
      .map((title) => `<p class="check-line">${esc(title)} <button type="button" class="copy-caption">Copiar</button></p>`)
      .join("");
    [...box.querySelectorAll("p")].forEach((row, i) => {
      row.querySelector("button").onclick = () => navigator.clipboard.writeText(titles[i]);
    });
    return;
  }
  if (tool === "copy") {
    const options = Array.isArray(result) ? result : result?.options || [];
    result = options;
    box.innerHTML = (result || [])
      .map(
        (item) => `<div class="caption-box"><p>${esc(item.description)}</p><p>${esc((item.hashtags || []).join(" "))}</p>
        <button type="button" class="copy-desc">Copiar descripción</button>
        <button type="button" class="copy-tags">Copiar hashtags</button></div>`,
      )
      .join("");
    [...box.querySelectorAll(".caption-box")].forEach((row, i) => {
      row.querySelector(".copy-desc").onclick = () => navigator.clipboard.writeText(result[i].description);
      row.querySelector(".copy-tags").onclick = () => navigator.clipboard.writeText((result[i].hashtags || []).join(" "));
    });
    return;
  }
  if (tool === "thumb" && result.fileUrl) {
    box.innerHTML = `<img alt="Miniatura" src="${esc(result.fileUrl)}" style="max-width:100%" /><p><a href="${esc(result.fileUrl)}" download>Descargar</a></p>`;
  }
}

function subLook() {
  return {
    style: root.querySelector("#sub-style")?.value || "frase",
    pos: root.querySelector("#sub-pos")?.value || "bottom",
    color: root.querySelector("#sub-color")?.value || "#ffffff",
    size: root.querySelector("#sub-size")?.value || "normal",
  };
}

function paintSubLook() {
  const layer = root.querySelector(".live-sub");
  if (!layer) return;
  const look = subLook();
  layer.className = `live-sub pos-${look.pos} look-${look.style} size-${look.size}`;
  layer.style.setProperty("--sub-accent", look.color);
  if (look.style === "barra") {
    layer.style.background = look.color;
    layer.style.color = "#141414";
  } else if (look.style === "palabra") {
    layer.style.background = "transparent";
    layer.style.color = "#fff";
  } else {
    layer.style.background = "transparent";
    layer.style.color = look.color;
  }
}

function previewSubs(video, cues) {
  if (!video) return;
  lastSubCues = cues || [];
  let layer = video.parentElement.querySelector(".live-sub");
  if (!layer) {
    layer = document.createElement("p");
    layer.className = "live-sub";
    video.parentElement.style.position = "relative";
    video.parentElement.appendChild(layer);
  }
  paintSubLook();
  video.ontimeupdate = () => {
    const now = video.currentTime;
    const cue = lastSubCues.find((item) => now >= item.start && now <= item.end);
    const look = subLook();
    paintSubLook();
    if (!cue) {
      layer.textContent = "";
      return;
    }
    if (look.style === "palabra") {
      const words = cue.words?.length ? cue.words : cue.text.split(/\s+/).filter(Boolean).map((word) => ({ word, start: cue.start, end: cue.end }));
      const active = words.findIndex((item) => now >= item.start && now <= item.end);
      layer.innerHTML = words
        .map((item, index) => `<span class="${index === active ? "on" : ""}" style="${index === active ? `background:${look.color}` : ""}">${esc(item.word)}</span>`)
        .join(" ");
    } else {
      layer.textContent = cue.text;
    }
  };
}

function linkTimes(text) {
  return esc(text).replace(/\[(\d{1,2}):(\d{2})\]/g, (_m, m, s) => {
    const t = Number(m) * 60 + Number(s);
    return `<button type="button" data-t="${t}">[${m}:${s}]</button>`;
  });
}

function clock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function download(name, content) {
  const blob = new Blob([content || ""], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function sendSilence(apply) {
  await stopActive(true);
  setStatus("Exportando…");
  const res = await fetch("/api/tools/silence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: source.jobId, filename: source.filename, filePath: source.filePath, apply }),
  });
  const job = await res.json();
  if (!res.ok) return setStatus(job.error || "Error");
  poll(job.id, "silence");
}

window.ClipsTools = {
  async open(clip) {
    window.showClipsView?.("tools");
    source = clip;
    videoUrl = clip.url || "";
    const res = await fetch("/api/tools/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: clip.jobId, filename: clip.filename }),
    });
    const data = await res.json();
    if (!res.ok) return setStatus(data.error || "No se pudo abrir el clip");
    source = { ...clip, probe: data.probe, frames: data.frames };
    setStatus(`${data.probe.width}×${data.probe.height} · ${data.probe.fps} fps · ${data.probe.codec}. El mp4 original no se toca.`);
    const video = root.querySelector("#tool-video");
    if (video && videoUrl) {
      video.classList.remove("hidden");
      video.src = videoUrl;
    }
    drawForm("subs");
  },
};

shell();
