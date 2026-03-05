# Phase 01 — Project Scaffold & Manifest

**Parent plan:** [plan.md](plan.md)

## Overview
| Field | Value |
|-------|-------|
| Date | 2026-03-05 |
| Priority | P1 |
| Effort | 30m |
| Status | pending |

Set up the extension directory, `manifest.json`, and download/bundle the required libraries (SheetJS + Tesseract.js).

## Key Insights
- MV3 requires `"manifest_version": 3`
- Offscreen document API needs `"offscreen"` permission
- `scripting` permission needed to inject content script programmatically
- `downloads` permission for exporting result Excel
- Host permission for `https://tracuunnt.gdt.gov.vn/*`
- Tesseract.js v5 UMD build works in browser environments; traineddata can be loaded from CDN at runtime (no need to bundle 4MB eng.traineddata)
- SheetJS community edition (xlsx.js) UMD build ~1MB; must be bundled (no CDN allowed in MV3)

## Requirements
- [ ] `manifest.json` with all required permissions and component declarations
- [ ] `lib/` directory with SheetJS UMD bundled
- [ ] Tesseract.js loaded via CDN in offscreen.html (avoids bundling 4MB traineddata)
- [ ] Directory structure matching the plan

## Architecture

```
manifest.json declares:
  background.service_worker = "background/background.js"
  action.default_popup      = "popup/popup.html"
  content_scripts           = [] (injected programmatically via chrome.scripting)
  web_accessible_resources  = ["offscreen/offscreen.html"]
  permissions = [storage, scripting, downloads, tabs, offscreen, alarms]
  host_permissions = ["https://tracuunnt.gdt.gov.vn/*"]
```

## Implementation Steps

### 1. Create directory structure
```
mkdir -p tax-code-verifier/{popup,background,content,offscreen,lib,icons}
```

### 2. manifest.json
```json
{
  "manifest_version": 3,
  "name": "Tax Code Verifier (MST TNCN)",
  "version": "1.0.0",
  "description": "Batch verify Vietnamese personal tax codes via GDT portal",
  "permissions": ["storage", "scripting", "downloads", "tabs", "offscreen", "alarms"],
  "host_permissions": ["https://tracuunnt.gdt.gov.vn/*"],
  "background": {
    "service_worker": "background/background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "Tax Code Verifier"
  },
  "web_accessible_resources": [{
    "resources": ["offscreen/offscreen.html", "lib/*"],
    "matches": ["<all_urls>"]
  }],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
```

### 3. Download libraries
```bash
# SheetJS (must be bundled - MV3 no external CDN in service workers)
curl -L https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js -o lib/xlsx.min.js

# Tesseract.js UMD (offscreen.html can use script tags with CDN or local)
# Option A: Bundle locally
curl -L https://unpkg.com/tesseract.js@5/dist/tesseract.min.js -o lib/tesseract.min.js
# Traineddata: loaded at runtime from CDN within offscreen doc (allowed since offscreen is a page context)
```

### 4. Icons (optional placeholder)
Create simple 16x16, 48x48, 128x128 placeholder PNGs or use a text-based SVG.

## Todo
- [ ] Create all directories
- [ ] Write manifest.json
- [ ] Download SheetJS UMD → lib/xlsx.min.js
- [ ] Download Tesseract.js UMD → lib/tesseract.min.js
- [ ] Verify manifest loads in Chrome (chrome://extensions → Load unpacked)

## Success Criteria
- Extension loads in Chrome without errors
- All 5 directories exist with correct structure
- `manifest.json` validates with no warnings

## Risks
- Tesseract.js UMD size (~900KB) — acceptable
- MV3 CSP blocks inline scripts — offscreen.html must use external script tags only

## Next Steps
→ Phase 02: Popup UI
