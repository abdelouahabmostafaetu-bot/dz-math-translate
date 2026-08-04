# Install and first run

## 1. Get the code

```bash
git clone https://github.com/abdelouahabmostafaetu-bot/dz-math-translate.git
cd dz-math-translate
```

## 2. Fetch PDF.js

The PDF renderer is not committed (it is a few megabytes of third-party build
output). Download it once:

```bash
node scripts/fetch-pdfjs.mjs
```

You need Node 18 or newer. The files land in `vendor/pdfjs/`. If that directory
is empty the extension still loads, but the PDF reader shows a blank page.

## 3. Load the extension

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `dz-math-translate` folder (the one containing `manifest.json`)

Edge and Brave: identical, at `edge://extensions` / `brave://extensions`.

## 4. Read your book

**A local PDF** (your case, a file in `Downloads`):

- click the extension icon, then **PDF reader**, then **Open PDF**
- or drag the PDF file straight into the reader tab

Dragging a file needs no permission at all, which is why it is the recommended
route for local books.

**A PDF on the web**: just open it. With *Open online PDFs in the reader* on,
the reader takes over automatically.

**A normal web page**: press `Alt+T`, or click **Translate this page**.

## 5. Optional: a better engine

The default engine is the free Google endpoint: no key, no cost, and it will
throttle you if you scroll through a 400-page book in one sitting. If you hit
that, open the popup and switch engine:

| Engine | Key | Notes |
|---|---|---|
| Google (free) | none | default; unofficial endpoint, rate limited |
| Google Cloud | `AIza...` | 500k characters/month free tier, then paid |
| DeepL | `xxxx:fx` | best quality for French and English; free tier 500k/month |
| LibreTranslate | none if self-hosted | fully offline with Docker, weaker quality |

For a fully offline setup:

```bash
docker run -p 5000:5000 libretranslate/libretranslate
```

then set the endpoint to `http://localhost:5000/translate`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Reader tab is blank | `vendor/pdfjs` missing | run `node scripts/fetch-pdfjs.mjs`, reload the extension |
| `[429]` on paragraphs | free endpoint throttling | lower *Parallel requests* to 2, or switch engine |
| Pane says "No prose on this page" | scanned image PDF, no text layer | the PDF needs OCR first (`ocrmypdf`) |
| Nothing happens on `Alt+T` | shortcut taken by another extension | remap it at `chrome://extensions/shortcuts` |
| Chrome's own viewer still opens a local PDF | extensions cannot intercept `file://` | use **Open PDF** or drag and drop |
