# Phase 03 — Background Service Worker

**Parent plan:** [plan.md](plan.md)
**Depends on:** [phase-01-scaffold.md](phase-01-scaffold.md)

## Overview
| Field | Value |
|-------|-------|
| Date | 2026-03-05 |
| Priority | P1 |
| Effort | 2h |
| Status | pending |

The core orchestrator. Manages the queue, controls the single lookup tab, implements retry logic, keeps the service worker alive via `chrome.alarms`, and coordinates messages between popup, offscreen, and content script.

## Key Insights
- MV3 service workers sleep after 30s of inactivity — `chrome.alarms` fires every 25s to keep it alive
- Service worker has NO DOM — cannot use Tesseract.js directly (that's why we have the offscreen doc)
- Service worker restarts are transparent: state is recovered from `chrome.storage.local` on startup
- Tab management: reuse the same tab for all lookups (don't open/close per record)
- After form submit, page does a full reload → need to detect when the new page has settled
- Use `chrome.tabs.onUpdated` with `status === 'complete'` to know page is ready
- `chrome.scripting.executeScript` runs in the tab's main world (or isolated world) — use isolated world (default) for safety; content.js is also declared for message passing

## State Schema (chrome.storage.local)
```javascript
{
  queue: [{code: "0123456789", rowIdx: 5}],  // pending
  current: {code, rowIdx, retryCount},        // in progress
  results: [{code, rowIdx, status, name, taxAuthority, mstStatus}],
  progress: {total, done, found, notFound, errors, isPaused, isStopped},
  tabId: 123,                                  // reused tab
  phase: "idle" | "running" | "paused" | "done"
}
```

## Result Schema
```javascript
{
  code: "0123456789",
  rowIdx: 5,
  status: "FOUND" | "NOT_FOUND" | "ERROR_CAPTCHA" | "ERROR_NETWORK",
  name: "Lê Phương Các",           // only if FOUND
  taxAuthority: "Thuế cơ sở 7...", // only if FOUND
  mstStatus: "NNT đang hoạt động"  // only if FOUND
}
```

## Architecture

```
background.js
├── chrome.alarms.create("keepalive", { periodInMinutes: 0.4 })
├── chrome.alarms.onAlarm → no-op (just prevents sleep)
├── chrome.runtime.onMessage listener:
│   ├── LOAD_QUEUE → save to storage
│   ├── START → processNext()
│   ├── PAUSE → set phase=paused
│   ├── RESUME → processNext()
│   └── STOP → cleanup tab, set phase=idle
├── chrome.tabs.onUpdated → when tab completes load → triggerPageRead()
├── processNext():
│   ├── pop from queue, set current
│   ├── navigate tab to TARGET_URL (or reload if already there)
│   └── wait for tab load → handled by onUpdated listener
├── triggerPageRead():
│   ├── executeScript → content.js getCaptchaImage()
│   ├── sendMessage to offscreen → OCR
│   ├── get {text, confidence}
│   ├── if confidence < 0.7 → reloadAndRetry()
│   ├── executeScript → content.js fillAndSubmit(code, captchaText)
│   └── wait for tab reload → handled by onUpdated
├── handleResult(result):
│   ├── FOUND/NOT_FOUND → save, processNext()
│   ├── CAPTCHA_ERROR → retryCount++, if < 5 → reloadTab(), else → markError()
└── reloadTab() → chrome.tabs.reload(tabId)
```

## Implementation Steps

### 1. Keepalive alarm
```javascript
const TARGET_URL = 'https://tracuunnt.gdt.gov.vn/tcnnt/mstcn.jsp';
const MAX_RETRIES = 5;
const DELAY_MS = 1500;

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {}); // no-op

chrome.runtime.onInstalled.addListener(recoverState);
chrome.runtime.onStartup.addListener(recoverState);
```

### 2. State management helpers
```javascript
async function getState() {
  return chrome.storage.local.get(['queue','current','results','progress','tabId','phase']);
}
async function setState(patch) {
  await chrome.storage.local.set(patch);
}
```

### 3. processNext()
```javascript
async function processNext() {
  const { queue, phase, tabId } = await getState();
  if (phase === 'paused' || phase === 'idle') return;
  if (!queue || queue.length === 0) {
    await setState({ phase: 'done' });
    return;
  }
  const [current, ...rest] = queue;
  await setState({ queue: rest, current: { ...current, retryCount: 0 } });

  // Ensure tab exists
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch {}
  if (!tab) {
    tab = await chrome.tabs.create({ url: TARGET_URL, active: false });
    await setState({ tabId: tab.id });
  } else {
    await chrome.tabs.update(tab.id, { url: TARGET_URL });
  }
  // onUpdated listener will fire when page loads
}
```

### 4. Tab lifecycle listener
```javascript
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  const state = await getState();
  if (tabId !== state.tabId || info.status !== 'complete') return;
  if (state.phase !== 'running') return;
  if (!tab.url?.includes('tracuunnt.gdt.gov.vn')) return;

  // Small delay to let JS on the page execute
  await delay(800);
  await triggerPageRead();
});
```

### 5. triggerPageRead() — get CAPTCHA and page state
```javascript
async function triggerPageRead() {
  const { tabId, current } = await getState();

  // Step A: get CAPTCHA image base64 from content script
  const [{ result: imgData }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: getCaptchaBase64,  // defined in content.js or inlined
  });

  // Step B: if page shows result already (e.g., after submit), read result
  const [{ result: pageState }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: readPageState,
  });

  if (pageState.type === 'CAPTCHA_ERROR') {
    await handleCaptchaError();
    return;
  }
  if (pageState.type === 'RESULT') {
    await handleResult(pageState.data);
    return;
  }

  // Step C: Fresh form — run OCR
  await ensureOffscreen();
  const { text, confidence } = await chrome.runtime.sendMessage({
    action: 'OCR_CAPTCHA', imageData: imgData
  });

  if (confidence < 0.70) {
    await reloadAndRetry('low_confidence');
    return;
  }

  // Step D: fill and submit
  await chrome.scripting.executeScript({
    target: { tabId },
    func: fillAndSubmit,
    args: [current.code, text],
  });
  // onUpdated will fire after submit (page reloads)
}
```

### 6. Result handling
```javascript
async function handleResult(data) {
  const { current, results = [], progress } = await getState();
  const result = { ...current, ...data };
  const newResults = [...results, result];
  const newProgress = {
    ...progress,
    done: progress.done + 1,
    found: data.status === 'FOUND' ? progress.found + 1 : progress.found,
    notFound: data.status === 'NOT_FOUND' ? progress.notFound + 1 : progress.notFound,
  };
  await setState({ results: newResults, progress: newProgress });
  await delay(DELAY_MS);
  await processNext();
}

async function handleCaptchaError() {
  const { current } = await getState();
  if (current.retryCount >= MAX_RETRIES - 1) {
    await handleResult({ status: 'ERROR_CAPTCHA' });
    return;
  }
  await setState({ current: { ...current, retryCount: current.retryCount + 1 } });
  await delay(500);
  await chrome.tabs.reload(current.tabId); // onUpdated fires → triggerPageRead again
}
```

### 7. Offscreen management
```javascript
async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen/offscreen.html'),
      reasons: ['DOM_SCRAPING'],
      justification: 'Tesseract.js OCR requires DOM canvas API',
    });
  }
}
```

## Todo
- [ ] Write background.js with alarms keepalive
- [ ] Implement state management helpers
- [ ] Implement processNext() with tab management
- [ ] Implement chrome.tabs.onUpdated listener
- [ ] Implement triggerPageRead() orchestration
- [ ] Implement handleResult() and handleCaptchaError()
- [ ] Implement ensureOffscreen() helper
- [ ] Test pause/resume/stop flows

## Success Criteria
- Background stays alive for 30+ min batch (alarms working)
- State survives popup close and reopen
- Retry loop caps at 5 and marks ERROR_CAPTCHA correctly
- processNext() correctly pops queue and navigates tab

## Risks
- `chrome.offscreen.hasDocument` is async; race conditions if called rapidly — use a module-level flag
- Tab might be manually closed by user mid-batch — add `chrome.tabs.onRemoved` listener to reopen
- Page load timeout: if tab never fires `status=complete` (network error) — add a 30s watchdog timer

## Security Considerations
- No user data leaves the extension (no external API calls)
- All processing is local

## Next Steps
→ Phase 04: Offscreen Document (Tesseract OCR)
