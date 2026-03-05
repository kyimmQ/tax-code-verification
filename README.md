# Tax Code Verifier (MST TNCN)

A Chrome extension that batch-verifies Vietnamese personal income tax codes (MST TNCN) against the General Department of Taxation portal — automatically solving CAPTCHAs via on-device OCR (Tesseract.js).

---

## How it works

1. You upload an Excel file containing CCCD / MST codes
2. The extension opens a hidden browser tab and navigates to the GDT lookup portal
3. For each row it reads the CAPTCHA image, runs OCR, fills and submits the form
4. Results are written back to the original Excel file for download

**Two-phase lookup per row:**
- Phase 1 — search by **CCCD** → if found: status = `Đồng bộ`
- Phase 2 — fallback to **MST** → if found: status = `Chưa đồng bộ`; if not found: `Không tìm thấy`

---

## Install (unpacked)

> Requires Chrome with **Developer mode** enabled.

1. Download the latest `tax-code-verifier-vX.X.X.zip` from [Releases](../../releases)
2. Unzip it
3. Open Chrome → `chrome://extensions`
4. Enable **Developer mode** (toggle, top-right)
5. Click **Load unpacked** → select the unzipped folder

To update: remove the old extension, repeat from step 1.

---

## Usage

1. Click the extension icon in the Chrome toolbar
2. Drag-and-drop your Excel file (`.xlsx` / `.xls`) onto the drop zone
3. Confirm the auto-detected column mapping:
   - **Thông tin CCCD** — column containing CCCD numbers
   - **MST (cũ)** — column containing old MST codes (fallback)
   - **Đồng bộ CCCD** — output column where results will be written
4. Click **Tải danh sách** to load the queue
5. Click **Bắt đầu** to start processing
6. Use **Tạm dừng** / **Tiếp tục** to pause mid-batch
7. When finished, click **Xuất Excel** to download the updated file

---

## Excel file format

| Thông tin CCCD | MST (cũ) | Đồng bộ CCCD |
|---|---|---|
| 089203002398 | 0123456789 | _(output written here)_ |

Column names are auto-detected by keyword — the exact header text does not need to match exactly.

---

## Result values

| Status | Meaning | Value written to Excel |
|---|---|---|
| Đồng bộ | CCCD found on portal | The CCCD number itself |
| Chưa đồng bộ | CCCD not found, MST found | `Chưa đồng bộ` |
| Không tìm thấy | Neither code found | `Không tìm thấy` |
| Lỗi CAPTCHA | OCR failed after 10 retries | `Lỗi CAPTCHA` |
| Lỗi mạng | Network or tab error | `Lỗi mạng` |

---

## Development

### Project structure

```
manifest.json          Chrome MV3 manifest
background/
  background.js        Service worker — queue, OCR orchestration, tab control
offscreen/
  offscreen.html       Hidden DOM page (required for Tesseract canvas access)
  offscreen.js         Tesseract.js OCR worker
popup/
  popup.html           Extension popup UI
  popup.js             Popup logic — file loading, progress display, export
  popup.css            Popup styles
lib/
  tesseract.min.js     Tesseract.js v5 (bundled locally — no CDN)
  worker.min.js        Tesseract web worker
  tesseract-core-simd-lstm.wasm.js   Emscripten JS glue
  tesseract-core-simd-lstm.wasm      WASM binary
  eng.traineddata.gz   English OCR model (best_int)
  xlsx.min.js          SheetJS — Excel read/write
```

### Run the OCR test script

Tests Tesseract against images in `capchas/`:

```bash
npm install tesseract.js sharp
node test-ocr.mjs
```

### Load for development

```
chrome://extensions → Developer mode ON → Load unpacked → select repo root
```

After editing any file: click the **↺** refresh icon on the extension card.

---

## Creating a release

Releases are automated via GitHub Actions. Pushing a version tag builds and publishes both a `.zip` and a `.crx` to GitHub Releases.

### First-time setup (one-time)

**1. Generate a signing key**

```bash
openssl genrsa -out key.pem 2048
```

Keep `key.pem` safe and backed up. You must use the **same key for every release** — losing it means users need to reinstall from scratch.

**2. Add the key as a GitHub secret**

```bash
# macOS — base64-encode and copy to clipboard
base64 -i key.pem | pbcopy
```

In GitHub: **Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|---|---|
| `CRX_PRIVATE_KEY` | paste the base64 string |

### Publishing a release

```bash
# 1. Bump the version in manifest.json
#    "version": "1.1.0"

# 2. Commit
git add manifest.json
git commit -m "chore: bump version to v1.1.0"

# 3. Tag and push
git tag v1.1.0
git push origin main --tags
```

GitHub Actions will automatically:
- Build `tax-code-verifier-v1.1.0.zip` (for Load unpacked)
- Build `tax-code-verifier-v1.1.0.crx` (signed, for drag-and-drop in Developer mode)
- Create a GitHub Release with both files attached and auto-generated release notes

### Workflow file

See [.github/workflows/release.yml](.github/workflows/release.yml)
