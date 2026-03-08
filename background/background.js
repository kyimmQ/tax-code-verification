// background.js — Tax Code Verifier service worker (ES Module)

const TARGET_URL = "https://tracuunnt.gdt.gov.vn/tcnnt/mstcn.jsp";
const MAX_RETRIES = 20;
const DELAY_MS = 2000;
const WATCHDOG_MS = 30000;

// Module-level flags — reset on SW restart
let isProcessing = false;
let watchdogTimer = null;

// --- Keepalive alarm (fires every 24s to prevent SW sleep) ---
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  /* no-op, just keeps SW awake */
});

// --- State helpers ---
async function getState() {
  return chrome.storage.local.get([
    "queue",
    "current",
    "results",
    "progress",
    "tabId",
    "phase",
  ]);
}

async function setState(patch) {
  return chrome.storage.local.set(patch);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// =============================================================================
// INJECTABLE FUNCTIONS (self-contained — no external refs, stringified by Chrome)
// =============================================================================

function getCaptchaBase64() {
  return new Promise((resolve, reject) => {
    const img = document.querySelector('img[src*="captcha.png"]');
    if (!img) {
      console.log("[Page] CAPTCHA image element not found in DOM");
      reject(new Error("CAPTCHA image not found"));
      return;
    }

    console.log(
      `[Page] CAPTCHA img found — src="${img.src}" complete=${img.complete} naturalSize=${img.naturalWidth}x${img.naturalHeight}`,
    );

    function drawAndReturn() {
      try {
        const SCALE = 2; // 2x upscale improves Tesseract accuracy on the small 130×50 source
        const canvas = document.createElement("canvas");
        canvas.width = (img.naturalWidth || img.width || 130) * SCALE;
        canvas.height = (img.naturalHeight || img.height || 35) * SCALE;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff"; // white background — handles transparent CAPTCHAs
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/png");
        console.log(
          `[Page] CAPTCHA canvas drawn — size=${canvas.width}x${canvas.height} dataLen=${dataUrl.length}`,
        );
        resolve(dataUrl);
      } catch (e) {
        console.log(`[Page] CAPTCHA canvas draw error: ${e.message}`);
        reject(e);
      }
    }

    if (img.complete && img.naturalWidth > 0) {
      drawAndReturn();
    } else {
      console.log("[Page] CAPTCHA img not yet loaded — waiting for onload");
      img.onload = drawAndReturn;
      img.onerror = () => reject(new Error("CAPTCHA img load error"));
    }
  });
}

function fillAndSubmit(taxCode, captchaText) {
  const mstInput = document.querySelector('input[name="mst"]');
  const captchaInput = document.querySelector("#captcha");
  const submitBtn = document.querySelector("input.subBtn");

  if (!mstInput || !captchaInput || !submitBtn) {
    const msg =
      "Form elements not found: mst=" +
      !!mstInput +
      " captcha=" +
      !!captchaInput +
      " btn=" +
      !!submitBtn;
    console.log("[Page] " + msg);
    throw new Error(msg);
  }

  console.log(
    `[Page] Filling form — taxCode="${taxCode}" captcha="${captchaText}"`,
  );
  mstInput.value = String(taxCode);
  captchaInput.value = String(captchaText);
  submitBtn.click();
  console.log("[Page] Form submitted");
  return true;
}

function readPageState() {
  // 1. Check CAPTCHA error
  const redPs = document.querySelectorAll(
    'p[style*="color:red"], p[style*="color: red"]',
  );
  for (const p of redPs) {
    if (p.textContent.includes("nhập đúng mã")) {
      console.log(
        `[Page] State=CAPTCHA_ERROR — red error: "${p.textContent.trim()}"`,
      );
      return { type: "CAPTCHA_ERROR" };
    }
  }

  // 2. Check result container
  const rc = document.querySelector("#resultContainer");
  if (!rc) {
    console.log(
      "[Page] State=FRESH_FORM — no #resultContainer, no captcha error",
    );
    return { type: "FRESH_FORM" };
  }

  // 3. Not found?
  const allTds = rc.querySelectorAll("td");
  for (const td of allTds) {
    if (td.textContent.includes("Không tìm thấy người nộp thuế")) {
      console.log("[Page] State=RESULT/NOT_FOUND");
      return { type: "RESULT", data: { status: "NOT_FOUND" } };
    }
  }

  // 4. Found — extract data
  const allRows = rc.querySelectorAll("table tbody tr, table tr");
  const dataRows = Array.from(allRows).filter((r) => !r.querySelector("th"));

  if (dataRows.length === 0) {
    console.log(
      "[Page] State=FRESH_FORM — #resultContainer present but no data rows",
    );
    return { type: "FRESH_FORM" };
  }

  const cells = dataRows[0].querySelectorAll("td");
  if (cells.length < 5) {
    console.log(
      `[Page] State=FRESH_FORM — result row has only ${cells.length} cells (need 5)`,
    );
    return { type: "FRESH_FORM" };
  }

  const taxCode = (cells[1]?.textContent || "").trim();
  const name = (cells[2]?.textContent || "").trim();
  const taxAuthority = (cells[3]?.textContent || "").trim();
  const mstStatus = (cells[4]?.textContent || "").trim();

  // Extract extra rows (starting from index 1)
  const extraRows = [];
  if (dataRows.length > 1) {
    for (let i = 1; i < dataRows.length; i++) {
      const rowCells = dataRows[i].querySelectorAll("td");
      if (rowCells.length >= 5) {
        extraRows.push({
          taxCode: (rowCells[1]?.textContent || "").trim(),
          name: (rowCells[2]?.textContent || "").trim(),
          taxAuthority: (rowCells[3]?.textContent || "").trim(),
          mstStatus: (rowCells[4]?.textContent || "").trim(),
        });
      }
    }
  }

  console.log(
    `[Page] State=RESULT/FOUND — name="${name}" authority="${taxAuthority}" status="${mstStatus}" extraRows=${extraRows.length}`,
  );

  return {
    type: "RESULT",
    data: { status: "FOUND", name, taxAuthority, mstStatus, taxCode, extraRows },
  };
}

// =============================================================================
// OFFSCREEN DOCUMENT
// =============================================================================

async function ensureOffscreen() {
  let hasDoc = false;
  try {
    hasDoc = await chrome.offscreen.hasDocument();
  } catch {}

  if (!hasDoc) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("offscreen/offscreen.html"),
      reasons: ["DOM_SCRAPING"],
      justification:
        "Tesseract.js OCR requires canvas API for CAPTCHA preprocessing",
    });
  }
}

// =============================================================================
// WATCHDOG
// =============================================================================

function startWatchdog() {
  clearWatchdog();
  watchdogTimer = setTimeout(async () => {
    console.warn("[BG] Watchdog fired — marking ERROR_NETWORK");
    isProcessing = false;
    const { current, results = [], progress = {} } = await getState();
    if (current) {
      await recordFinalResult(
        current,
        results,
        progress,
        "ERROR_NETWORK",
        "Lỗi mạng",
        {},
      );
    }
  }, WATCHDOG_MS);
}

function clearWatchdog() {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

// =============================================================================
// FINAL RESULT RECORDING (helper shared by both phases)
// =============================================================================

async function recordFinalResult(
  current,
  results,
  progress,
  status,
  dongBoValue,
  pageData,
) {
  const result = {
    cccdCode: current.cccdCode || "",
    mstCode: current.mstCode || "",
    rowIdx: current.rowIdx,
    status,
    dongBoValue,
    name: pageData.name || "",
    taxAuthority: pageData.taxAuthority || "",
    mstStatus: pageData.mstStatus || "",
    foundMst: pageData.taxCode || "",
    extraRows: pageData.extraRows || [],
  };

  console.log(
    `[BG] Final: row=${current.rowIdx} status=${status} dongBo="${dongBoValue}"`,
  );

  const newProgress = {
    ...progress,
    done: (progress.done || 0) + 1,
    dongBo: (progress.dongBo || 0) + (status === "DONG_BO" ? 1 : 0),
    chuaDongBo:
      (progress.chuaDongBo || 0) + (status === "CHUA_DONG_BO" ? 1 : 0),
    khongTimThay:
      (progress.khongTimThay || 0) + (status === "KHONG_TIM_THAY" ? 1 : 0),
    errors: (progress.errors || 0) + (status.startsWith("ERROR") ? 1 : 0),
    currentCode: "",
    currentPhase: "",
  };

  await setState({
    results: [...results, result],
    progress: newProgress,
    current: null,
  });
  await delay(DELAY_MS);
  await processNext();
}

// =============================================================================
// RETRY / RELOAD
// =============================================================================

async function reloadAndRetry(reason) {
  const { current, tabId, results = [], progress = {} } = await getState();
  if (!current) return;

  const retryCount = (current.retryCount || 0) + 1;
  console.log(
    `[BG] Retry #${retryCount}/${MAX_RETRIES} — reason="${reason}" phase=${current.lookupPhase} code="${current.activeCode}"`,
  );

  if (retryCount >= MAX_RETRIES) {
    // CCCD phase exhausted → fall back to MST (treat as NOT_FOUND on CCCD)
    if (current.lookupPhase === "CCCD") {
      isProcessing = false;
      await handleResult({ status: "NOT_FOUND" });
    } else {
      // MST phase exhausted → final error
      isProcessing = false;
      await recordFinalResult(
        current,
        results,
        progress,
        "ERROR_CAPTCHA",
        "Lỗi CAPTCHA",
        {},
      );
    }
    return;
  }

  await setState({ current: { ...current, retryCount } });
  isProcessing = false;
  startWatchdog();
  try {
    // Navigate to URL directly instead of reload — avoids "Confirm Form Resubmission" dialog
    // that browsers show when reloading a POST response.
    await chrome.tabs.update(tabId, { url: TARGET_URL });
  } catch (err) {
    console.error("[BG] Tab navigate failed:", err);
    isProcessing = false;
    await recordFinalResult(
      current,
      results,
      progress,
      "ERROR_NETWORK",
      "Lỗi mạng",
      {},
    );
  }
}

// =============================================================================
// RESULT HANDLING — two-phase decision tree
// =============================================================================

async function handleResult(pageData) {
  const { current, results = [], progress = {}, tabId } = await getState();
  if (!current) return;

  if (current.lookupPhase === "CCCD") {
    if (pageData.status === "FOUND") {
      // Compare input CCCD with the MST found on the web
      const inputCode = (current.cccdCode || "").trim();
      const foundCode = (pageData.taxCode || "").trim();
      const matched = inputCode && foundCode && inputCode === foundCode;
      const dongBoValue = matched ? "ĐỒNG BỘ" : "KHÔNG KHỚP";
      await recordFinalResult(
        current,
        results,
        progress,
        "DONG_BO",
        dongBoValue,
        pageData,
      );
      return;
    }

    // CCCD not found (or error) → try MST
    if (!current.mstCode) {
      // No fallback available
      await recordFinalResult(
        current,
        results,
        progress,
        "KHONG_TIM_THAY",
        "Không tìm thấy",
        {},
      );
      return;
    }

    // Switch to MST phase — update current, navigate tab
    console.log(
      `[BG] CCCD not found for row=${current.rowIdx}, trying MST: ${current.mstCode}`,
    );
    await setState({
      current: {
        ...current,
        lookupPhase: "MST",
        activeCode: current.mstCode,
        retryCount: 0,
      },
      progress: {
        ...progress,
        currentCode: current.mstCode,
        currentPhase: "MST",
      },
    });
    isProcessing = false;
    startWatchdog();
    try {
      await chrome.tabs.update(tabId, { url: TARGET_URL });
    } catch (err) {
      console.error("[BG] Tab update failed during phase switch:", err);
      await recordFinalResult(
        current,
        results,
        progress,
        "ERROR_NETWORK",
        "Lỗi mạng",
        {},
      );
    }
    return;
  }

  // MST phase
  if (pageData.status === "FOUND") {
    await recordFinalResult(
      current,
      results,
      progress,
      "CHUA_DONG_BO",
      "Chưa đồng bộ",
      pageData,
    );
  } else {
    await recordFinalResult(
      current,
      results,
      progress,
      "KHONG_TIM_THAY",
      "Không tìm thấy",
      {},
    );
  }
}

// =============================================================================
// PAGE READING & CAPTCHA SOLVING
// =============================================================================

async function triggerPageRead() {
  clearWatchdog();
  const { tabId, current } = await getState();

  if (!tabId || !current) {
    isProcessing = false;
    return;
  }

  console.log(
    `[BG] ── triggerPageRead row=${current.rowIdx} phase=${current.lookupPhase} code="${current.activeCode}" retry=${current.retryCount || 0}`,
  );

  try {
    // Step 1: Read current page state
    console.log("[BG] Step 1: reading page state...");
    const [{ result: pageState }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readPageState,
    });
    console.log(`[BG] Step 1 done: pageState.type="${pageState.type}"`);

    if (pageState.type === "CAPTCHA_ERROR") {
      console.log("[BG] → CAPTCHA wrong, reloading for retry");
      isProcessing = false;
      await reloadAndRetry("captcha_error");
      return;
    }

    if (pageState.type === "RESULT") {
      console.log(`[BG] → Got result: ${JSON.stringify(pageState.data)}`);
      isProcessing = false;
      await handleResult(pageState.data);
      return;
    }

    // Step 2: FRESH_FORM — grab CAPTCHA image
    console.log("[BG] Step 2: capturing CAPTCHA image...");
    const [{ result: imgData }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: getCaptchaBase64,
    });

    if (!imgData) {
      console.log("[BG] Step 2 failed: no image data returned");
      isProcessing = false;
      await reloadAndRetry("no_captcha_image");
      return;
    }
    console.log(`[BG] Step 2 done: image captured (${imgData.length} chars)`);

    // Step 3: OCR
    console.log("[BG] Step 3: sending image to OCR...");
    await ensureOffscreen();
    let ocrResult;
    try {
      ocrResult = await chrome.runtime.sendMessage({
        action: "OCR_CAPTCHA",
        imageData: imgData,
      });
    } catch (err) {
      console.warn("[BG] OCR sendMessage failed:", err);
      ocrResult = { text: "", confidence: 0 };
    }

    if (!ocrResult || ocrResult.text.length < 3 || ocrResult.confidence < 0.1) {
      console.log(
        `[BG] Step 3 failed: OCR low confidence — conf=${ocrResult?.confidence?.toFixed(2)} text="${ocrResult?.text}"`,
      );
      isProcessing = false;
      await reloadAndRetry("low_confidence");
      return;
    }

    console.log(
      `[BG] Step 3 done: OCR ok — text="${ocrResult.text}" conf=${ocrResult.confidence.toFixed(2)}`,
    );

    // Step 4: Fill and submit using the active code for this phase
    console.log(
      `[BG] Step 4: submitting form — taxCode="${current.activeCode}" captcha="${ocrResult.text}"`,
    );
    await chrome.scripting.executeScript({
      target: { tabId },
      func: fillAndSubmit,
      args: [current.activeCode, ocrResult.text],
    });
    console.log(
      "[BG] Step 4 done: form submitted — waiting for page navigation",
    );

    // Page will navigate after submit — onUpdated fires next
    isProcessing = false;
    startWatchdog();
  } catch (err) {
    console.error("[BG] triggerPageRead error:", err);
    isProcessing = false;
    await reloadAndRetry("unexpected_error").catch(console.error);
  }
}

// =============================================================================
// QUEUE PROCESSING
// =============================================================================

async function processNext() {
  const { queue, phase, tabId, progress } = await getState();

  if (phase !== "running") return;

  if (!queue || queue.length === 0) {
    console.log("[BG] Queue empty — done!");
    await setState({ phase: "done" });
    return;
  }

  const [item, ...rest] = queue;

  // Determine starting phase for this item
  const lookupPhase = item.cccdCode ? "CCCD" : "MST";
  const activeCode = lookupPhase === "CCCD" ? item.cccdCode : item.mstCode;

  if (!activeCode) {
    // Both codes empty — record immediately without lookup
    const { results = [] } = await getState();
    await setState({ queue: rest });
    await recordFinalResult(
      { ...item, retryCount: 0, lookupPhase, activeCode: "" },
      results,
      progress,
      "KHONG_TIM_THAY",
      "Không tìm thấy",
      {},
    );
    return;
  }

  await setState({
    queue: rest,
    current: { ...item, retryCount: 0, lookupPhase, activeCode },
    progress: {
      ...progress,
      currentCode: activeCode,
      currentPhase: lookupPhase,
    },
  });

  console.log(
    `[BG] Processing row=${item.rowIdx} phase=${lookupPhase} code="${activeCode}" (${rest.length} remaining in queue)`,
  );
  let tab = null;
  if (tabId) {
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {}
  }

  if (!tab) {
    tab = await chrome.tabs.create({ url: TARGET_URL, active: false });
    await setState({ tabId: tab.id });
    console.log(`[BG] Created new tab ${tab.id}`);
  } else {
    await chrome.tabs.update(tab.id, { url: TARGET_URL });
    console.log(
      `[BG] Navigated tab ${tab.id} → phase=${lookupPhase} code=${activeCode}`,
    );
  }

  startWatchdog();
}

// =============================================================================
// STATE RECOVERY ON SW RESTART
// =============================================================================

async function recoverState() {
  const { phase, queue, current } = await getState();
  if (phase === "running") {
    console.log("[BG] Recovering interrupted batch...");
    // Re-queue the interrupted item from the beginning (CCCD phase)
    const requeue = current
      ? [
          {
            cccdCode: current.cccdCode || "",
            mstCode: current.mstCode || "",
            rowIdx: current.rowIdx,
          },
          ...(queue || []),
        ]
      : queue || [];
    await setState({ queue: requeue, current: null });
    isProcessing = false;
    await processNext();
  }
}

// =============================================================================
// EVENT LISTENERS
// =============================================================================

// Initialize fresh state on first install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    phase: "idle",
    queue: [],
    results: [],
    current: null,
    tabId: null,
    progress: {
      total: 0,
      done: 0,
      dongBo: 0,
      chuaDongBo: 0,
      khongTimThay: 0,
      errors: 0,
      isPaused: false,
      isStopped: false,
      currentCode: "",
      currentPhase: "",
    },
  });
  console.log("[BG] Extension installed, state initialized.");
});

// Recover on SW restart
chrome.runtime.onStartup.addListener(recoverState);

// Message handler from popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action) {
        case "LOAD_QUEUE": {
          const { taxCodes } = msg;
          await setState({
            queue: taxCodes,
            results: [],
            current: null,
            phase: "idle",
            progress: {
              total: taxCodes.length,
              done: 0,
              dongBo: 0,
              chuaDongBo: 0,
              khongTimThay: 0,
              errors: 0,
              isPaused: false,
              isStopped: false,
              currentCode: "",
              currentPhase: "",
            },
          });
          sendResponse({ ok: true });
          break;
        }
        case "START": {
          isProcessing = false;
          await setState({ phase: "running" });
          await processNext();
          sendResponse({ ok: true });
          break;
        }
        case "PAUSE": {
          clearWatchdog();
          const { progress } = await getState();
          await setState({
            phase: "paused",
            progress: { ...progress, isPaused: true },
          });
          sendResponse({ ok: true });
          break;
        }
        case "RESUME": {
          const { progress } = await getState();
          await setState({
            phase: "running",
            progress: { ...progress, isPaused: false },
          });
          isProcessing = false;
          await processNext();
          sendResponse({ ok: true });
          break;
        }
        case "STOP": {
          clearWatchdog();
          isProcessing = false;
          const { tabId, progress } = await getState();
          if (tabId) {
            try {
              await chrome.tabs.remove(tabId);
            } catch {}
          }
          await setState({
            phase: "idle",
            tabId: null,
            current: null,
            progress: { ...progress, isStopped: true },
          });
          sendResponse({ ok: true });
          break;
        }
        case "GET_STATE": {
          const state = await getState();
          sendResponse(state);
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown action: " + msg.action });
      }
    } catch (err) {
      console.error("[BG] Message handler error:", err);
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true; // Keep message channel open for async response
});

// Tab load completed → trigger page read
chrome.tabs.onUpdated.addListener(async (updatedTabId, info, tab) => {
  if (info.status !== "complete") return;
  if (isProcessing) return;

  const { tabId: storedTabId, phase } = await getState();
  if (!storedTabId || updatedTabId !== storedTabId) return;
  if (phase !== "running") return;
  if (!tab.url || !tab.url.includes("tracuunnt.gdt.gov.vn")) return;

  console.log(
    `[BG] Tab ${updatedTabId} loaded: "${tab.url}" — waiting ${DELAY_MS}ms then reading page`,
  );
  isProcessing = true;
  try {
    await delay(DELAY_MS); // let page JS execute
    await triggerPageRead();
  } catch (err) {
    console.error("[BG] onUpdated handler error:", err);
    isProcessing = false;
  }
});

// Handle tab closure mid-batch
chrome.tabs.onRemoved.addListener(async (removedTabId) => {
  const { tabId, phase } = await getState();
  if (removedTabId === tabId && phase === "running") {
    console.log("[BG] Lookup tab closed by user — will reopen on next attempt");
    await setState({ tabId: null });
  }
});
