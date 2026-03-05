# Page Interaction Guide

How the extension interacts with `https://tracuunnt.gdt.gov.vn/tcnnt/mstcn.jsp`.

---

## High-Level Flow

```
Popup (user)
  │ LOAD_QUEUE / START
  ▼
background.js (service worker)
  │ creates / navigates a hidden tab
  ▼
GDT page loads (onUpdated "complete")
  │ 5 s delay, then triggerPageRead()
  ▼
  ┌─ Step 1: readPageState() ──────── injected into tab
  ├─ Step 2: getCaptchaBase64() ───── injected into tab
  ├─ Step 3: OCR via offscreen.html ─ Tesseract.js
  └─ Step 4: fillAndSubmit() ──────── injected into tab
       │ page navigates after submit
       ▼
     back to Step 1 on next onUpdated
```

---

## Injectable Functions (background.js)

These three functions are **stringified and injected** into the tab via `chrome.scripting.executeScript`.
They run inside the GDT page's context and have full DOM access.
They must be **self-contained** — no closures, imports, or external references.

### `getCaptchaBase64()` — lines 40–78

**Purpose:** Capture the CAPTCHA image as a PNG data URL.

**DOM target:**
```
img[src*="captcha.png"]
  → actual src: /tcnnt/captcha.png?uid=<session-uid>
```

**What it does:**
1. Finds the `<img>` element.
2. Waits for `img.complete && img.naturalWidth > 0` (or `onload`).
3. Creates an off-screen `<canvas>` at **2× the natural size** (improves OCR on the ~130×50 source image).
4. Fills the canvas with a white background (handles transparent PNGs).
5. Draws the image onto the canvas.
6. Returns `canvas.toDataURL("image/png")` — a base64 data URL.

**Logs emitted (in the tab's DevTools console):**
```
[Page] CAPTCHA img found — src="..." complete=true naturalSize=130x35
[Page] CAPTCHA canvas drawn — size=260x70 dataLen=<N>
```

---

### `fillAndSubmit(taxCode, captchaText)` — lines 80–97

**Purpose:** Fill the search form and submit it.

**DOM targets:**
| Selector | Role |
|---|---|
| `input[name="mst"]` | Tax code field |
| `#captcha` | CAPTCHA text field |
| `input.subBtn` | Submit button (calls `search()` → `document.myform.submit()`) |

**What it does:**
1. Sets `mstInput.value = taxCode`
2. Sets `captchaInput.value = captchaText`
3. Calls `submitBtn.click()` — triggers the page's `search()` function which calls `document.myform.submit()`

**Logs emitted:**
```
[Page] Filling form — taxCode="089203002398" captcha="5eb2f"
[Page] Form submitted
```

---

### `readPageState()` — lines 99–151

**Purpose:** Detect which of the 4 page states the tab is currently in and extract result data.

**Page states and how they are detected:**

| State | Detection logic | Return value |
|---|---|---|
| `FRESH_FORM` | No `#resultContainer` AND no red error `<p>` | `{ type: "FRESH_FORM" }` |
| `CAPTCHA_ERROR` | `p[style*="color:red"]` containing `"nhập đúng mã"` | `{ type: "CAPTCHA_ERROR" }` |
| `RESULT/NOT_FOUND` | `#resultContainer` td containing `"Không tìm thấy người nộp thuế"` | `{ type: "RESULT", data: { status: "NOT_FOUND" } }` |
| `RESULT/FOUND` | `#resultContainer` table has data rows (no `<th>`) with ≥5 cells | `{ type: "RESULT", data: { status: "FOUND", name, taxAuthority, mstStatus } }` |

**Actual page DOM for CAPTCHA_ERROR:**
```html
<p style='color:red;'>Vui lòng nhập đúng mã xác nhận!</p>
```

**Actual page DOM for RESULT/FOUND:**
```html
<div id="resultContainer">
  <table class="ta_border">
    <tr><th>STT</th><th>MST</th><th>Tên người nộp thuế</th><th>Cơ quan thuế</th><th>Trạng thái MST</th></tr>
    <tr>
      <td>1</td>                        <!-- cells[0] — row index -->
      <td>089203002398</td>             <!-- cells[1] — MST -->
      <td><div id="nntName1">Lê Phương Các</div></td>  <!-- cells[2] — name -->
      <td>Thuế cơ sở 7 tỉnh An Giang</td>              <!-- cells[3] — tax authority -->
      <td>NNT đang hoạt động</td>       <!-- cells[4] — MST status -->
    </tr>
  </table>
</div>
```

**Data extracted:**
- `name` → `cells[2].textContent`
- `taxAuthority` → `cells[3].textContent`
- `mstStatus` → `cells[4].textContent`

**Logs emitted:**
```
[Page] State=FRESH_FORM — no #resultContainer, no captcha error
[Page] State=CAPTCHA_ERROR — red error: "Vui lòng nhập đúng mã xác nhận!"
[Page] State=RESULT/NOT_FOUND
[Page] State=RESULT/FOUND — name="Lê Phương Các" authority="..." status="NNT đang hoạt động"
```

---

## triggerPageRead() — background.js lines 383–494

The orchestrator. Called every time the tab finishes loading.

```
Step 1  executeScript(readPageState)
          ├── CAPTCHA_ERROR → reloadAndRetry("captcha_error")
          ├── RESULT        → handleResult(pageData)
          └── FRESH_FORM    → continue to Step 2

Step 2  executeScript(getCaptchaBase64)
          └── no image → reloadAndRetry("no_captcha_image")

Step 3  sendMessage to offscreen.html { action: "OCR_CAPTCHA", imageData }
          └── low confidence / short text → reloadAndRetry("low_confidence")

Step 4  executeScript(fillAndSubmit, [activeCode, ocrText])
          └── page navigates → onUpdated fires → back to Step 1
```

**Service worker logs:**
```
[BG] Tab 123 loaded: "https://tracuunnt..." — waiting 5000ms then reading page
[BG] ── triggerPageRead row=5 phase=CCCD code="089203002398" retry=0
[BG] Step 1: reading page state...
[BG] Step 1 done: pageState.type="FRESH_FORM"
[BG] Step 2: capturing CAPTCHA image...
[BG] Step 2 done: image captured (12453 chars)
[BG] Step 3: sending image to OCR...
[BG] Step 3 done: OCR ok — text="5eb2f" conf=0.77
[BG] Step 4: submitting form — taxCode="089203002398" captcha="5eb2f"
[BG] Step 4 done: form submitted — waiting for page navigation
```

---

## OCR Pipeline — offscreen.js

The GDT page is cross-origin to the extension, so the service worker cannot run Tesseract directly (no canvas API). Instead it uses an **Offscreen Document**.

```
background.js
  sendMessage({ action: "OCR_CAPTCHA", imageData: "<data URL>" })
       ↓
offscreen.html (hidden DOM page, full API access)
  offscreen.js → Tesseract.createWorker("eng")
               → worker.recognize(imageData)
               → strip non-alphanumeric, lowercase
               → sendResponse({ text, confidence })
       ↓
background.js receives { text: "5eb2f", confidence: 0.77 }
```

**Tesseract settings:**
- PSM 7 — single text line (best for 5-char CAPTCHAs)
- `workerBlobURL: false` — required for MV3; allows worker to load from `chrome-extension://` URL

---

## Two-Phase Lookup Logic

Each Excel row may have both a CCCD code and an MST code. The extension tries them in order:

```
Phase CCCD
  FOUND  → status = DONG_BO,        dongBoValue = cccdCode
  NOT_FOUND, retries exhausted
         → switch to Phase MST

Phase MST
  FOUND  → status = CHUA_DONG_BO,   dongBoValue = "Chưa đồng bộ"
  NOT_FOUND → status = KHONG_TIM_THAY
  retries exhausted → status = ERROR_CAPTCHA
```

Max retries: **10 per phase** (`MAX_RETRIES` constant, background.js line 4).
Delay between records: **5 s** (`DELAY_MS` constant, background.js line 5).

---

## Where to Find Each Concern

| Concern | File | Key lines |
|---|---|---|
| CAPTCHA image capture | `background/background.js` | `getCaptchaBase64` fn ~40 |
| Form fill & submit | `background/background.js` | `fillAndSubmit` fn ~80 |
| Page state detection | `background/background.js` | `readPageState` fn ~99 |
| Step orchestration | `background/background.js` | `triggerPageRead` fn ~383 |
| Result interpretation | `background/background.js` | `handleResult` fn ~293 |
| Retry logic | `background/background.js` | `reloadAndRetry` fn ~241 |
| Queue management | `background/background.js` | `processNext` fn ~500 |
| OCR (Tesseract) | `offscreen/offscreen.js` | entire file |
| Popup / Excel import | `popup/popup.js` | entire file |
