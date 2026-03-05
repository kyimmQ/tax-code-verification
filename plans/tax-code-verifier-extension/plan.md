---
title: "Tax Code Verifier - Chrome MV3 Extension"
description: "Batch Vietnamese personal tax code (MST) verification via tracuunnt.gdt.gov.vn with Tesseract CAPTCHA solving and Excel I/O"
status: pending
priority: P1
effort: 8h
branch: main
tags: [chrome-extension, mv3, tesseract, captcha, excel, vietnam, tax]
created: 2026-03-05
---

# Tax Code Verifier — Chrome MV3 Extension

Batch-verify Vietnamese personal tax codes (MST TNCN) against the official GDT portal. Reads an Excel file, checks each code one-by-one, solves CAPTCHA via Tesseract.js OCR, and exports results back to Excel.

## Target Site
`https://tracuunnt.gdt.gov.vn/tcnnt/mstcn.jsp`

## Phases

| # | Phase | File | Status | Est |
|---|-------|------|--------|-----|
| 1 | Project Scaffold & Manifest | [phase-01-scaffold.md](phase-01-scaffold.md) | pending | 30m |
| 2 | Popup UI + SheetJS Excel Read | [phase-02-popup.md](phase-02-popup.md) | pending | 1.5h |
| 3 | Background Service Worker | [phase-03-background.md](phase-03-background.md) | pending | 2h |
| 4 | Offscreen Document (Tesseract OCR) | [phase-04-offscreen.md](phase-04-offscreen.md) | pending | 1h |
| 5 | Content Script (Site Interaction) | [phase-05-content-script.md](phase-05-content-script.md) | pending | 1.5h |
| 6 | Message Passing & Wiring | [phase-06-wiring.md](phase-06-wiring.md) | pending | 1h |
| 7 | Excel Export + Download | [phase-07-excel-export.md](phase-07-excel-export.md) | pending | 30m |

## Output File Structure
```
tax-code-verifier/
├── manifest.json
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── background/
│   └── background.js
├── content/
│   └── content.js
├── offscreen/
│   ├── offscreen.html
│   └── offscreen.js
└── lib/
    ├── xlsx.min.js      (SheetJS UMD)
    └── tesseract.min.js (Tesseract.js UMD v5)
```

## Key DOM Selectors (verified from live page sources)
- Tax code input: `input[name="mst"]`
- CAPTCHA input: `#captcha`
- CAPTCHA image: `img[src*="captcha.png"]`
- Submit: `input.subBtn` or call `search()`
- CAPTCHA error: `p[style*="color:red"]` containing "Vui lòng nhập đúng mã xác nhận"
- Found result: `#resultContainer` with `div[id^="nntName"]`
- Not found: `#resultContainer` td containing "Không tìm thấy người nộp thuế nào phù hợp"
- Taxpayer name: `#resultContainer table tr:nth-child(2) td:nth-child(3)` text
- Tax authority: `#resultContainer table tr:nth-child(2) td:nth-child(4)` text
- Status: `#resultContainer table tr:nth-child(2) td:nth-child(5)` text

## Processing Logic
```
For each tax code:
  retry = 0
  while retry < 5:
    load/reload page → wait for img[src*="captcha.png"] to load
    capture CAPTCHA img → canvas preprocess → Tesseract OCR
    if confidence < 70%: reload, retry++, continue
    fill mst + captcha → submit form
    wait for page to load
    detect result:
      CAPTCHA error → reload, retry++
      #resultContainer + "Không tìm thấy" → mark NOT_FOUND, break
      #resultContainer + name data → mark FOUND + extract data, break
  if retry >= 5: mark ERROR_CAPTCHA
  wait 1500ms → next tax code
```
