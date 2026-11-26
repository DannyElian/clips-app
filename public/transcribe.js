const viewClips = document.getElementById("view-clips");
const viewTranscribe = document.getElementById("view-transcribe");
const viewTools = document.getElementById("view-tools");
const navButtons = document.querySelectorAll(".nav-btn");
const form = document.getElementById("transcript-form");
const urlInput = document.getElementById("transcriptUrl");
const fileInput = document.getElementById("transcriptFile");
const drop = document.getElementById("transcript-drop");
const fileLabel = document.getElementById("transcript-file-label");
const submitBtn = document.getElementById("transcript-submit");
const cancelBtn = document.getElementById("transcript-cancel");
const statusEl = document.getElementById("transcript-status");
const toolsEl = document.getElementById("transcript-tools");
const langEl = document.getElementById("transcript-lang");
const textEl = document.getElementById("transcript-text");
const cuesEl = document.getElementById("transcript-cues");

let pollTimer = 0;
let currentId = "";
let lastJob = null;

function showView(name) {
  viewClips?.classList.toggle("hidden", name !== "clips");
  viewTranscribe?.classList.toggle("hidden", name !== "transcribe");
  viewTools?.classList.toggle("hidden", name !== "tools");
  navButtons.forEach((btn) => btn.classList.toggle("on", btn.dataset.view === name));
}
window.showClipsView = showView;

navButtons.forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.view || "clips"));
});

function setStatus(kind, message) {
  statusEl.className = `status ${kind}`;
  statusEl.textContent = message;
}

function syncReady() {
  const ok = Boolean(urlInput.value.trim() || fileInput.files?.[0]);
  submitBtn.disabled = !ok;
}

function stamp(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function renderJob(job) {
  lastJob = job;
  if (job.status === "done") {
    setStatus("ok", "Listo. El texto está como se dijo.");
    toolsEl.classList.remove("hidden");
    langEl.textContent = job.language ? `Idioma detectado: ${job.language}` : "Texto literal";
    textEl.value = job.text || "";
    cuesEl.innerHTML = "";
    for (const cue of job.segments || []) {
      const row = document.createElement("p");
      row.className = "cue";
      row.innerHTML = `<time>${stamp(cue.start)}–${stamp(cue.end)}</time><span></span>`;
      row.querySelector("span").textContent = cue.text || "";
      cuesEl.appendChild(row);
    }
    submitBtn.classList.remove("hidden");
    cancelBtn.classList.add("hidden");
    submitBtn.disabled = false;
    return;
  }
  if (job.status === "error") {
    setStatus("err", job.error || "No se pudo transcribir");
    cancelBtn.classList.add("hidden");
    submitBtn.classList.remove("hidden");
    submitBtn.disabled = false;
    return;
  }
  if (job.status === "cancelled") {
    setStatus("idle", "Detenido");
    cancelBtn.classList.add("hidden");
    submitBtn.classList.remove("hidden");
    submitBtn.disabled = false;
    return;
  }
  setStatus("working", job.progress || "Trabajando…");
}

async function poll() {
  if (!currentId) return;
  try {
    const res = await fetch(`/api/transcripts/${currentId}`);
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || "No se encontró la transcripción");
    renderJob(job);
    if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
      clearInterval(pollTimer);
      pollTimer = 0;
    }
  } catch (err) {
    setStatus("err", err instanceof Error ? err.message : String(err));
  }
}

urlInput.addEventListener("input", syncReady);
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileLabel.textContent = file ? file.name : "Arrastra el vídeo aquí";
  if (file) urlInput.value = "";
  syncReady();
});
urlInput.addEventListener("input", () => {
  if (urlInput.value.trim()) {
    fileInput.value = "";
    fileLabel.textContent = "Arrastra el vídeo aquí";
  }
});

["dragover", "dragleave", "drop"].forEach((name) => {
  drop.addEventListener(name, (event) => {
    event.preventDefault();
    drop.classList.toggle("over", name === "dragover");
    if (name !== "drop") return;
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event("change"));
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files?.[0];
  const url = urlInput.value.trim();
  if (!file && !url) return;
  toolsEl.classList.add("hidden");
  textEl.value = "";
  cuesEl.innerHTML = "";
  submitBtn.disabled = true;
  cancelBtn.classList.remove("hidden");
  setStatus("working", file ? "Subiendo vídeo…" : "Enviando enlace…");
  const fd = new FormData();
  if (file) fd.set("video", file);
  else fd.set("sourceUrl", url);
  try {
    const res = await fetch("/api/transcripts", { method: "POST", body: fd });
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || "No se pudo empezar");
    currentId = job.id;
    renderJob(job);
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, 1500);
  } catch (err) {
    setStatus("err", err instanceof Error ? err.message : String(err));
    submitBtn.disabled = false;
    cancelBtn.classList.add("hidden");
  }
});

cancelBtn.addEventListener("click", async () => {
  if (!currentId) return;
  cancelBtn.disabled = true;
  await fetch(`/api/transcripts/${currentId}/cancel`, { method: "POST" });
  cancelBtn.disabled = false;
  poll();
});

document.getElementById("transcript-copy")?.addEventListener("click", async () => {
  const btn = document.getElementById("transcript-copy");
  try {
    await navigator.clipboard.writeText(textEl.value || "");
  } catch {
    textEl.select();
    document.execCommand("copy");
  }
  btn.textContent = "Copiado";
  setTimeout(() => {
    btn.textContent = "Copiar";
  }, 1400);
});

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function srtStamp(sec) {
  const ms = Math.max(0, Math.round(Number(sec) * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

document.getElementById("transcript-txt")?.addEventListener("click", () => {
  if (!lastJob?.text) return;
  download("transcripcion.txt", lastJob.text, "text/plain;charset=utf-8");
});

document.getElementById("transcript-srt")?.addEventListener("click", () => {
  const cues = lastJob?.segments || [];
  if (!cues.length) return;
  const body = cues
    .map((cue, i) => `${i + 1}\n${srtStamp(cue.start)} --> ${srtStamp(cue.end)}\n${cue.text}\n`)
    .join("\n");
  download("transcripcion.srt", body, "application/x-subrip;charset=utf-8");
});

syncReady();
