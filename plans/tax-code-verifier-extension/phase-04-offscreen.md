# Phase 04 — Offscreen Document (Tesseract.js OCR)

**Parent plan:** [plan.md](plan.md)
**Depends on:** [phase-01-scaffold.md](phase-01-scaffold.md)

## Overview
| Field | Value |
|-------|-------|
| Date | 2026-03-05 |
| Priority | P1 |
| Effort | 1h |
| Status | pending |

Implement the offscreen document that hosts Tesseract.js. Receives CAPTCHA image (base64 PNG), preprocesses it on canvas (grayscale + contrast), runs OCR, returns `{text, confidence}`.

## Key Insights
- MV3 offscreen documents have full DOM access (unlike service workers) — required for Tesseract.js
- Only **one** offscreen document can exist at a time in MV3
- Offscreen doc persists until explicitly closed; we keep it alive for the whole batch session
- Tesseract.js v5 `createWorker()` API: worker is initialized once, reused for all CAPTCHAs
- CAPTCHA on this site: simple alphanumeric (likely 4-6 chars), basic font — Tesseract with `eng` trained data works but needs preprocessing
- **Preprocessing pipeline:** grayscale → histogram equalization (or simple contrast boost) → Otsu threshold → invert if background is dark → scale up 3x (Tesseract works better on larger images)
- `tesseract.recognize()` returns `{data: {text, confidence}}` — confidence is 0-100
- Normalize threshold: `confidence / 100 >= 0.70` → accept

## Tesseract Configuration
```javascript
// Tesseract config for CAPTCHA (short alphanumeric strings)
const worker = await Tesseract.createWorker('eng', 1, {
  workerPath: chrome.runtime.getURL('lib/tesseract.min.js'), // if bundled
  // OR load from CDN since offscreen.html is a real page context
});
await worker.setParameters({
  tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  tessedit_pageseg_mode: '8',  // PSM_SINGLE_WORD — treats image as single word
});
```

## Preprocessing Pipeline
```javascript
function preprocessCaptcha(base64) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      // Scale up 3x for better OCR accuracy
      const SCALE = 3;
      const canvas = document.createElement('canvas');
      canvas.width = img.width * SCALE;
      canvas.height = img.height * SCALE;
      const ctx = canvas.getContext('2d');

      // Draw scaled
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // Get pixel data
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      for (let i = 0; i < data.length; i += 4) {
        // Grayscale (luminosity method)
        const gray = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
        // Threshold at 128 (binary: black or white)
        const val = gray > 128 ? 255 : 0;
        data[i] = data[i+1] = data[i+2] = val;
        data[i+3] = 255; // fully opaque
      }

      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.src = base64;
  });
}
```

## Architecture

```
offscreen.html
  <script src="../lib/tesseract.min.js"></script>
  <script src="offscreen.js"></script>

offscreen.js
  ├── Tesseract worker (initialized once on load)
  ├── chrome.runtime.onMessage listener:
  │     action: 'OCR_CAPTCHA'
  │     payload: { imageData: 'data:image/png;base64,...' }
  │     response: { text: 'AB3X', confidence: 0.85 }
  └── preprocessCaptcha() → Tesseract.recognize() → clean text → respond
```

## Message Protocol
```javascript
// Background → Offscreen
{ action: 'OCR_CAPTCHA', imageData: 'data:image/png;base64,...' }

// Offscreen → Background (sendResponse)
{ text: 'AB3X2', confidence: 0.85 }
// OR on error:
{ text: '', confidence: 0 }
```

## Implementation Steps

### offscreen.html
```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
  <!-- Canvas for preprocessing (hidden) -->
  <canvas id="processCanvas" style="display:none"></canvas>
  <script src="../lib/tesseract.min.js"></script>
  <script src="offscreen.js"></script>
</body>
</html>
```

### offscreen.js
```javascript
let tesseractWorker = null;

async function initWorker() {
  tesseractWorker = await Tesseract.createWorker('eng');
  await tesseractWorker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    tessedit_pageseg_mode: '8',
  });
}

initWorker();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'OCR_CAPTCHA') return false;

  (async () => {
    try {
      if (!tesseractWorker) await initWorker();
      const processed = await preprocessCaptcha(msg.imageData);
      const { data } = await tesseractWorker.recognize(processed);
      const text = data.text.replace(/[^A-Za-z0-9]/g, '').trim();
      const confidence = data.confidence / 100;
      sendResponse({ text, confidence });
    } catch (err) {
      sendResponse({ text: '', confidence: 0 });
    }
  })();

  return true; // keep channel open for async response
});
```

## Text Cleanup
After OCR, clean the returned text:
```javascript
const text = data.text
  .replace(/\s/g, '')           // remove spaces
  .replace(/[^A-Za-z0-9]/g, '') // remove non-alphanumeric
  .trim();
```

## Todo
- [ ] Create offscreen.html
- [ ] Implement preprocessCaptcha() with 3x scaling + grayscale + threshold
- [ ] Initialize Tesseract worker with PSM_SINGLE_WORD + char whitelist
- [ ] Implement OCR_CAPTCHA message handler with async response
- [ ] Test with sample CAPTCHA images from site
- [ ] Tune threshold value if accuracy is poor (start at 128, try 100-150)

## Success Criteria
- Worker initializes without errors
- Simple alphanumeric CAPTCHA image returns confidence >= 0.7 at least 75% of the time
- Text output is alphanumeric only (no spaces, punctuation)
- Responds within 3s per CAPTCHA

## Risks
- Tesseract accuracy on distorted CAPTCHAs may be below 70% — retry logic is the fallback
- `createWorker` with bundled path: if Tesseract cannot load traineddata locally, falls back to CDN (fine for offscreen page context)
- PSM 8 (single word) may miss multi-word CAPTCHAs — can try PSM 7 (single line) as alternative

## Next Steps
→ Phase 05: Content Script
