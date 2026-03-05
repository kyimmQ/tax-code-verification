// offscreen.js — Tesseract OCR for CAPTCHA solving
// Loaded inside offscreen.html (full DOM + canvas access).
//
// All Tesseract assets are bundled locally in lib/:
//   - tesseract.min.js        (loaded via <script> in offscreen.html)
//   - worker.min.js           (Tesseract web worker)
//   - tesseract-core-simd-lstm.wasm.js  (emscripten JS glue)
//   - tesseract-core-simd-lstm.wasm     (WASM binary, fetched by the glue)
//   - eng.traineddata.gz      (OCR language data)

let tesseractWorker = null;
let workerInitPromise = null;

async function initWorker() {
  if (tesseractWorker) return tesseractWorker;
  if (workerInitPromise) return workerInitPromise;

  workerInitPromise = (async () => {
    const libUrl = chrome.runtime.getURL("lib");

    const worker = await Tesseract.createWorker("eng", 1, {
      workerPath: libUrl + "/worker.min.js",
      // false → Tesseract calls new Worker(workerPath) directly instead of wrapping
      // it in a blob. A blob: worker cannot importScripts() from chrome-extension://
      // URLs, but a worker created directly from the extension URL can.
      workerBlobURL: false,
      corePath: libUrl,
      langPath: libUrl,
      gzip: true,
      logger: () => {},
    });

    await worker.setParameters({
      tessedit_pageseg_mode: "7", // single text line — higher confidence than PSM 8 on CAPTCHAs
    });

    tesseractWorker = worker;
    console.log("[Offscreen] Tesseract worker ready");
    return worker;
  })();

  return workerInitPromise;
}

// Warm up immediately on load.
initWorker().catch((err) =>
  console.error("[Offscreen] Worker init error:", err),
);

// --- Message handler ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== "OCR_CAPTCHA") return false;

  (async () => {
    try {
      const worker = await initWorker();
      const { data } = await worker.recognize(msg.imageData);

      const text = data.text
        .replace(/\s+/g, "")
        .replace(/[^A-Za-z0-9]/g, "")
        .toLowerCase()
        .trim();

      const confidence = data.confidence / 100;
      console.log(`[Offscreen] OCR: "${text}" conf=${confidence.toFixed(2)}`);
      sendResponse({ text, confidence });
    } catch (err) {
      console.error("[Offscreen] OCR error:", err);
      sendResponse({ text: "", confidence: 0 });
    }
  })();

  return true;
});
