// ---------------------------------------------------------------------------
//  Bilingual PDF reader.
//
//  Chrome's built-in PDF viewer is a native plugin: its text is not in the DOM,
//  so no extension can translate it. We therefore render the PDF ourselves with
//  PDF.js, group the text layer back into paragraphs, and translate the pages
//  the reader is actually looking at (plus a couple ahead).
//
//  PDF.js is imported lazily on purpose. A static top-level import of a file
//  that is missing kills the whole module, and every button in the toolbar dies
//  silently with it.
// ---------------------------------------------------------------------------

import { joinLines, normalise, isTranslatable } from "../lib/segment.js";
import { LANGUAGES, isRtl, DEFAULTS } from "../lib/settings.js";

const $ = (id) => document.getElementById(id);

// sendMessage reports failures through lastError instead of rejecting; read it
// or the caller silently receives undefined.
function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "no response from background" });
    });
  });
}

const state = {
  settings: { ...DEFAULTS },
  pages: new Map(), // pageNumber -> { paragraphs, status }
  visible: new Set(),
  current: 0,
  inFlight: 0,
};

let pdfjsLib = null;
let pdfViewer = null;
let eventBus = null;
let linkService = null;
let viewerReady = null;

function setStatus(message, kind) {
  const el = $("status");
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.className = `status ${kind || ""}`;
    return;
  }
  if (state.inFlight > 0) {
    const n = state.inFlight;
    el.textContent = `Translating ${n} page${n > 1 ? "s" : ""}...`;
    el.className = "status busy";
  } else {
    el.textContent = "";
    el.className = "status";
  }
}

// ---------- PDF.js bootstrap (lazy) ----------

function showMissingPdfjs(error) {
  console.error("[dzmt] PDF.js failed to load", error);
  const zone = document.querySelector("#dropzone .dz-inner");
  if (zone) {
    zone.innerHTML = `
      <h1 style="color:#7b2d3b">PDF.js is not installed</h1>
      <p>This extension renders PDFs itself, so it needs the PDF.js library.
         It is not committed to the repository because it is several megabytes
         of third-party code.</p>
      <p>Run this once in the extension folder, then reload the extension in
         <b>chrome://extensions</b>:</p>
      <pre style="background:#1b1b1f;color:#fcfbf7;padding:10px 12px;border-radius:8px;
                  text-align:start;overflow:auto">node scripts/fetch-pdfjs.mjs</pre>
      <p class="hint">It needs Node 18 or newer (check with <code>node --version</code>).
         Afterwards <code>vendor/pdfjs/build/pdf.mjs</code> must exist.</p>`;
  }
  setStatus("PDF.js missing", "error");
}

async function ensureViewer() {
  if (viewerReady) return viewerReady;

  viewerReady = (async () => {
    let lib;
    let web;
    try {
      lib = await import("../../vendor/pdfjs/build/pdf.mjs");
      web = await import("../../vendor/pdfjs/web/pdf_viewer.mjs");
    } catch (error) {
      showMissingPdfjs(error);
      throw new Error("PDF.js is not installed");
    }

    pdfjsLib = lib;
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
      "vendor/pdfjs/build/pdf.worker.mjs"
    );

    eventBus = new web.EventBus();
    linkService = new web.PDFLinkService({ eventBus });
    pdfViewer = new web.PDFViewer({
      container: $("viewerContainer"),
      eventBus,
      linkService,
      textLayerMode: 1,
    });
    linkService.setViewer(pdfViewer);
    wireViewerEvents();
  })();

  // A failed attempt must not be cached, or a later retry can never succeed.
  viewerReady.catch(() => {
    viewerReady = null;
  });

  return viewerReady;
}

function wireViewerEvents() {
  eventBus.on("pagesinit", () => {
    pdfViewer.currentScaleValue = "page-width";
    const count = $("pageCount");
    if (count) count.textContent = `/ ${pdfViewer.pagesCount}`;
    observePages();
  });

  eventBus.on("pagechanging", ({ pageNumber }) => {
    const box = $("pageNo");
    if (box) box.value = pageNumber;
  });

  eventBus.on("textlayerrendered", ({ pageNumber, source }) => {
    // The property was renamed across PDF.js versions.
    const layer =
      source?.textLayer?.div || source?.textLayer?.textLayerDiv || source?.textLayerDiv;
    if (!layer) return;

    const paragraphs = extractParagraphs(layer, pageNumber);
    state.pages.set(pageNumber, { paragraphs, status: "idle" });
    layer.addEventListener("click", (event) => onPageClick(event, pageNumber));

    if (state.visible.has(pageNumber) || nearVisible(pageNumber)) schedule(pageNumber);
    if (pageNumber === state.current) renderPane(pageNumber);
  });
}

async function loadDocument(source, title) {
  setStatus("Opening...");
  await ensureViewer();

  const doc = await pdfjsLib.getDocument(source).promise;
  state.pages.clear();
  state.visible.clear();
  state.current = 1;

  pdfViewer.setDocument(doc);
  linkService.setDocument(doc, null);

  document.body.classList.add("has-doc");
  const label = title || "document.pdf";
  const docTitle = $("docTitle");
  if (docTitle) docTitle.textContent = label;
  document.title = `${label} - DZ Math Translate`;
  setStatus();
}

async function openFile(file) {
  if (!file) return;
  if (file.type && file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    setStatus("Not a PDF file", "error");
    return;
  }
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    await loadDocument({ data }, file.name);
  } catch (error) {
    setStatus(`Could not open: ${String(error?.message || error)}`, "error");
    console.error(error);
  }
}

// ---------- paragraph reconstruction ----------

// PDF text layers are a soup of absolutely positioned spans. Rebuild lines by
// vertical position, then paragraphs by line spacing and indentation.
function extractParagraphs(layer, pageNumber) {
  const spans = [...layer.querySelectorAll("span")].filter(
    (s) => s.textContent && s.textContent.trim()
  );
  if (!spans.length) return [];

  const boxes = spans.map((el) => ({
    el,
    text: el.textContent,
    top: el.offsetTop,
    left: el.offsetLeft,
    width: el.offsetWidth,
    height: el.offsetHeight || 10,
  }));

  const heights = boxes.map((b) => b.height).sort((a, b) => a - b);
  const lineHeight = heights[Math.floor(heights.length / 2)] || 10;
  const tolerance = lineHeight * 0.6;

  boxes.sort((a, b) => a.top - b.top || a.left - b.left);

  const lines = [];
  for (const box of boxes) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(box.top - line.top) <= tolerance) {
      line.boxes.push(box);
      line.top = Math.min(line.top, box.top);
      line.left = Math.min(line.left, box.left);
      line.right = Math.max(line.right, box.left + box.width);
      line.bottom = Math.max(line.bottom, box.top + box.height);
    } else {
      lines.push({
        top: box.top,
        left: box.left,
        right: box.left + box.width,
        bottom: box.top + box.height,
        boxes: [box],
      });
    }
  }

  for (const line of lines) {
    line.boxes.sort((a, b) => a.left - b.left);
    line.text = line.boxes.map((b) => b.text).join("");
  }

  const columnWidth = Math.max(...lines.map((l) => l.right - l.left), 1);
  const bodyLeft = Math.min(...lines.map((l) => l.left));

  const groups = [];
  let group = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const previous = lines[i - 1];

    let breakHere = !group;
    if (previous && group) {
      const gap = line.top - previous.bottom;
      const indented = line.left - bodyLeft > lineHeight * 0.9;
      const shortPrevious = previous.right - previous.left < columnWidth * 0.72;
      const endsSentence = /[.!?:;]\s*$/.test(previous.text);
      if (gap > lineHeight * 0.9) breakHere = true;
      else if (indented) breakHere = true;
      else if (shortPrevious && endsSentence) breakHere = true;
    }

    if (breakHere) {
      group = { lines: [], boxes: [] };
      groups.push(group);
    }
    group.lines.push(line.text);
    group.boxes.push(line);
  }

  return groups
    .map((g, index) => {
      const text = normalise(
        joinLines(g.lines, { dehyphenate: state.settings?.dehyphenate !== false })
      );
      return {
        id: `p${pageNumber}-${index}`,
        pageNumber,
        text,
        rect: {
          top: Math.min(...g.boxes.map((b) => b.top)),
          left: Math.min(...g.boxes.map((b) => b.left)),
          right: Math.max(...g.boxes.map((b) => b.right)),
          bottom: Math.max(...g.boxes.map((b) => b.bottom)),
        },
        translation: null,
        error: null,
        skip: !isTranslatable(text),
      };
    })
    .filter((p) => p.text.length > 1);
}

// ---------- scroll driven translation ----------

let observer = null;

function observePages() {
  observer?.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const pageNumber = Number(entry.target.dataset.pageNumber);
        if (!pageNumber) continue;
        if (entry.isIntersecting) state.visible.add(pageNumber);
        else state.visible.delete(pageNumber);
      }

      const visible = [...state.visible].sort((a, b) => a - b);
      const first = visible[0];
      if (first && first !== state.current) {
        state.current = first;
        renderPane(first);
      }

      const ahead = state.settings?.prefetchPages ?? 2;
      for (const page of visible) {
        for (let n = page; n <= page + ahead; n++) schedule(n);
      }
    },
    { root: $("viewerContainer"), rootMargin: "200px 0px", threshold: 0.02 }
  );

  for (const view of pdfViewer?._pages || []) {
    if (view?.div) observer.observe(view.div);
  }
}

function nearVisible(pageNumber) {
  const ahead = state.settings?.prefetchPages ?? 2;
  return [...state.visible].some((p) => pageNumber >= p && pageNumber <= p + ahead);
}

async function schedule(pageNumber) {
  const page = state.pages.get(pageNumber);
  if (!page || page.status !== "idle") return;

  const todo = page.paragraphs.filter((p) => !p.skip && !p.translation && !p.error);
  if (!todo.length) {
    page.status = "done";
    return;
  }

  page.status = "busy";
  state.inFlight++;
  setStatus();
  if (pageNumber === state.current) renderPane(pageNumber);

  const response = await send({ type: "translate", items: todo.map((p) => p.text) });
  const results = response?.ok ? response.data : [];

  todo.forEach((paragraph, index) => {
    const result = results[index];
    if (result?.text) paragraph.translation = result.text;
    else paragraph.error = result?.error || response?.error || "no response";
  });

  page.status = "done";
  state.inFlight--;
  setStatus();
  if (pageNumber === state.current) renderPane(pageNumber);
}

// ---------- reading pane ----------

function renderPane(pageNumber) {
  const body = $("paneBody");
  if (!body) return;

  const page = state.pages.get(pageNumber);
  const title = $("paneTitle");
  if (title) title.textContent = `Page ${pageNumber}`;
  const meta = $("paneMeta");

  if (!page) {
    body.innerHTML = '<p class="pane-note">Rendering page...</p>';
    if (meta) meta.textContent = "";
    return;
  }

  const shown = page.paragraphs.filter((p) => !p.skip);
  if (meta) meta.textContent = `${shown.filter((p) => p.translation).length}/${shown.length}`;

  body.innerHTML = "";
  if (!shown.length) {
    body.innerHTML =
      '<p class="pane-note">No prose on this page (figures or formulas only).</p>';
    return;
  }

  for (const paragraph of shown) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = paragraph.id;

    const translation = document.createElement("div");
    translation.className = "tr";
    if (paragraph.translation) {
      translation.textContent = paragraph.translation;
    } else if (paragraph.error) {
      card.classList.add("failed");
      translation.textContent = `[${paragraph.error}]`;
    } else {
      card.classList.add("pending");
      translation.textContent = "...";
    }

    const original = document.createElement("div");
    original.className = "orig";
    original.textContent = paragraph.text;

    card.append(translation, original);
    card.addEventListener("mouseenter", () => highlight(paragraph));
    card.addEventListener("mouseleave", clearHighlight);
    card.addEventListener("click", () => scrollToParagraph(paragraph));
    body.append(card);
  }
}

let highlightEl = null;

function highlight(paragraph) {
  clearHighlight();
  const view = pdfViewer?._pages?.[paragraph.pageNumber - 1];
  if (!view?.div) return;

  const box = document.createElement("div");
  box.className = "dzmt-hl";
  box.style.top = `${paragraph.rect.top - 2}px`;
  box.style.left = `${paragraph.rect.left - 3}px`;
  box.style.width = `${paragraph.rect.right - paragraph.rect.left + 6}px`;
  box.style.height = `${paragraph.rect.bottom - paragraph.rect.top + 4}px`;
  view.div.append(box);
  highlightEl = box;
}

function clearHighlight() {
  highlightEl?.remove();
  highlightEl = null;
}

function scrollToParagraph(paragraph) {
  const view = pdfViewer?._pages?.[paragraph.pageNumber - 1];
  if (!view?.div) return;
  $("viewerContainer").scrollTo({
    top: view.div.offsetTop + paragraph.rect.top - 80,
    behavior: "smooth",
  });
  highlight(paragraph);
}

// Clicking a paragraph in the PDF selects its card in the pane.
function onPageClick(event, pageNumber) {
  const page = state.pages.get(pageNumber);
  const view = pdfViewer?._pages?.[pageNumber - 1];
  if (!page || !view?.div) return;

  const rect = view.div.getBoundingClientRect();
  const y = event.clientY - rect.top;
  const x = event.clientX - rect.left;

  const hit = page.paragraphs.find(
    (p) => y >= p.rect.top - 4 && y <= p.rect.bottom + 4 && x >= p.rect.left - 8
  );
  if (!hit) return;

  if (state.current !== pageNumber) {
    state.current = pageNumber;
    renderPane(pageNumber);
  }
  const card = document.querySelector(`.card[data-id="${hit.id}"]`);
  if (card) {
    document.querySelectorAll(".card.active").forEach((c) => c.classList.remove("active"));
    card.classList.add("active");
    card.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

// ---------- toolbar and input ----------

function applySettings(settings) {
  state.settings = { ...DEFAULTS, ...(settings || {}) };
  document.body.classList.toggle("show-original", !!state.settings.showOriginal);
  document.body.style.setProperty("--font-scale", state.settings.fontScale || 1);

  const body = $("paneBody");
  if (body) body.dir = isRtl(state.settings.targetLang) ? "rtl" : "ltr";
  const original = $("showOriginal");
  if (original) original.checked = !!state.settings.showOriginal;
  const lang = $("lang");
  if (lang) lang.value = state.settings.targetLang;
}

function resetTranslations() {
  for (const page of state.pages.values()) {
    page.status = "idle";
    for (const paragraph of page.paragraphs) {
      paragraph.translation = null;
      paragraph.error = null;
    }
  }
  for (const pageNumber of state.visible) schedule(pageNumber);
  renderPane(state.current || 1);
}

// One failing control must never stop the others from being wired.
function on(id, event, handler) {
  const el = $(id);
  if (!el) {
    console.warn(`[dzmt] viewer: #${id} is missing from viewer.html`);
    return;
  }
  el.addEventListener(event, (e) => {
    try {
      const result = handler(e, el);
      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          setStatus(String(error?.message || error), "error");
          console.error(error);
        });
      }
    } catch (error) {
      setStatus(String(error?.message || error), "error");
      console.error(error);
    }
  });
}

function wireToolbar() {
  const select = $("lang");
  if (select) {
    for (const { code, name } of LANGUAGES) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = name;
      select.append(option);
    }
  }

  on("lang", "change", async (_e, el) => {
    await send({ type: "setSettings", patch: { targetLang: el.value } });
    const res = await send({ type: "getSettings" });
    applySettings(res.ok ? res.data : { ...state.settings, targetLang: el.value });
    resetTranslations();
  });

  on("showOriginal", "change", async (event) => {
    const checked = event.target.checked;
    document.body.classList.toggle("show-original", checked);
    state.settings.showOriginal = checked;
    await send({ type: "setSettings", patch: { showOriginal: checked } });
  });

  on("togglePane", "click", () => document.body.classList.toggle("no-pane"));

  // Navigation is meaningless before a document is loaded; guard rather than throw.
  on("prev", "click", () => pdfViewer?.previousPage());
  on("next", "click", () => pdfViewer?.nextPage());
  on("zoomIn", "click", () => {
    if (pdfViewer) pdfViewer.currentScale *= 1.1;
  });
  on("zoomOut", "click", () => {
    if (pdfViewer) pdfViewer.currentScale /= 1.1;
  });
  on("pageNo", "change", (event) => {
    if (!pdfViewer) return;
    const n = Number(event.target.value);
    if (n >= 1 && n <= pdfViewer.pagesCount) pdfViewer.currentPageNumber = n;
  });

  on("open", "click", () => $("file")?.click());
  on("file", "change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-opening the same file
    await openFile(file);
  });

  // Dropping a file needs no permission at all, which is the easiest route for
  // a PDF sitting in Downloads.
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener("dragover", (event) => {
    stop(event);
    document.body.classList.add("dragging");
  });
  document.addEventListener("dragleave", (event) => {
    stop(event);
    document.body.classList.remove("dragging");
  });
  document.addEventListener("drop", async (event) => {
    stop(event);
    document.body.classList.remove("dragging");
    await openFile(event.dataTransfer?.files?.[0]);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "o" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      $("file")?.click();
    }
  });
}

(async function main() {
  // Wire the UI first. Everything below can fail; the buttons must not.
  wireToolbar();

  const res = await send({ type: "getSettings" });
  applySettings(res.ok ? res.data : null);
  if (!res.ok) {
    setStatus(`Settings unavailable: ${res.error}`, "error");
  }

  const file = new URLSearchParams(location.search).get("file");
  if (!file) return;

  try {
    const url = decodeURIComponent(file);
    await loadDocument({ url }, url.split("/").pop());
  } catch (error) {
    setStatus(`Could not open this PDF: ${String(error?.message || error)}`, "error");
    console.error(error);
  }
})();
