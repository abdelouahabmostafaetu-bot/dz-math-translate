// Inline bilingual translation for ordinary web pages, plus the selection
// bubble. Nothing runs until the user asks (Alt+T or the popup button).

(() => {
  if (window.__dzmtLoaded) return;
  window.__dzmtLoaded = true;

  const BLOCKS = "p, li, dd, blockquote, figcaption, h1, h2, h3, h4, h5, h6, td, summary";
  const SKIP_CLOSEST = "code, pre, kbd, samp, script, style, textarea, .dzmt-tr, .MathJax, .katex, math";
  const MIN_LENGTH = 12;

  let active = false;
  let observer = null;
  const queued = new WeakSet();

  const send = (message) =>
    new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));

  function eligible(el) {
    if (queued.has(el) || el.closest(SKIP_CLOSEST)) return false;
    if (el.querySelector(BLOCKS)) return false; // only leaf blocks
    const text = (el.innerText || "").trim();
    if (text.length < MIN_LENGTH) return false;
    return /\p{L}{3,}/u.test(text);
  }

  async function translateBatch(elements) {
    const items = elements.map((el) => el.innerText.trim());
    const response = await send({ type: "translate", items });
    const results = response?.ok ? response.data : [];

    elements.forEach((el, index) => {
      const result = results[index];
      const block = document.createElement("div");
      block.className = "dzmt-tr";
      if (result?.text) block.textContent = result.text;
      else {
        block.classList.add("dzmt-failed");
        block.textContent = `[${result?.error || response?.error || "failed"}]`;
      }
      el.insertAdjacentElement("afterend", block);
    });
  }

  function start() {
    let batch = [];
    let timer = null;

    const flush = () => {
      timer = null;
      const current = batch;
      batch = [];
      if (current.length) translateBatch(current);
    };

    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target;
          observer.unobserve(el);
          if (!eligible(el)) continue;
          queued.add(el);
          batch.push(el);
        }
        if (batch.length && !timer) timer = setTimeout(flush, 120);
      },
      { rootMargin: "400px 0px" }
    );

    for (const el of document.querySelectorAll(BLOCKS)) {
      if (eligible(el)) observer.observe(el);
    }

    // late content (infinite scroll, SPA navigation)
    new MutationObserver((mutations) => {
      if (!active) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1 || node.classList?.contains("dzmt-tr")) continue;
          const candidates = node.matches?.(BLOCKS) ? [node] : node.querySelectorAll?.(BLOCKS) || [];
          for (const el of candidates) if (eligible(el)) observer.observe(el);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    document.querySelectorAll(".dzmt-tr").forEach((el) => el.remove());
  }

  async function toggle() {
    active = !active;
    if (active) {
      const { data } = await send({ type: "getSettings" });
      document.documentElement.dataset.dzmtDir = /^(ar|he|fa|ur)/.test(data.targetLang) ? "rtl" : "ltr";
      start();
    } else {
      stop();
    }
    return active;
  }

  // ---------- selection bubble ----------

  let bubble = null;

  function showBubble(original, translation) {
    bubble?.remove();
    const selection = window.getSelection();
    const rect = selection?.rangeCount
      ? selection.getRangeAt(0).getBoundingClientRect()
      : { bottom: 40, left: 40 };

    bubble = document.createElement("div");
    bubble.className = "dzmt-bubble";
    bubble.style.top = `${window.scrollY + rect.bottom + 8}px`;
    bubble.style.left = `${window.scrollX + Math.max(8, rect.left)}px`;
    bubble.textContent = translation;

    const close = document.createElement("button");
    close.className = "dzmt-close";
    close.textContent = "x";
    close.addEventListener("click", () => bubble.remove());
    bubble.append(close);

    document.body.append(bubble);
    setTimeout(() => {
      document.addEventListener("mousedown", function once() {
        bubble?.remove();
        document.removeEventListener("mousedown", once);
      });
    }, 0);
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "toggle-page") {
      toggle().then((on) => respond({ on }));
      return true;
    }
    if (message?.type === "show-bubble") {
      showBubble(message.original, message.translation);
      respond({ ok: true });
    }
    if (message?.type === "status") respond({ on: active });
    return false;
  });
})();
