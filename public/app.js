const form = document.getElementById("job-form");
const drop = document.getElementById("drop");
const videoInput = document.getElementById("video");
const videoA = document.getElementById("videoA");
const videoB = document.getElementById("videoB");
const dropA = document.getElementById("drop-a");
const dropB = document.getElementById("drop-b");
const fileLabelA = document.getElementById("file-label-a");
const fileLabelB = document.getElementById("file-label-b");
const pairSource = document.getElementById("pair-source");
const singleSource = document.getElementById("single-source");
const cutPanel = document.getElementById("cut-panel");
const urlInput = document.getElementById("sourceUrl");
const urlA = document.getElementById("sourceUrlA");
const urlB = document.getElementById("sourceUrlB");
const fileLabel = document.getElementById("file-label");
const customWebcam = document.getElementById("custom-webcam");
const submitBtn = document.getElementById("submit");
const cancelBtn = document.getElementById("cancel");
const statusEl = document.getElementById("status");
const metaEl = document.getElementById("meta");
const clipsEl = document.getElementById("clips");
const durationInput = document.getElementById("clipDurationSec");
const durationChips = document.getElementById("duration-chips");
const liveMode = document.getElementById("liveMode");
const livePanel = document.getElementById("live-panel");
const liveInput = document.getElementById("liveLastMinutes");
const liveChips = document.getElementById("live-chips");
const tiktokLabel = document.getElementById("tiktok-label");
const tiktokConnect = document.getElementById("tiktok-connect");
const tiktokDisconnect = document.getElementById("tiktok-disconnect");

let tiktokConnected = false;

async function refreshTikTok() {
  try {
    const res = await fetch("/api/tiktok/status");
    const data = await res.json();
    tiktokConnected = Boolean(data.connected);
    if (!data.configured) {
      tiktokLabel.textContent = "TikTok: falta .env";
      tiktokConnect.classList.add("hidden");
      tiktokDisconnect.classList.add("hidden");
      return;
    }
    if (data.connected) {
      tiktokLabel.textContent = data.displayName
        ? `TikTok: @${data.displayName}`
        : "TikTok conectado";
      tiktokConnect.classList.add("hidden");
      tiktokDisconnect.classList.remove("hidden");
    } else {
      tiktokLabel.textContent = "TikTok: no conectado";
      tiktokConnect.classList.remove("hidden");
      tiktokDisconnect.classList.add("hidden");
    }
  } catch {
    tiktokLabel.textContent = "TikTok: sin servidor";
  }
}

tiktokConnect?.addEventListener("click", () => {
  window.location.href = "/api/tiktok/login";
});

tiktokDisconnect?.addEventListener("click", async () => {
  await fetch("/api/tiktok/logout", { method: "POST" });
  await refreshTikTok();
});

const DEFAULT_LABEL = "Suelta un vídeo o haz clic para elegir";
const VIDEO_EXT = /\.(mp4|mkv|mov|webm|avi|m4v)$/i;
const URL_LIKE = /^(https?:\/\/|www\.)/i;

const REASON_ES = {
  "audio-energy": "energía de audio",
  "scene-change": "cambio de escena",
  "even-spacing-fallback": "espaciado uniforme",
  split: "recorte uniforme",
};

let pollTimer = null;
let submitting = false;
let currentJobId = null;
let lastJobId = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setBusy(on) {
  submitting = on;
  cancelBtn.classList.toggle("hidden", !on);
  cancelBtn.disabled = !on;
  syncSubmit();
}

function isVideoFile(file) {
  if (!file) return false;
  if (file.type?.startsWith("video/")) return true;
  return VIDEO_EXT.test(file.name || "");
}

function looksLikeUrl(value) {
  return typeof value === "string" && URL_LIKE.test(value.trim());
}

function sourceUrl() {
  return (urlInput.value || "").trim();
}

function translateReasons(reasons) {
  return (reasons || []).map((r) => REASON_ES[r] || r);
}

function isPairMode() {
  return form.querySelector('input[name="sourceMode"]:checked')?.value === "pair";
}

function syncSourceMode() {
  const pair = isPairMode();
  pairSource?.classList.toggle("hidden", !pair);
  singleSource?.classList.toggle("hidden", pair);
  cutPanel?.classList.toggle("hidden", pair);
  if (videoInput) videoInput.disabled = pair;
  if (urlInput) urlInput.disabled = pair;
  if (videoA) videoA.disabled = !pair;
  if (videoB) videoB.disabled = !pair;
  if (urlA) urlA.disabled = !pair;
  if (urlB) urlB.disabled = !pair;
  document.querySelectorAll('input[name="layout"]').forEach((el) => {
    el.disabled = pair;
  });
  syncSubmit();
}

function syncSubmit() {
  if (submitting) {
    submitBtn.disabled = true;
    return;
  }
  if (isPairMode()) {
    const aOk = isVideoFile(videoA?.files?.[0]) || looksLikeUrl((urlA?.value || "").trim());
    const bOk = isVideoFile(videoB?.files?.[0]) || looksLikeUrl((urlB?.value || "").trim());
    submitBtn.disabled = !(aOk && bOk);
    return;
  }
  submitBtn.disabled = !(isVideoFile(videoInput.files?.[0]) || looksLikeUrl(sourceUrl()));
}

function setChosenFile(file) {
  if (!file) {
    videoInput.value = "";
    fileLabel.textContent = DEFAULT_LABEL;
    syncSubmit();
    return false;
  }
  if (!isVideoFile(file)) {
    videoInput.value = "";
    fileLabel.textContent = DEFAULT_LABEL;
    setStatus("error", "Ese archivo no es un vídeo. Usa mp4, mkv, mov o webm, o pega un enlace.");
    syncSubmit();
    return false;
  }
  const dt = new DataTransfer();
  dt.items.add(file);
  videoInput.files = dt.files;
  fileLabel.textContent = file.name;
  setStatus("idle", "Vídeo listo. Puedes exportar.");
  syncSubmit();
  return true;
}

function syncDurationChips() {
  const sec = Number(durationInput.value);
  durationChips.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("on", Number(btn.dataset.sec) === sec);
  });
}

function syncLive() {
  livePanel.classList.toggle("hidden", !liveMode.checked);
  const min = Number(liveInput.value);
  liveChips.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("on", Number(btn.dataset.min) === min);
  });
}

form.querySelectorAll('input[name="webcamPreset"]').forEach((el) => {
  el.addEventListener("change", () => {
    if (el.checked) {
      customWebcam.classList.toggle("hidden", el.value !== "custom");
    }
  });
});

form.addEventListener("change", (e) => {
  if (e.target.name === "webcamPreset") {
    const preset = form.querySelector('input[name="webcamPreset"]:checked')?.value;
    customWebcam.classList.toggle("hidden", preset !== "custom");
  }
  if (e.target.name === "layout") syncLayout();
  if (e.target.name === "liveMode") syncLive();
  if (e.target.name === "sourceMode") syncSourceMode();
  if (e.target.name === "clipPickMode") syncPickMode();
  if (e.target.id === "burnSubs") syncSubStyle();
});

function syncSubStyle() {
  document.getElementById("sub-style-row")?.classList.toggle("hidden", !document.getElementById("burnSubs")?.checked);
}
syncSubStyle();

function pickMode() {
  return form.querySelector('input[name="clipPickMode"]:checked')?.value || "highlights";
}

function syncPickMode() {
  const mode = pickMode();
  const highlights = mode === "highlights";
  const full = mode === "full";
  const note = document.getElementById("pick-note");
  const audioKnob = document.getElementById("audio-knob");
  const pairHl = document.getElementById("pair-highlight-fs");
  const subsText = document.getElementById("burn-subs-text");
  if (note) {
    note.textContent = full
      ? "Descarga el vídeo entero con el recorte, la calidad, la frase y los subtítulos que elijas. Después puedes editarlo con las mismas herramientas de los clips. En un vídeo largo tarda más."
      : highlights
        ? "Recorre el vídeo entero y se queda con los momentos de más energía / cambios de escena."
        : "Corta el vídeo en N trozos de la duración elegida, seguidos, sin buscar picos.";
  }
  if (subsText) subsText.textContent = full ? "Traer el vídeo con subtítulos" : "Traer los clips con subtítulos";
  audioKnob?.classList.toggle("hidden", !highlights);
  pairHl?.classList.toggle("hidden", !highlights);
  document.getElementById("duration-note")?.classList.toggle("hidden", full);
  document.getElementById("duration-row")?.classList.toggle("hidden", full);
  document.getElementById("max-clips-knob")?.classList.toggle("hidden", full);
  submitBtn.textContent = full ? "Exportar el vídeo completo" : highlights ? "Buscar highlights y exportar" : "Partir y exportar";
}

function syncLayout() {
  const layout = form.querySelector('input[name="layout"]:checked')?.value || "dual";
  const camPanel = document.getElementById("cam-panel");
  const note = document.getElementById("layout-note");
  const isFull = layout === "full";
  if (camPanel) camPanel.classList.toggle("hidden", isFull);
  if (note) {
    note.textContent = isFull
      ? "Pantalla completa: el clip es el vídeo entero, sin partir cámara y juego. La calidad elegida se usa al descargar y al exportar."
      : "En modo dividido, da igual dónde esté la cam: la detectamos y la ponemos arriba, con el juego abajo.";
  }
}

["dragenter", "dragover"].forEach((evt) => {
  drop.addEventListener(evt, (e) => {
    e.preventDefault();
    drop.classList.add("drag");
  });
});
["dragleave", "drop"].forEach((evt) => {
  drop.addEventListener(evt, (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
  });
});
drop.addEventListener("drop", (e) => {
  const uri = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
  if (looksLikeUrl(uri) && !e.dataTransfer?.files?.[0]) {
    urlInput.value = uri.trim();
    setStatus("idle", "Enlace listo. Puedes exportar.");
    syncSubmit();
    return;
  }
  const file = e.dataTransfer?.files?.[0];
  if (file) setChosenFile(file);
});
function bindFileDrop(dropEl, inputEl, labelEl, emptyText, urlField) {
  if (!dropEl || !inputEl) return;
  ["dragenter", "dragover"].forEach((evt) => {
    dropEl.addEventListener(evt, (e) => {
      e.preventDefault();
      dropEl.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    dropEl.addEventListener(evt, (e) => {
      e.preventDefault();
      dropEl.classList.remove("drag");
    });
  });
  dropEl.addEventListener("drop", (e) => {
    const uri = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
    if (urlField && looksLikeUrl(uri) && !e.dataTransfer?.files?.[0]) {
      urlField.value = uri.trim();
      setStatus("idle", "Enlace listo.");
      syncSubmit();
      return;
    }
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!isVideoFile(file)) {
      setStatus("error", "Ese archivo no es un vídeo.");
      return;
    }
    const dt = new DataTransfer();
    dt.items.add(file);
    inputEl.files = dt.files;
    labelEl.textContent = file.name;
    setStatus("idle", "Vídeo listo.");
    syncSubmit();
  });
  inputEl.addEventListener("change", () => {
    const file = inputEl.files?.[0];
    labelEl.textContent = file && isVideoFile(file) ? file.name : emptyText;
    syncSubmit();
  });
}

bindFileDrop(dropA, videoA, fileLabelA, "Archivo 1", urlA);
bindFileDrop(dropB, videoB, fileLabelB, "Archivo 2", urlB);

videoInput.addEventListener("change", () => {
  const file = videoInput.files?.[0];
  if (!file) {
    fileLabel.textContent = DEFAULT_LABEL;
    syncSubmit();
    return;
  }
  setChosenFile(file);
});
urlInput.addEventListener("input", () => {
  if (looksLikeUrl(sourceUrl())) {
    setStatus("idle", "Enlace listo. Puedes exportar.");
  }
  syncSubmit();
});
urlA?.addEventListener("input", syncSubmit);
urlB?.addEventListener("input", syncSubmit);

durationChips.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-sec]");
  if (!btn) return;
  durationInput.value = btn.dataset.sec;
  syncDurationChips();
});
durationInput.addEventListener("input", syncDurationChips);

liveChips.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-min]");
  if (!btn) return;
  liveInput.value = btn.dataset.min;
  liveMode.checked = true;
  syncLive();
});
liveInput.addEventListener("input", () => {
  liveMode.checked = true;
  syncLive();
});
liveMode.addEventListener("change", syncLive);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const pair = isPairMode();
  const file = videoInput.files?.[0];
  const url = sourceUrl();
  const hasFile = isVideoFile(file);
  const hasUrl = looksLikeUrl(url);
  const pairUrlA = (urlA?.value || "").trim();
  const pairUrlB = (urlB?.value || "").trim();
  const pairFileA = isVideoFile(videoA?.files?.[0]);
  const pairFileB = isVideoFile(videoB?.files?.[0]);
  if (pair) {
    if ((!pairFileA && !looksLikeUrl(pairUrlA)) || (!pairFileB && !looksLikeUrl(pairUrlB))) {
      setStatus("error", "En 2 vídeos hace falta un enlace o archivo en cada lado.");
      return;
    }
  } else if (!hasFile && !hasUrl) {
    setStatus("error", "Pega un enlace o sube un archivo.");
    return;
  }

  const duration = Number(durationInput.value);
  if (!Number.isFinite(duration) || duration < 5 || duration > 180) {
    setStatus("error", "La duración de cada clip debe estar entre 5 y 180 segundos.");
    return;
  }

  if (liveMode.checked) {
    const mins = Number(liveInput.value);
    if (!Number.isFinite(mins) || mins < 1 || mins > 180) {
      setStatus("error", "Los últimos minutos del directo deben estar entre 1 y 180.");
      return;
    }
  }

  clearInterval(pollTimer);
  clipsEl.innerHTML = "";
  metaEl.textContent = "";
  setBusy(true);
  setStatus(
    "working",
    pair ? "Enviando los dos orígenes…" : hasFile ? "Subiendo vídeo…" : "Enviando enlace…",
  );

  const fd = new FormData(form);
  fd.set("burnOverlay", document.getElementById("burnOverlay")?.checked ? "1" : "0");
  fd.set("burnSubs", document.getElementById("burnSubs")?.checked ? "1" : "0");
  fd.set("subLook", document.getElementById("subLook")?.value || "frase");
  fd.set("subColor", document.getElementById("subColor")?.value || "#ffffff");
  fd.set("subSize", document.getElementById("subSize")?.value || "normal");
  fd.set("subPosition", document.getElementById("subPosition")?.value || "bottom");
  const preset = form.querySelector('input[name="webcamPreset"]:checked')?.value;
  if (preset) fd.set("webcamPreset", preset);
  if (pair) {
    fd.set("sourceMode", "pair");
    fd.set("layout", "pair");
    fd.delete("sourceUrl");
    if (pairFileA) fd.delete("sourceUrlA");
    else {
      fd.delete("video");
      fd.set("sourceUrlA", pairUrlA);
    }
    if (pairFileB) fd.delete("sourceUrlB");
    else {
      fd.delete("videoB");
      fd.set("sourceUrlB", pairUrlB);
    }
  } else {
    fd.delete("videoA");
    fd.delete("videoB");
    fd.delete("sourceUrlA");
    fd.delete("sourceUrlB");
    if (hasFile) {
      fd.delete("sourceUrl");
      fd.delete("url");
    } else {
      fd.delete("video");
      fd.set("sourceUrl", url);
    }
  }

  try {
    const res = await fetch("/api/jobs", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Fallo al crear el trabajo (${res.status})`);
    currentJobId = data.id;
    lastJobId = data.id;
    setStatus("working", data.progress || "En cola");
    renderMeta(data);
    pollTimer = setInterval(() => pollJob(data.id), 1500);
    await pollJob(data.id);
  } catch (err) {
    setStatus("error", err.message || String(err));
    currentJobId = null;
    setBusy(false);
  }
});

cancelBtn.addEventListener("click", async () => {
  if (!currentJobId) return;
  cancelBtn.disabled = true;
  setStatus("working", "Deteniendo…");
  try {
    const res = await fetch(`/api/jobs/${currentJobId}/cancel`, { method: "POST" });
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || "No se pudo detener");
    clearInterval(pollTimer);
    renderMeta(job);
    setStatus("error", job.progress || "Detenido");
    currentJobId = null;
    setBusy(false);
  } catch (err) {
    setStatus("error", err.message || String(err));
    cancelBtn.disabled = false;
  }
});

async function pollJob(id) {
  try {
    const res = await fetch(`/api/jobs/${id}`);
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || "Trabajo no encontrado");

    renderMeta(job);

    if (job.status === "done") {
      clearInterval(pollTimer);
      setStatus("done", job.progress || "Listo");
      renderClips(job.clips || [], job.id);
      currentJobId = null;
      setBusy(false);
    } else if (job.status === "error" || job.status === "cancelled") {
      clearInterval(pollTimer);
      setStatus("error", job.error || job.progress || "Detenido");
      currentJobId = null;
      setBusy(false);
    } else {
      setStatus("working", job.progress || job.status);
    }
  } catch (err) {
    clearInterval(pollTimer);
    setStatus("error", err.message || String(err));
    currentJobId = null;
    setBusy(false);
  }
}

function setStatus(kind, text) {
  statusEl.className = `status ${kind}`;
  statusEl.textContent = text;
}

const PRESET_ES = {
  auto: "cara auto",
  "bottom-left": "abajo izquierda",
  "top-left": "arriba izquierda",
  "top-right": "arriba derecha",
  "bottom-right": "abajo derecha",
  custom: "personalizado",
};

function renderMeta(job) {
  const lines = [];
  lines.push(`trabajo  ${job.id}`);
  if (job.sourceUrl) lines.push(`enlace  ${job.sourceUrl}`);
  if (job.sourceUrlB) lines.push(`enlace 2  ${job.sourceUrlB}`);
  lines.push(`archivo  ${job.sourceFilename}`);
  if (job.sourceFilenameB) {
    lines.push(`archivo 2  ${job.sourceFilenameB}`);
    lines.push(
      `stack  ${job.options?.pairOrder === "b-top" ? "vídeo 2 arriba" : "vídeo 1 arriba"}`,
    );
  }
  if (job.sourceWidth && job.sourceHeight) {
    lines.push(
      `origen  ${job.sourceWidth}×${job.sourceHeight} · ${Number(job.sourceDurationSec || 0).toFixed(1)}s`,
    );
  }
  if (job.qualityNote) lines.push(job.qualityNote);
  const preset = PRESET_ES[job.crop?.webcamPreset] || job.crop?.webcamPreset;
  const live = job.options?.liveLastMinutes
    ? ` · directo últimos ${job.options.liveLastMinutes} min`
    : "";
  lines.push(
    `clips  ${job.options?.clipPickMode === "full" ? "vídeo completo" : job.options?.clipPickMode === "split" ? "partir" : "mejores momentos"}${job.options?.clipPickMode === "full" ? "" : ` · ${job.options?.clipDurationSec}s`} · ${job.options?.quality || "?"}p · ${job.options?.layout === "full" ? "pantalla completa" : job.options?.layout === "pair" ? "dos vídeos" : "dividido"}${job.options?.clipPickMode === "full" ? "" : ` · máx=${job.options?.maxClips}`} · cám=${preset} · ${job.options?.output}${job.options?.burnSubs ? ` · subtítulos ${job.options.subLook || "frase"}` : ""}${live}`,
  );
  if (job.highlights?.length) {
    lines.push(`highlights  ${job.highlights.length}`);
    for (const h of job.highlights) {
      const reasons = translateReasons(h.reasons).join(", ");
      lines.push(
        `  · ${h.startSec.toFixed(1)}s–${h.endSec.toFixed(1)}s  puntuación=${h.score}  (${reasons})`,
      );
    }
  }
  metaEl.textContent = lines.join("\n");
}

function renderClips(clips, jobId) {
  clipsEl.innerHTML = "";
  for (const clip of clips) {
    const el = document.createElement("article");
    el.className = "clip";
    const reasons = translateReasons(clip.reasons).join(" · ") || "heurística";
    const title = clip.title || clip.filename.replace(/\.[^.]+$/, "");
    const caption = clip.caption || title;
    const overlay = clip.overlay || "";
    const mood = clip.mood || "";
    const overlayHtml = escapeHtml(overlay).replace(/\n/g, "<br />");
    el.innerHTML = `
      <header>
        <span>${escapeHtml(clip.filename)}</span>
        <span>${clip.startSec.toFixed(1)}s → ${clip.endSec.toFixed(1)}s · ${clip.durationSec}s</span>
      </header>
      <video controls playsinline preload="metadata" src="${escapeHtml(clip.url)}"></video>
      <div class="caption-box overlay-box">
        <p class="caption-kicker">Marca en el vídeo${mood ? ` · ${escapeHtml(mood)}` : ""}</p>
        <div class="caption-top">
          <strong class="overlay-phrase">${overlayHtml || "—"}</strong>
          <button type="button" class="copy-overlay">Copiar</button>
        </div>
        <p class="caption-hint">Ollama la escribe con lo dicho en el clip. Si marcaste la frase, va arriba. Los subtítulos, si los pediste, van abajo.</p>
      </div>
      <div class="caption-box">
        <p class="caption-kicker">Descripción para TikTok</p>
        <div class="caption-top">
          <strong>${escapeHtml(title)}</strong>
          <button type="button" class="copy-caption">Copiar</button>
        </div>
        <textarea class="caption-text" rows="6">${escapeHtml(caption)}</textarea>
        <p class="caption-hint">Texto claro para pegar al publicar. Edítalo si quieres.</p>
      </div>
      <div class="actions">
        <span class="reasons">${escapeHtml(reasons)} · puntuación ${clip.score}</span>
        <div class="clip-btns">
          <button type="button" class="tiktok-post" data-file="${escapeHtml(clip.filename)}">TikTok</button>
          <button type="button" class="clip-edit">Editar</button>
          <a href="${escapeHtml(clip.url)}" download="${escapeHtml(clip.filename)}">${clip.filename.startsWith("video-completo") ? "Descargar vídeo" : "Descargar"}</a>
        </div>
      </div>
    `;
    clipsEl.appendChild(el);
    const area = el.querySelector(".caption-text");
    const bindCopy = (btn, getText) => {
      btn?.addEventListener("click", async () => {
        const text = getText();
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          area?.select();
          document.execCommand("copy");
        }
        btn.textContent = "Copiado";
        setTimeout(() => {
          btn.textContent = "Copiar";
        }, 1400);
      });
    };
    bindCopy(el.querySelector(".copy-caption"), () => area?.value || caption);
    bindCopy(el.querySelector(".copy-overlay"), () => overlay);
    el.querySelector(".tiktok-post")?.addEventListener("click", () => publishClip(clip, el));
    el.querySelector(".clip-edit")?.addEventListener("click", () => {
      window.ClipsTools?.open({
        jobId,
        filename: clip.filename,
        url: clip.url,
        start: clip.startSec,
        end: clip.endSec,
        duration: clip.durationSec,
        title,
      });
    });
  }
}

async function publishClip(clip, el) {
  if (!tiktokConnected) {
    window.location.href = "/api/tiktok/login";
    return;
  }
  const btn = el.querySelector(".tiktok-post");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "Subiendo…";
  const caption = el.querySelector(".caption-text")?.value || clip.caption || clip.title || "";
  try {
    const res = await fetch("/api/tiktok/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: lastJobId || currentJobId,
        filename: clip.filename,
        title: caption.slice(0, 150) || clip.filename.replace(/\.[^.]+$/, ""),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "TikTok rechazó el vídeo");
    btn.textContent = data.mode === "inbox" ? "En bandeja" : "En TikTok";
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "TikTok";
    alert(err instanceof Error ? err.message : String(err));
  }
}

syncDurationChips();
syncLive();
syncLayout();
syncSourceMode();
syncPickMode();
refreshTikTok();
