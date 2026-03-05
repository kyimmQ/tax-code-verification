# Phase 05 — Content Script (Site Interaction)

**Parent plan:** [plan.md](plan.md)
**Depends on:** [phase-01-scaffold.md](phase-01-scaffold.md)

## Overview
| Field | Value |
|-------|-------|
| Date | 2026-03-05 |
| Priority | P1 |
| Effort | 1.5h |
| Status | pending |

Implement the functions that run inside the target website's tab. These are injected via `chrome.scripting.executeScript()` as **isolated functions**, NOT as a persistent content script. Each function is a self-contained unit that reads or writes the DOM.

## Key Insights (from real page source analysis)

### Verified DOM selectors
| Element | Selector |
|---------|----------|
| Tax code input | `input[name="mst"]` |
| CAPTCHA input | `#captcha` or `input[name="captcha"]` |
| CAPTCHA image | `img[src*="captcha.png"]` (height=35) |
| Submit trigger | `input.subBtn` click OR call `search()` |
| CAPTCHA error msg | `p[style*='color:red']` containing "Vui lòng nhập đúng mã xác nhận" |
| Result container | `#resultContainer` |
| Not found text | `#resultContainer td` containing "Không tìm thấy người nộp thuế nào phù hợp" |
| Taxpayer name | `#resultContainer table tbody tr:first-child td:nth-child(3)` inner text |
| Tax authority | `#resultContainer table tbody tr:first-child td:nth-child(4)` inner text |
| MST status | `#resultContainer table tbody tr:first-child td:nth-child(5)` inner text |

### Page state after submission (detected by readPageState())
1. **Fresh form** — no `#resultContainer`, no red error `<p>` → ready for input
2. **CAPTCHA error** — red `<p>` with "Vui lòng nhập đúng mã xác nhận" present, no `#resultContainer`
3. **Not found** — `#resultContainer` exists, contains "Không tìm thấy người nộp thuế nào phù hợp"
4. **Found** — `#resultContainer` exists, has `div[id^="nntName"]` with name text

### CAPTCHA image to base64
Since content scripts run in isolated world but within the page's origin context, the CAPTCHA image (same origin) can be drawn to a canvas. However, the image might not be fully loaded yet. Must wait for `img.complete && img.naturalWidth > 0`.

## Architecture

Three injectable functions (called via `chrome.scripting.executeScript`):

```
1. getCaptchaBase64()
   → waits for captcha img to load
   → draws to canvas → preprocessing → returns base64

2. fillAndSubmit(taxCode, captchaText)
   → clears and fills mst input with taxCode
   → clears and fills #captcha with captchaText
   → clicks .subBtn (triggers search() which submits form)

3. readPageState()
   → inspects current DOM
   → returns { type: 'FRESH_FORM' | 'CAPTCHA_ERROR' | 'RESULT', data? }
```

## Implementation Steps

### 1. getCaptchaBase64()
```javascript
function getCaptchaBase64() {
  return new Promise((resolve, reject) => {
    const img = document.querySelector('img[src*="captcha.png"]');
    if (!img) return reject(new Error('CAPTCHA image not found'));

    function drawAndReturn() {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } catch (e) {
        reject(e);
      }
    }

    if (img.complete && img.naturalWidth > 0) {
      drawAndReturn();
    } else {
      img.onload = drawAndReturn;
      img.onerror = () => reject(new Error('CAPTCHA img load error'));
      // Force reload in case img is stuck
      img.src = img.src + '&r=' + Date.now();
    }
  });
}
```

**IMPORTANT**: This function is serialized and injected via `executeScript`. It must be self-contained (no external deps). The `return new Promise(...)` pattern works because `executeScript` awaits the resolved value when the function is async or returns a Promise.

### 2. fillAndSubmit(taxCode, captchaText)
```javascript
function fillAndSubmit(taxCode, captchaText) {
  const mstInput = document.querySelector('input[name="mst"]');
  const captchaInput = document.querySelector('#captcha');
  const submitBtn = document.querySelector('input.subBtn');

  if (!mstInput || !captchaInput || !submitBtn) {
    throw new Error('Form elements not found');
  }

  // Clear and fill tax code
  mstInput.value = '';
  mstInput.value = taxCode;

  // Clear and fill CAPTCHA
  captchaInput.value = '';
  captchaInput.value = captchaText;

  // Submit — click the button which calls search() → document.myform.submit()
  submitBtn.click();

  return true;
}
```

Note: `document.myform.submit()` would bypass the `search()` function's CAPTCHA validation. Better to click `.subBtn` which calls `search()`. The `search()` function just calls `document.myform.submit()` so direct click is fine.

### 3. readPageState()
```javascript
function readPageState() {
  // Check for CAPTCHA error
  const redParagraphs = document.querySelectorAll('p[style*="color:red"]');
  for (const p of redParagraphs) {
    if (p.textContent.includes('Vui lòng nhập đúng mã xác nhận') ||
        p.textContent.includes('nhập đúng mã')) {
      return { type: 'CAPTCHA_ERROR' };
    }
  }

  // Check for result container
  const resultContainer = document.querySelector('#resultContainer');
  if (!resultContainer) {
    return { type: 'FRESH_FORM' };
  }

  // Check for "not found"
  const allTds = resultContainer.querySelectorAll('td');
  for (const td of allTds) {
    if (td.textContent.includes('Không tìm thấy người nộp thuế nào phù hợp')) {
      return { type: 'RESULT', data: { status: 'NOT_FOUND' } };
    }
  }

  // Found — extract data from result table
  // Table structure: STT | MST | Tên người nộp thuế | Cơ quan thuế | Trạng thái MST
  const rows = resultContainer.querySelectorAll('table tbody tr, table tr');
  // Skip header row (th), get first data row
  const dataRows = [...rows].filter(r => !r.querySelector('th'));
  if (dataRows.length === 0) {
    return { type: 'FRESH_FORM' }; // Unexpected — treat as fresh
  }

  const cells = dataRows[0].querySelectorAll('td');
  if (cells.length < 5) {
    return { type: 'FRESH_FORM' };
  }

  return {
    type: 'RESULT',
    data: {
      status: 'FOUND',
      name: cells[2]?.textContent?.trim() || '',
      taxAuthority: cells[3]?.textContent?.trim() || '',
      mstStatus: cells[4]?.textContent?.trim() || '',
    }
  };
}
```

## Injection Pattern (in background.js)
```javascript
// getCaptchaBase64 — returns a Promise (executeScript handles this)
const [{ result: base64 }] = await chrome.scripting.executeScript({
  target: { tabId },
  func: getCaptchaBase64,
  // Note: funcs injected this way must be defined in background.js or inlined
});

// fillAndSubmit
await chrome.scripting.executeScript({
  target: { tabId },
  func: fillAndSubmit,
  args: [taxCode, captchaText],
});

// readPageState
const [{ result: pageState }] = await chrome.scripting.executeScript({
  target: { tabId },
  func: readPageState,
});
```

**Key**: These functions are defined in `background.js` and injected as serialized functions. They do NOT import anything — must be 100% self-contained.

## Waiting for CAPTCHA image
The CAPTCHA image URL `/tcnnt/captcha.png?uid=` loads a fresh CAPTCHA each page load. After page `status=complete`, wait 800ms before calling `getCaptchaBase64` to ensure image is rendered.

## Handling the "reapply" case
The `page_source_reapply_capcha.html` page shows the red error paragraph AND shows the form again (no `#resultContainer`). This is correctly detected as `CAPTCHA_ERROR` by `readPageState()`.

## Todo
- [ ] Define getCaptchaBase64() as self-contained injectable function
- [ ] Define fillAndSubmit() as self-contained injectable function
- [ ] Define readPageState() with all 4 state detections
- [ ] Test each function independently by pasting into Chrome DevTools console on the target page
- [ ] Verify canvas.toDataURL works (same-origin image, no CORS issues)
- [ ] Test with page_source_found.html — verify data extraction correctness
- [ ] Test with page_source_not_found.html — verify NOT_FOUND detection
- [ ] Test with page_source_reapply_capcha.html — verify CAPTCHA_ERROR detection

## Success Criteria
- `getCaptchaBase64()` returns valid PNG base64 within 2s
- `readPageState()` correctly classifies all 4 page states
- `fillAndSubmit()` causes page form submission
- All functions are self-contained (no external imports)

## Risks
- CAPTCHA image CORS: since content script runs in page context (same origin), `drawImage` should work — but if server sends `X-Frame-Options` or CORP headers, canvas may be tainted. **Mitigation**: use `img.crossOrigin = 'anonymous'` before setting `src`, though this may fail if server doesn't send CORS headers. **Fallback**: fetch the image URL directly via `fetch()` in the content script (same origin = no CORS issue).
- Selector fragility: site uses minimal CSS classes — selectors based on `name` attributes are stable
- The red paragraph style is inline (`style='color:red;'`) — selector `p[style*='color:red']` is robust

## Next Steps
→ Phase 06: Message Passing & Wiring
