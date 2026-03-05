// popup.js — Tax Code Verifier popup logic
// Global XLSX is exposed by ../lib/xlsx.min.js loaded in popup.html

const $ = id => document.getElementById(id);

// Module-level state (ephemeral — clears on popup close)
let parsedRows = null;

// --- DOM refs ---
const dropzone         = $('dropzone');
const fileInput        = $('fileInput');
const fileInfo         = $('fileInfo');
const fileName         = $('fileName');
const btnClearFile     = $('btnClearFile');
const columnSelector   = $('columnSelector');
const colCccd          = $('colCccd');
const colMst           = $('colMst');
const colDongBo        = $('colDongBo');
const btnLoad          = $('btnLoad');
const statsBar         = $('statsBar');
const statTotal        = $('statTotal');
const statDone         = $('statDone');
const statDongBo       = $('statDongBo');
const statChuaDongBo   = $('statChuaDongBo');
const statKhongTimThay = $('statKhongTimThay');
const statError        = $('statError');
const currentCode      = $('currentCode');
const codeDisplay      = $('codeDisplay');
const phaseDisplay     = $('phaseDisplay');
const progressWrap     = $('progressWrap');
const progressBar      = $('progressBar');
const progressPct      = $('progressPct');
const controls         = $('controls');
const btnStart         = $('btnStart');
const btnPause         = $('btnPause');
const btnStop          = $('btnStop');
const resultsWrap      = $('resultsWrap');
const resultsBody      = $('resultsBody');
const btnExport        = $('btnExport');
const btnClearResults  = $('btnClearResults');

// --- Column auto-detection ---
const CCCD_KEYWORDS   = ['cccd', 'thông tin cccd', 'thong tin cccd', 'thongtin'];
const MST_KEYWORDS    = ['mst', 'mã số thuế', 'ma so thue', 'msttncn', 'taxcode'];
const DONGBO_KEYWORDS = ['đồng bộ cccd', 'dong bo cccd', 'đồng bộ', 'dong bo', 'dongbo'];

function autoDetect(headerRow, keywords) {
  return headerRow.findIndex(h =>
    keywords.some(k => String(h).toLowerCase().includes(k))
  );
}

// Fill a <select> element with all headers as options (first option = "-- không chọn --")
function populateSelect(sel, headerRow) {
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = '-1';
  none.textContent = '-- không chọn --';
  sel.appendChild(none);
  headerRow.forEach((h, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `Cột ${i + 1}: ${String(h).slice(0, 35)}`;
    sel.appendChild(opt);
  });
}

// --- File loading ---
async function loadFile(file) {
  if (!file) return;
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  if (!rows || rows.length < 2) {
    alert('File Excel không có dữ liệu hoặc chỉ có 1 dòng.');
    return;
  }

  parsedRows = rows;
  const header = rows[0] || [];

  // Populate all 3 selects with same header options
  populateSelect(colCccd,   header);
  populateSelect(colMst,    header);
  populateSelect(colDongBo, header);

  // Auto-detect each column
  const cccdIdx   = autoDetect(header, CCCD_KEYWORDS);
  const mstIdx    = autoDetect(header, MST_KEYWORDS);
  const dongBoIdx = autoDetect(header, DONGBO_KEYWORDS);

  if (cccdIdx   >= 0) colCccd.value   = cccdIdx;
  if (mstIdx    >= 0) colMst.value    = mstIdx;
  if (dongBoIdx >= 0) colDongBo.value = dongBoIdx;

  // Store file buffer and column indices for export
  await chrome.storage.local.set({
    originalFile:  Array.from(new Uint8Array(buf)),
    fileSheetName: sheetName,
    colCccd:   cccdIdx,
    colMst:    mstIdx,
    colDongBo: dongBoIdx,
  });

  // Show UI
  fileName.textContent = file.name;
  fileInfo.hidden = false;
  dropzone.hidden = true;
  columnSelector.hidden = false;
}

// --- Drop zone ---
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) loadFile(file);
});

btnClearFile.addEventListener('click', () => {
  parsedRows = null;
  fileInput.value = '';
  fileInfo.hidden = true;
  dropzone.hidden = false;
  columnSelector.hidden = true;
});

// Persist column selection changes immediately
[colCccd, colMst, colDongBo].forEach(sel => {
  sel.addEventListener('change', () => {
    chrome.storage.local.set({
      colCccd:   parseInt(colCccd.value,   10),
      colMst:    parseInt(colMst.value,    10),
      colDongBo: parseInt(colDongBo.value, 10),
    });
  });
});

// --- Load queue button ---
btnLoad.addEventListener('click', async () => {
  if (!parsedRows) return;

  const idxCccd   = parseInt(colCccd.value,   10);
  const idxMst    = parseInt(colMst.value,    10);
  const idxDongBo = parseInt(colDongBo.value, 10);

  if (idxDongBo < 0) {
    alert('Vui lòng chọn cột "Đồng bộ CCCD" để ghi kết quả.');
    return;
  }

  // Update storage with user's current column selections
  await chrome.storage.local.set({ colCccd: idxCccd, colMst: idxMst, colDongBo: idxDongBo });

  // Build queue items — include all rows with at least one code
  const queue = parsedRows.slice(1)
    .map((row, idx) => ({
      cccdCode: idxCccd >= 0 ? String(row[idxCccd] || '').trim() : '',
      mstCode:  idxMst  >= 0 ? String(row[idxMst]  || '').trim() : '',
      rowIdx: idx + 1,
    }))
    .filter(r => r.cccdCode || r.mstCode);

  if (queue.length === 0) {
    alert('Không tìm thấy dữ liệu mã số trong các cột đã chọn.');
    return;
  }

  await chrome.runtime.sendMessage({ action: 'LOAD_QUEUE', taxCodes: queue });

  statsBar.hidden = false;
  controls.hidden = false;
  statTotal.textContent        = queue.length;
  statDone.textContent         = '0';
  statDongBo.textContent       = '0';
  statChuaDongBo.textContent   = '0';
  statKhongTimThay.textContent = '0';
  statError.textContent        = '0';
  btnStart.disabled = false;
  btnPause.disabled = true;
  btnStop.disabled  = true;
  btnExport.disabled = true;
});

// --- Control buttons ---
btnStart.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'START' });
  btnStart.disabled = true;
  btnPause.disabled = false;
  btnStop.disabled  = false;
  progressWrap.hidden = false;
  currentCode.hidden  = false;
});

btnPause.addEventListener('click', async () => {
  const state = await chrome.storage.local.get('phase');
  if (state.phase === 'paused') {
    await chrome.runtime.sendMessage({ action: 'RESUME' });
    btnPause.textContent = 'Tạm dừng';
    btnPause.classList.remove('btn-primary');
    btnPause.classList.add('btn-secondary');
  } else {
    await chrome.runtime.sendMessage({ action: 'PAUSE' });
    btnPause.textContent = 'Tiếp tục';
    btnPause.classList.remove('btn-secondary');
    btnPause.classList.add('btn-primary');
  }
});

btnStop.addEventListener('click', async () => {
  if (!confirm('Dừng quá trình tra cứu?')) return;
  await chrome.runtime.sendMessage({ action: 'STOP' });
  btnStart.disabled = false;
  btnPause.disabled = true;
  btnStop.disabled  = true;
  btnPause.textContent = 'Tạm dừng';
  btnPause.classList.remove('btn-primary');
  btnPause.classList.add('btn-secondary');
  currentCode.hidden = true;
});

// --- Clear recent results ---
btnClearResults.addEventListener('click', async () => {
  await chrome.storage.local.set({ results: [] });
  resultsBody.innerHTML = '';
  resultsWrap.hidden = true;
});

// --- Storage change listener → update UI ---
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.progress) updateProgressUI(changes.progress.newValue);
  if (changes.results)  updateResultsTable(changes.results.newValue);
  if (changes.phase)    handlePhaseChange(changes.phase.newValue);
});

function updateProgressUI(progress) {
  if (!progress) return;
  statTotal.textContent        = progress.total        || 0;
  statDone.textContent         = progress.done         || 0;
  statDongBo.textContent       = progress.dongBo       || 0;
  statChuaDongBo.textContent   = progress.chuaDongBo   || 0;
  statKhongTimThay.textContent = progress.khongTimThay || 0;
  statError.textContent        = progress.errors       || 0;

  if (progress.currentCode) {
    codeDisplay.textContent = progress.currentCode;
    currentCode.hidden = false;
    phaseDisplay.textContent = progress.currentPhase
      ? `(giai đoạn ${progress.currentPhase})`
      : '';
  }

  const pct = Math.round(((progress.done || 0) / (progress.total || 1)) * 100);
  progressBar.value = pct;
  progressPct.textContent = pct + '%';
  progressWrap.hidden = false;
  statsBar.hidden = false;
}

const STATUS_CLASS = {
  DONG_BO:        'status-dongbo',
  CHUA_DONG_BO:   'status-chuadb',
  KHONG_TIM_THAY: 'status-khong',
  ERROR_CAPTCHA:  'status-error',
  ERROR_NETWORK:  'status-error',
};

const STATUS_LABEL = {
  DONG_BO:        'Đồng bộ',
  CHUA_DONG_BO:   'Chưa đồng bộ',
  KHONG_TIM_THAY: 'Không tìm thấy',
  ERROR_CAPTCHA:  'Lỗi CAPTCHA',
  ERROR_NETWORK:  'Lỗi mạng',
};

function updateResultsTable(results) {
  if (!results || results.length === 0) return;
  resultsWrap.hidden = false;

  const recent = results.slice(-15).reverse();
  resultsBody.innerHTML = '';
  for (const r of recent) {
    const tr = document.createElement('tr');
    const displayCode = r.cccdCode || r.mstCode || '';
    const statusCls   = STATUS_CLASS[r.status] || 'status-pending';
    const statusLbl   = STATUS_LABEL[r.status] || r.status || 'Chưa xử lý';

    tr.innerHTML = `
      <td title="${displayCode}">${displayCode}</td>
      <td title="${r.dongBoValue || ''}">${r.dongBoValue || '—'}</td>
      <td class="${statusCls}">${statusLbl}</td>
    `;
    resultsBody.appendChild(tr);
  }
}

function handlePhaseChange(phase) {
  if (phase === 'done') {
    currentCode.hidden = true;
    codeDisplay.textContent = '';
    phaseDisplay.textContent = '';
    btnStart.disabled = true;
    btnPause.disabled = true;
    btnStop.disabled  = true;
    btnExport.disabled = false;
  }
}

// --- Export ---
btnExport.addEventListener('click', exportResults);

async function exportResults() {
  const stored = await chrome.storage.local.get([
    'originalFile', 'fileSheetName', 'colDongBo', 'results'
  ]);

  if (!stored.originalFile) {
    alert('Không có dữ liệu file gốc. Vui lòng tải lại file Excel.');
    return;
  }

  const colDongBoIdx = parseInt(stored.colDongBo, 10);
  if (!(colDongBoIdx >= 0)) {
    alert('Chưa xác định cột "Đồng bộ CCCD". Vui lòng tải lại file.');
    return;
  }

  const buf = new Uint8Array(stored.originalFile).buffer;
  const wb = XLSX.read(buf, { type: 'array' });
  const sheetName = stored.fileSheetName || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  const resultByRow = {};
  for (const r of (stored.results || [])) {
    resultByRow[r.rowIdx] = r;
  }

  // In-place overwrite of Đồng bộ CCCD column only
  for (let i = 1; i < rows.length; i++) {
    const result = resultByRow[i];
    if (result) {
      while (rows[i].length <= colDongBoIdx) rows[i].push('');
      rows[i][colDongBoIdx] = result.dongBoValue || '';
    }
    // Rows without result: leave original value untouched
  }

  const newWs = XLSX.utils.aoa_to_sheet(rows);
  wb.Sheets[sheetName] = newWs;

  const outBuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const blob = new Blob([outBuf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });

  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({
    url,
    filename: `dong-bo-cccd-${Date.now()}.xlsx`,
    saveAs: true,
  });

  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// --- Restore state on popup open ---
async function restoreState() {
  const state = await chrome.runtime.sendMessage({ action: 'GET_STATE' });
  if (!state) return;

  const { progress, results, phase } = state;
  if (progress && progress.total > 0) {
    statsBar.hidden = false;
    controls.hidden = false;
    updateProgressUI(progress);
  }
  if (results && results.length > 0) {
    updateResultsTable(results);
  }
  if (phase === 'running') {
    btnStart.disabled = true;
    btnPause.disabled = false;
    btnStop.disabled  = false;
    progressWrap.hidden = false;
    currentCode.hidden  = false;
  } else if (phase === 'paused') {
    btnStart.disabled = true;
    btnPause.disabled = false;
    btnStop.disabled  = false;
    btnPause.textContent = 'Tiếp tục';
    btnPause.classList.remove('btn-secondary');
    btnPause.classList.add('btn-primary');
    progressWrap.hidden = false;
  } else if (phase === 'done') {
    btnExport.disabled = false;
    btnStart.disabled = true;
    btnPause.disabled = true;
    btnStop.disabled  = true;
  } else if (phase === 'idle' && progress && progress.total > 0) {
    btnStart.disabled = false;
    btnPause.disabled = true;
    btnStop.disabled  = true;
  }
}

restoreState();
