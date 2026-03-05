# Phase 07 — Excel Export + Download

**Parent plan:** [plan.md](plan.md)
**Depends on:** [phase-02-popup.md](phase-02-popup.md), [phase-03-background.md](phase-03-background.md)

## Overview
| Field | Value |
|-------|-------|
| Date | 2026-03-05 |
| Priority | P1 |
| Effort | 30m |
| Status | pending |

Implement the export: take the original Excel data, merge with results from storage, add result columns, and trigger download via `chrome.downloads.download()`.

## Key Insights
- Browser extensions cannot write files directly — must use `chrome.downloads.download()`
- `chrome.downloads` API accepts a blob URL — create via `URL.createObjectURL(blob)`
- `chrome.downloads` must be called from background (or popup if downloads permission is granted to popup — it is, since the permission applies extension-wide)
- SheetJS write: `XLSX.write(wb, {type: 'array', bookType: 'xlsx'})` → `Uint8Array` → `Blob`
- Original Excel row structure must be preserved; add 3 new columns at the end:
  - Column "Kết quả" (Result): FOUND / NOT_FOUND / ERROR_CAPTCHA / ERROR_NETWORK
  - Column "Tên NNT" (Taxpayer name): filled if FOUND
  - Column "Trạng thái MST" (Tax status): e.g., "NNT đang hoạt động"
- Result lookup: `results[]` from storage, indexed by `rowIdx`

## Architecture

Export triggered from popup's "Tải kết quả" button:
```
popup.js:
  btnExport.onclick:
    1. Get results from chrome.storage.local
    2. Get original rows (stored in module scope or re-read from original file data)
    3. Use SheetJS to build modified workbook
    4. Convert to blob → URL.createObjectURL
    5. chrome.downloads.download({url, filename: 'ket-qua-tra-cuu-mst.xlsx'})
    6. Clean up blob URL after download
```

## Implementation

### Storage for original file data
When the user loads the Excel file (Phase 02), store the raw file data so it can be used for export:
```javascript
// In popup.js, after SheetJS parse:
const fileBuffer = await file.arrayBuffer();
// Store original workbook data in storage for export
await chrome.storage.local.set({
  originalFile: Array.from(new Uint8Array(fileBuffer)),
  taxCodeColIdx: colIdx,
  fileSheetName: wb.SheetNames[0],
});
```

### Export function (popup.js)
```javascript
async function exportResults() {
  const { originalFile, taxCodeColIdx, fileSheetName, results = [] } =
    await chrome.storage.local.get(['originalFile', 'taxCodeColIdx', 'fileSheetName', 'results']);

  // Rebuild workbook from stored buffer
  const buf = new Uint8Array(originalFile).buffer;
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[fileSheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  // Build result lookup by rowIdx
  const resultByRow = {};
  for (const r of results) {
    resultByRow[r.rowIdx] = r;
  }

  // Add header columns
  if (rows[0]) {
    rows[0].push('Kết quả', 'Tên NNT', 'Trạng thái MST', 'Cơ quan thuế');
  }

  // Add result data to each row
  for (let i = 1; i < rows.length; i++) {
    const result = resultByRow[i]; // rowIdx = i (1-based, skipping header)
    if (result) {
      rows[i].push(
        result.status,
        result.name || '',
        result.mstStatus || '',
        result.taxAuthority || '',
      );
    } else {
      rows[i].push('PENDING', '', '', '');
    }
  }

  // Build new sheet from modified rows
  const newWs = XLSX.utils.aoa_to_sheet(rows);

  // Style result column (optional — SheetJS CE doesn't support cell styles)
  // Use conditional formatting via data only

  wb.Sheets[fileSheetName] = newWs;

  // Write to buffer
  const outBuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const blob = new Blob([outBuf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });

  // Download
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({
    url,
    filename: `ket-qua-tra-cuu-mst-${Date.now()}.xlsx`,
    saveAs: true,
  });

  // Cleanup
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
```

## Result Status Values
| Status | Vietnamese label |
|--------|-----------------|
| `FOUND` | Tìm thấy |
| `NOT_FOUND` | Không tìm thấy |
| `ERROR_CAPTCHA` | Lỗi CAPTCHA (5 lần thử) |
| `ERROR_NETWORK` | Lỗi mạng |
| `PENDING` | Chưa kiểm tra |

Consider writing Vietnamese labels instead of English codes for better usability:
```javascript
const STATUS_LABELS = {
  FOUND: 'Tìm thấy',
  NOT_FOUND: 'Không tìm thấy',
  ERROR_CAPTCHA: 'Lỗi CAPTCHA',
  ERROR_NETWORK: 'Lỗi mạng',
};
```

## Storage Consideration
- 1000 rows × (code + status + name + authority) ≈ ~100KB — well within `chrome.storage.local` 10MB limit
- `originalFile` as Uint8Array in storage: 1MB Excel → ~4MB JSON (base64-encoded) — acceptable

## Todo
- [ ] Store original file buffer in chrome.storage.local on load
- [ ] Implement exportResults() in popup.js
- [ ] Wire "Tải kết quả" button to exportResults()
- [ ] Show button only when phase=done or results.length > 0
- [ ] Test: export with partial results (some PENDING)
- [ ] Test: export with 100+ rows

## Success Criteria
- "Tải kết quả" button triggers browser download dialog
- Downloaded Excel contains all original columns + 4 new result columns
- FOUND rows show taxpayer name and status
- NOT_FOUND and ERROR rows show correct labels
- Filename includes timestamp

## Risks
- Large original file (5MB+): storing as Uint8Array in storage may hit limits → alternative: re-read from IndexedDB or require user to re-select file for export
- `chrome.downloads.download` needs `saveAs: true` for user to choose location; if `false`, saves to default downloads folder

## Unresolved Questions
- Should we use Vietnamese status labels (better UX) or English codes (easier programmatic processing)?
- If original Excel > 5MB: need IndexedDB instead of chrome.storage.local

## Next Steps
→ All phases complete. Load unpacked in Chrome and test E2E.
