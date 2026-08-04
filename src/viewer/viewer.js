// ---------------------------------------------------------------------------
//  Bilingual PDF reader.
//
//  Chrome's built-in PDF viewer is a native plugin: its text is not in the DOM,
//  so no extension can translate it. We therefore render the PDF ourselves with
//  PDF.js, group the text layer back into paragraphs, and translate the pages
//  the reader is actually looking at (plus a couple ahead).
// ---------------------------------------------------------------------------

import * as pdfjsLib from "../../vendor/pdfjs/build/pdf.mjs";
import { EventBus, PDFViewer, PDFLinkService } from "../../vendor/pdfjs/web/pdf_viewer.mjs";
import { joinLines, normalise, isTranslatable } from "../lib/segment.js";
import { LANGUAGES, isRtl } from "../lib/settings.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  "vendor/pdfjs/build/pdf.worker.mjs"
);

const $ = (id) => document.getElementById(id);
const send = (message) =>
  new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));

const state = {
  settings: null,
  pages: new Map(), // pageNumber -> { paragraphs, status }
  visible: new Set(),
  current: 0,
  inFlight: 0,
};

// ---------- viewer bootstrap ----------

const container = $("viewerContainer");
const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus });
const pdfViewer = new PDFViewer({
  container,
  eventBus,
  linkService,
  textLayerMode: 1,
  removePageBorders: true,
});
linkService.setViewer(pdfViewer);

eventBus.on("pagesinit", () => {
  pdfViewer.currentScaleValue = "page-width";
  $("pageCount").textContent = `/ ${pdfViewer.pagesCount}`;
  observePages();
});

eventBus.on("pagechanging", ({ pageNumber }) => {
  $("pageNo").value = pageNumber;
});

eventBus.on("textlayerrendered", ({ pageNumber, source }) => {
  const layer = source?.textLayer?.div || source?.textLayer?.textLayerDiv;
  if (!layer) return;
  const paragraphs = extractParagraphs(layer, pageNumber);
  state.pages.set(pageNumber, { paragraphs, status: "idle" });
  layer.addEventListener("click", (event) => onPageClick(event, pageNumber));
  if (state.visible.has(pageNumber) || nearVisible(pageNumber)) schedule(pageNumber);
  if (pageNumber === state.current) renderPane(pageNumber);
});

async function loadDocument(source, title) {
  const doc = await pdfjsLib.getDocument(source).promise;
  state.pages.clear();
  pdfViewer.setDocument(doc);
  linkService.setDocument(doc, null);
  document.body.classList.add("has-doc");
  $("docTitle").textContent = title || "document.pdf";
  document.title = `${title || "PDF"} - DZ Math Translate`;
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
    { root: container, rootMargin: "200px 0px", threshold: 0.02 }
  );

  for (const view of pdfViewer._pages || []) {
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

function setStatus(message, kind) {
  const el = $("status");
  if (message) {
    el.textContent = message;
    el.className = `status ${kind || ""}`;
    return;
  }
  if (state.inFlight > 0) {
    el.textContent = `Translating ${state.inFlight} page${state.inFlight > 1 ? "s" : ""}...`;
    el.className = "status busy";
  } else {
    el.textContent = "";
    el.className = "status";
  }
}

// ---------- reading pane ----------

function renderPane(pageNumber) {
  const body = $("paneBody");
  const page = state.pages.get(pageNumber);
  $("paneTitle").textContent = `Page ${pageNumber}`;

  if (!page) {
    body.innerHTML = '<p class="pane-note">Rendering page...</p>';
    $("paneMeta").textContent = "";
    return;
  }

  const shown = page.paragraphs.filter((p) => !p.skip);
  const done = shown.filter((p) => p.translation).length;
  $("paneMeta").textContent = `${done}/${shown.length}`;

  body.innerHTML = "";
  if (!shown.length) {
    body.innerHTML = '<p class="pane-note">No prose on this page (figures or formulas only).</p>';
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
  const view = pdfViewer._pages?.[paragraph.pageNumber - 1];
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
  const view = pdfViewer._pages?.[paragraph.pageNumber - 1];
  if (!view?.div) return;
  container.scrollTo({
    top: view.div.offsetTop + paragraph.rect.top - 80,
    behavior: "smooth",
  });
  highlight(paragraph);
}

// Clicking a paragraph in the PDF selects its card in the pane.
function onPageClick(event, pageNumber) {
  const page = state.pages.get(pageNumber);
  if (!page) return;
  const view = pdfViewer._pages?.[pageNumber - 1];
  if (!view?.div) return;

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
  state.settings = settings;
  document.body.classList.toggle("show-original", !!settings.showOriginal);
  document.body.style.setProperty("--font-scale", settings.fontScale || 1);
  $("paneBody").dir = isRtl(settings.targetLang) ? "rtl" : "ltr";
  $("showOriginal").checked = !!settings.showOriginal;
  $("lang").value = settings.targetLang;
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

function wireToolbar() {
  const select = $("lang");
  for (const { code, name } of LANGUAGES) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = name;
    select.append(option);
  }

  select.addEventListener("change", async () => {
    await send({ type: "setSettings", patch: { targetLang: select.value } });
    const { data } = await send({ type: "getSettings" });
    applySettings(data);
    resetTranslations();
  });

  $("showOriginal").addEventListener("change", async (event) => {
    await send({ type: "setSettings", patch: { showOriginal: event.target.checked } });
    document.body.classList.toggle("show-original", event.target.checked);
  });

  $("togglePane").addEventListener("click", () => {
    document.body.classList.toggle("no-pane");
  });

  $("prev").addEventListener("click", () => pdfViewer.previousPage());
  $("next").addEventListener("click", () => pdfViewer.nextPage());
  $("zoomIn").addEventListener("click", () => (pdfViewer.currentScale *= 1.1));
  $("zoomOut").addEventListener("click", () => (pdfViewer.currentScale /= 1.1));
  $("pageNo").addEventListener("change", (event) => {
    const n = Number(event.target.value);
    if (n >= 1 && n <= pdfViewer.pagesCount) pdfViewer.currentPageNumber = n;
  });

  $("open").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const data = new Uint8Array(await file.arrayBuffer());
    await loadDocument({ data }, file.name);
  });

  // drag and drop, which also covers local files without any file permission
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
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const data = new Uint8Array(await file.arrayBuffer());
    await loadDocument({ data }, file.name);
  });
}

(async function main() {
  const { data } = await send({ type: "getSettings" });
  applySettings(data);
  wireToolbar();

  const file = new URLSearchParams(location.search).get("file");
  if (!file) return;

  try {
    const url = decodeURIComponent(file);
    await loadDocument({ url }, url.split("/").pop());
  } catch (error) {
    setStatus("Could not open this PDF", "error");
    console.error(error);
  }
})();
