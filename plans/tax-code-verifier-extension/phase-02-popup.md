# Phase 02 — Popup UI + SheetJS Excel Read

**Parent plan:** [plan.md](plan.md)
**Depends on:** [phase-01-scaffold.md](phase-01-scaffold.md)

## Overview
| Field | Value |
|-------|-------|
| Date | 2026-03-05 |
| Priority | P1 |
| Effort | 1.5h |
| Status | pending |

Build the extension popup: file picker, column selector, progress display, control buttons, and result preview. Uses SheetJS to parse Excel files in the browser.

## Key Insights
- Popup is a standard HTML page, runs in its own JS context (not service worker)
- Popup closes when user clicks away — must store all state in `chrome.storage.local`, not JS variables
- `chrome.storage.onChanged` listener updates UI when background updates progress
- SheetJS can parse `.xlsx`/`.xls` from an `ArrayBuffer` (FileReader API)
- Column auto-detection: scan first row for headers matching "mst", "tax", "mã số thuế", "mã số", "msttncn" (case-insensitive)
- Popup width should be ~450px to show table preview; height auto
- Must use `type="module"` or standard script in popup.html (no inline scripts — MV3 CSP)

## Requirements
- [ ] Drag-and-drop or click file picker for `.xlsx`/`.xls`
- [ ] Parse Excel with SheetJS, show sheet/column selector
- [ ] Auto-detect tax code column (search header row for keywords)
- [ ] Display: total records, current tax code, completed count, success/fail/error counts
- [ ] Start / Pause / Resume / Stop buttons
- [ ] Results preview table (last 10 results with status color coding)
- [ ] Download Result button (triggers export — implemented in Phase 07)

## Architecture

```
popup.html
  └── popup.js (module)
        ├── imports: lib/xlsx.min.js (via script tag in HTML, exposes global XLSX)
        ├── FileReader → XLSX.read() → rows[]
        ├── sends {action:"LOAD_QUEUE", taxCodes:[]} to background via chrome.runtime.sendMessage
        ├── chrome.storage.onChanged listener → update progress UI
        └── button handlers → send {action:"START"|"PAUSE"|"RESUME"|"STOP"} to background
```

## Implementation Steps

### popup.html structure
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="popup.css">
  <script src="../lib/xlsx.min.js"></script>
</head>
<body>
  <!-- Drop zone -->
  <div id="dropzone">Kéo thả file Excel hoặc <label for="fileInput">chọn file</label></div>
  <input type="file" id="fileInput" accept=".xlsx,.xls" hidden>

  <!-- Column selector (shown after file load) -->
  <div id="columnSelector" hidden>
    <label>Cột mã số thuế:</label>
    <select id="colSelect"></select>
    <button id="btnLoad">Tải danh sách</button>
  </div>

  <!-- Stats bar -->
  <div id="statsBar" hidden>
    <span id="statTotal">0</span> mã |
    <span id="statDone">0</span> xong |
    <span id="statFound" class="found">0</span> tìm thấy |
    <span id="statNotFound" class="notfound">0</span> không tìm thấy |
    <span id="statError" class="error">0</span> lỗi
  </div>

  <!-- Current processing -->
  <div id="currentCode" hidden>Đang kiểm tra: <b id="codeDisplay"></b></div>

  <!-- Progress bar -->
  <progress id="progressBar" value="0" max="100" hidden></progress>

  <!-- Controls -->
  <div id="controls" hidden>
    <button id="btnStart">Bắt đầu</button>
    <button id="btnPause" disabled>Tạm dừng</button>
    <button id="btnStop" disabled>Dừng</button>
  </div>

  <!-- Results preview -->
  <table id="resultsTable" hidden>
    <thead><tr><th>STT</th><th>MST</th><th>Tên</th><th>Trạng thái</th></tr></thead>
    <tbody id="resultsBody"></tbody>
  </table>

  <!-- Export -->
  <button id="btnExport" hidden>Tải kết quả (.xlsx)</button>

  <script src="popup.js"></script>
</body>
</html>
```

### popup.js key logic
```javascript
// File loading
fileInput.onchange = async (e) => {
  const buf = await e.target.files[0].arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  // store rows in module scope for later export
  window._rows = rows;
  window._wb = wb;
  // populate column selector
  autoDetectColumn(rows[0]); // finds column with "mst"|"tax"|"mã số"
};

// Auto-detect column
function autoDetectColumn(headerRow) {
  const keywords = ['mst', 'tax', 'mã số thuế', 'mã số', 'msttncn', 'taxcode'];
  return headerRow.findIndex(h =>
    keywords.some(k => String(h).toLowerCase().includes(k))
  );
}

// Start button
btnStart.onclick = async () => {
  const colIdx = parseInt(colSelect.value);
  const taxCodes = window._rows.slice(1) // skip header
    .map(row => ({ code: String(row[colIdx] || '').trim(), rowIdx: ... }))
    .filter(r => r.code.length > 0);
  await chrome.runtime.sendMessage({ action: 'LOAD_QUEUE', taxCodes });
  await chrome.runtime.sendMessage({ action: 'START' });
};

// Listen for storage changes to update UI
chrome.storage.onChanged.addListener((changes) => {
  if (changes.progress) updateProgressUI(changes.progress.newValue);
  if (changes.results) updateResultsTable(changes.results.newValue);
});
```

### popup.css
- Width: 460px, clean white design
- Status colors: green (found), orange (not found), red (error)
- Drop zone with dashed border, hover effect
- Progress bar with blue fill

## Todo
- [ ] Write popup.html with all sections
- [ ] Write popup.js: file reader, column detection, SheetJS parse
- [ ] Write popup.js: message handlers (start/pause/stop)
- [ ] Write popup.js: storage listener → UI update
- [ ] Write popup.css
- [ ] Test file loading with sample xlsx

## Success Criteria
- Drag .xlsx file → column list appears, auto-selects correct column
- Clicking "Bắt đầu" sends correct message to background
- Progress UI updates in real-time when background writes to storage
- Results table shows last 10 rows with color coding

## Risks
- Popup closes mid-batch: mitigated by state in chrome.storage (popup reconnects on re-open)
- Large Excel file (1000+ rows) parse time: SheetJS is fast enough (~200ms for 1k rows)

## Next Steps
→ Phase 03: Background Service Worker
