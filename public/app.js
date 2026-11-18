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
});

function isHighlightsMode() {
  return form.querySelector('input[name="clipPickMode"]:checked')?.value !== "split";
}

function syncPickMode() {
  const highlights = isHighlightsMode();
  const note = document.getElementById("pick-note");
  const audioKnob = document.getElementById("audio-knob");
  const pairHl = document.getElementById("pair-highlight-fs");
  if (note) {
    note.textContent = highlights
      ? "Recorre el vídeo entero y se queda con los momentos de más energía / cambios de escena."
      : "Corta el vídeo en N trozos de la duración elegida, seguidos, sin buscar picos.";
  }
  audioKnob?.classList.toggle("hidden", !highlights);
  pairHl?.classList.toggle("hidden", !highlights);
  submitBtn.textContent = highlights ? "Buscar highlights y exportar" : "Partir y exportar";
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
      renderClips(job.clips || []);
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
  const preset = PRESET_ES[job.crop?.webcamPreset] || job.crop?.webcamPreset;
  const live = job.options?.liveLastMinutes
    ? ` · directo últimos ${job.options.liveLastMinutes} min`
    : "";
  lines.push(
    `clips  ${job.options?.clipPickMode === "split" ? "partir" : "mejores momentos"} · ${job.options?.clipDurationSec}s · ${job.options?.quality || "?"}p · ${job.options?.layout === "full" ? "pantalla completa" : job.options?.layout === "pair" ? "dos vídeos" : "dividido"} · máx=${job.options?.maxClips} · cám=${preset} · ${job.options?.output}${live}`,
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

function renderClips(clips) {
  clipsEl.innerHTML = "";
  for (const clip of clips) {
    const el = document.createElement("article");
    el.className = "clip";
    const reasons = translateReasons(clip.reasons).join(" · ") || "heurística";
    el.innerHTML = `
      <header>
        <span>${clip.filename}</span>
        <span>${clip.startSec.toFixed(1)}s → ${clip.endSec.toFixed(1)}s · ${clip.durationSec}s</span>
      </header>
      <video controls playsinline preload="metadata" src="${clip.url}"></video>
      <div class="actions">
        <span class="reasons">${reasons} · puntuación ${clip.score}</span>
        <a href="${clip.url}" download="${clip.filename}">Descargar</a>
      </div>
    `;
    clipsEl.appendChild(el);
  }
}

syncDurationChips();
syncLive();
syncLayout();
syncSourceMode();
syncPickMode();
