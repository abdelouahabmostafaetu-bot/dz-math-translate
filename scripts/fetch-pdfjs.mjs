#!/usr/bin/env node
// Download the PDF.js files the reader needs into vendor/pdfjs/.
// No npm install, no build step: plain Node 18+ and a network connection.
//
//   node scripts/fetch-pdfjs.mjs            # pinned version
//   node scripts/fetch-pdfjs.mjs 4.10.38    # a specific version

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = process.argv[2] || "4.10.38";
const BASE = "https://cdn.jsdelivr.net/npm/pdfjs-dist@" + VERSION + "/";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "vendor", "pdfjs");

const FILES = [
  "build/pdf.mjs",
  "build/pdf.worker.mjs",
  "web/pdf_viewer.mjs",
  "web/pdf_viewer.css",
];

async function get(path) {
  const url = BASE + path;
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status + " " + url);
  return Buffer.from(await res.arrayBuffer());
}

console.log("pdfjs-dist@" + VERSION + " -> vendor/pdfjs");

for (const file of FILES) {
  const target = join(OUT, file);
  await mkdir(dirname(target), { recursive: true });
  const data = await get(file);
  await writeFile(target, data);
  console.log("  " + file + "  " + (data.length / 1024).toFixed(0) + " KB");
}

await writeFile(join(OUT, "VERSION"), VERSION + "\n");
console.log("done. Reload the extension in chrome://extensions.");
