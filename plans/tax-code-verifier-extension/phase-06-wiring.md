# Phase 06 — Message Passing & Component Wiring

**Parent plan:** [plan.md](plan.md)
**Depends on:** [phase-02-popup.md](phase-02-popup.md), [phase-03-background.md](phase-03-background.md), [phase-04-offscreen.md](phase-04-offscreen.md), [phase-05-content-script.md](phase-05-content-script.md)

## Overview
| Field | Value |
|-------|-------|
| Date | 2026-03-05 |
| Priority | P1 |
| Effort | 1h |
| Status | pending |

Wire together all components with a clean message protocol. Define the complete message dictionary, handle edge cases (tab removed, offscreen closed), and ensure the full E2E flow works.

## Complete Message Dictionary

### Popup → Background
| Action | Payload | Response |
|--------|---------|----------|
| `LOAD_QUEUE` | `{taxCodes: [{code, rowIdx}]}` | `{ok: true}` |
| `START` | — | `{ok: true}` |
| `PAUSE` | — | `{ok: true}` |
| `RESUME` | — | `{ok: true}` |
| `STOP` | — | `{ok: true}` |
| `GET_STATE` | — | full state object |
| `EXPORT_REQUEST` | — | triggers download (handled in background) |

### Background → Offscreen
| Action | Payload | Response |
|--------|---------|----------|
| `OCR_CAPTCHA` | `{imageData: 'data:image/png;base64,...'}` | `{text, confidence}` |

### Background → Tab (via executeScript)
| Function | Args | Returns |
|----------|------|---------|
| `readPageState()` | — | `{type, data?}` |
| `getCaptchaBase64()` | — | `string (base64)` |
| `fillAndSubmit()` | `(taxCode, captchaText)` | `true` |

### Storage → Popup (via chrome.storage.onChanged)
```javascript
// progress key
{
  total: 100,
  done: 45,
  found: 30,
  notFound: 10,
  errors: 5,
  isPaused: false,
  isStopped: false,
  currentCode: "0123456789"
}

// results key (last 50 to avoid storage bloat)
[{code, status, name, rowIdx}]
```

## Full E2E Flow Diagram

```
USER ACTION: Opens popup, selects Excel
  popup.js: reads file → SheetJS → taxCodes[]
  popup.js: sends LOAD_QUEUE → background.js saves to storage

USER ACTION: Clicks "Bắt đầu"
  popup.js: sends START
  background.js: sets phase=running, calls processNext()

LOOP (per tax code):
  background.js: processNext()
    → pops queue
    → opens/navigates tab to TARGET_URL
    → chrome.tabs.onUpdated fires (status=complete)
    → delay(800ms)
    → executeScript(readPageState) → {type: 'FRESH_FORM'}
    → executeScript(getCaptchaBase64) → base64
    → sendMessage(offscreen, OCR_CAPTCHA, base64) → {text, confidence}
    → if confidence < 0.7: reloadAndRetry()
    → executeScript(fillAndSubmit, taxCode, captchaText)
    → chrome.tabs.onUpdated fires (status=complete, after submit)
    → delay(800ms)
    → executeScript(readPageState) → {type, data}
    → if CAPTCHA_ERROR: handleCaptchaError()
    → if RESULT: handleResult(data)
    → setState(progress updated)  ← popup.js storage listener updates UI
    → delay(1500ms)
    → processNext() (next iteration)

USER ACTION: Clicks "Tạm dừng"
  popup.js: sends PAUSE
  background.js: sets isPaused=true → processNext() becomes no-op

USER ACTION: Clicks "Tiếp tục"
  popup.js: sends RESUME
  background.js: sets isPaused=false → processNext()

WHEN DONE:
  background.js: queue empty → sets phase=done
  popup.js: storage.onChanged → shows "Tải kết quả" button
```

## Edge Cases & Handling

### Tab removed by user
```javascript
chrome.tabs.onRemoved.addListener(async (removedTabId) => {
  const { tabId, phase } = await getState();
  if (removedTabId === tabId && phase === 'running') {
    await setState({ tabId: null });
    // processNext will open a new tab on next attempt
  }
});
```

### Offscreen document unexpectedly closed
```javascript
// Always call ensureOffscreen() before sending OCR message
// ensureOffscreen() uses chrome.offscreen.hasDocument() + creates if missing
```

### Background service worker restart mid-batch
```javascript
// On service worker startup, check if there's an interrupted batch
async function recoverState() {
  const { phase, queue, current } = await getState();
  if (phase === 'running' && (queue?.length > 0 || current)) {
    // Re-queue the current item (it may have been partially processed)
    if (current) {
      await setState({ queue: [current, ...(queue || [])], current: null });
    }
    await processNext();
  }
}
chrome.runtime.onStartup.addListener(recoverState);
```

### Network timeout
```javascript
// Add 30s watchdog per tax code
let watchdogTimer;
function startWatchdog(tabId) {
  clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(async () => {
    // Tab took too long — mark as error and move on
    await handleResult({ status: 'ERROR_NETWORK' });
  }, 30000);
}
function clearWatchdog() { clearTimeout(watchdogTimer); }
```

## Implementation Checklist

### background.js wiring
- [ ] Message handler: `LOAD_QUEUE` → save queue to storage
- [ ] Message handler: `START` → set phase=running + processNext()
- [ ] Message handler: `PAUSE` / `RESUME` / `STOP`
- [ ] Message handler: `GET_STATE` → return current state
- [ ] `chrome.tabs.onUpdated` listener with correct phase/tab guards
- [ ] `chrome.tabs.onRemoved` listener for tab cleanup
- [ ] `chrome.runtime.onStartup` recovery logic
- [ ] Watchdog timer per lookup cycle

### popup.js wiring
- [ ] `chrome.storage.onChanged` → update all UI elements
- [ ] Re-read state on popup open (`GET_STATE`) to restore UI
- [ ] Disable/enable buttons based on phase (idle/running/paused/done)

### Error propagation
- [ ] All executeScript calls wrapped in try/catch
- [ ] Network errors caught and surfaced as `ERROR_NETWORK`
- [ ] Unknown page states logged and skipped

## Todo
- [ ] Implement all message handlers in background.js
- [ ] Implement storage.onChanged UI sync in popup.js
- [ ] Implement state recovery on SW restart
- [ ] Implement tab removal handler
- [ ] Implement watchdog timer
- [ ] Manual E2E test: load 5 tax codes, verify full flow

## Success Criteria
- Full batch of 5 codes completes without manual intervention
- Popup close + reopen restores progress correctly
- Pausing mid-batch and resuming works correctly
- Tab closure handled gracefully (new tab opened)
- SW restart mid-batch: re-queues current item and continues

## Risks
- Race conditions in onUpdated listener (multiple rapid fires): guard with `isProcessing` flag
- Storage writes too frequent for large batches: batch progress updates every N results if needed
- offscreen.html `reasons`: `'DOM_SCRAPING'` — verify this is an accepted reason in current MV3 spec (alternatively use `'CLIPBOARD'` or `'AUDIO_PLAYBACK'` if rejected)

## Next Steps
→ Phase 07: Excel Export
