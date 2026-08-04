# DZ Math Translate

A browser extension for reading mathematics in another language. It renders PDFs
itself, rebuilds real paragraphs out of the PDF text layer, translates the pages
you are actually looking at as you scroll, and **never sends a formula to a
translation engine**.

Built for the workflow behind the
[Doc Math DZ Book Series](https://github.com/abdelouahabmostafaetu-bot/dz_math_book_series):
reading English graduate textbooks and doctoral exam papers in Arabic or French
without losing the notation.

## Why not just use an existing extension

I looked first. The landscape:

| Project | What it is | Why it is not this |
|---|---|---|
| [PDFMathTranslate](https://github.com/PDFMathTranslate/PDFMathTranslate) | Python tool producing a translated PDF with formulas and layout preserved (EMNLP 2025 demo) | Not a browser extension: batch conversion, minutes per book, needs Python. **Use it when you want a translated file** |
| [BabelDOC](https://github.com/funstory-ai/BabelDOC) | The document-translation library behind the above | A library, not a reader |
| [Immersive Translate](https://github.com/immersive-translate/immersive-translate) | The best-known bilingual extension | PDF translation is a paid Pro feature; the extension is not open source |
| [Read Frog](https://github.com/mengxi-ream/read-frog) | Open-source AI reading extension | Web pages only, no PDF reader, no formula protection |
| [kiss-translator](https://github.com/fishjar/kiss-translator) | Minimal open-source bilingual extension | Web pages only, no maths awareness |

So: for **producing** a translated PDF, use PDFMathTranslate. For **reading**
one page after another with the original beside it and the formulas intact,
nothing open source did the job, hence this repository.

## Features

- **Bilingual PDF reader.** Renders with PDF.js, so the text is real DOM and can
  be translated. Chrome's own viewer is a native plugin whose text no extension
  can reach.
- **Real paragraphs, not lines.** The PDF text layer is a soup of positioned
  spans. They are regrouped into lines, then into paragraphs by line spacing,
  indentation and sentence endings. Line-by-line translators produce nonsense;
  this does not.
- **Hyphenation repair.** `vocabu-` + `lary` becomes `vocabulary` before it is
  sent anywhere.
- **Formula protection.** Every `$...$`, `\( ... \)`, LaTeX command, expression
  with a relation or big operator, `x^2`, `a_n`, `f(x)`, or lone Greek symbol is
  replaced by an opaque placeholder, then restored verbatim. `-5 > 2` stays
  `-5 > 2`.
- **Translate on scroll.** An IntersectionObserver translates the visible page
  plus the next few, so scrolling feels instant instead of translating a
  400-page book up front.
- **Cached.** Keyed by engine, language pair and content hash. Re-reading a
  chapter costs nothing.
- **Polite to the API.** Bounded concurrency, exponential backoff shared
  browser-wide on HTTP 429, and per-paragraph error reporting instead of a dead
  page.
- **Four engines.** Free Google endpoint by default; Google Cloud, DeepL, or a
  self-hosted LibreTranslate with a key.
- **Web pages too.** `Alt+T` inserts a translation under each block, keeping the
  original in place. Right-click a selection to translate just that.
- **RTL aware.** Arabic, Hebrew, Persian and Urdu switch direction and get a
  larger reading size automatically.

## Install

```bash
git clone https://github.com/abdelouahabmostafaetu-bot/dz-math-translate.git
cd dz-math-translate
node scripts/fetch-pdfjs.mjs        # downloads vendor/pdfjs (Node 18+)
```

Then `chrome://extensions` -> **Developer mode** -> **Load unpacked** -> select
the folder containing `manifest.json`.

Full walkthrough, engines and troubleshooting: [`docs/INSTALL.md`](docs/INSTALL.md).

## Use it on a local book

Extensions cannot intercept `file://` URLs, so for a PDF in your `Downloads`:

1. click the extension icon -> **PDF reader**
2. **Open PDF**, or simply drag the file into the tab

Then scroll. The pane on the side fills in as you go. Hover a translation to
outline the original paragraph; click a paragraph in the PDF to jump to its
translation. Tick **Original** to read both texts in the pane.

Online PDFs open in the reader automatically.

## Shortcuts

| Key | Action |
|---|---|
| `Alt+T` | translate / restore the current web page |
| `Alt+P` | open the bilingual PDF reader |

Remap at `chrome://extensions/shortcuts`.

## Settings

All in the popup: target language, engine and key, formula protection,
hyphenation repair, show-original, PDF takeover, pages translated ahead,
parallel requests, and cache size with a clear button.

## Architecture

`src/background.js` is the only place that touches the network, which gives one
shared cache and one global rate limit, and means the page never talks to a
translation API itself.

The interesting file is [`src/lib/segment.js`](src/lib/segment.js): text repair
and formula protection. The paragraph reconstruction lives in
[`src/viewer/viewer.js`](src/viewer/viewer.js).

Full explanation: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Honest limits

- **Scanned PDFs** have no text layer, so there is nothing to translate. Run
  `ocrmypdf` on them first.
- **The free Google endpoint is undocumented.** It can throttle you or change
  without notice, and heavy automated use is not what it is published for. That
  is exactly why keyed engines are supported; switch if you read all day.
- **The formula detector is regular expressions, not a parser.** It catches the
  common cases well and will miss exotic notation. `MATH_PATTERNS` is meant to
  be edited for your field.
- **Machine translation of mathematics is a reading aid, not a source.** For
  anything you will publish, read the original.
- **No translated-PDF output.** Use PDFMathTranslate or BabelDOC for that.

## Licence

MIT, see [`LICENSE`](LICENSE). PDF.js is downloaded at install time and stays
under its own Apache-2.0 licence.
