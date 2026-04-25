// app.js — OSRS Bingo Generator v3

// ── State ─────────────────────────────────────────
// Cell = null | { items: [{name, imageUrl, points:0}], info:'', tilePoints:0 }
// crossed[i] = [{checked:bool, date:string|null}, ...]
const state = {
  gridSize: 5,
  hasFreeCell: true,
  background: null,
  style: {
    borderColor: '#c8aa6e', cellBg: '#0a0804', cellOpacity: 85,
    textColor: '#ffffff', borderWidth: 2, fontSize: 11, cellSize: 80,
  },
  cells: [],
  selectedCell: null,
  playMode: false,
  crossed: [],
  bonuses: { row: 0, col: 0, diagLeft: 0, diagRight: 0, fullCard: 0 },
  endDate: '',
};

// Team state — persisted separately in localStorage
let teamState = { teamName: '', players: [] };

let currentHash = '';
let pendingCheck = null;   // {cellIndex, itemIndex}
let countdownInterval = null;
let historyChart = null;

// ── Firebase event mode ───────────────────────────
let isFbMode = false;
let fbEventId = null;
let fbTeamId = null;
let fbUnsubTeam = null;
let fbUnsubScoreboard = null;
let _fbIncoming = false;

// ── Moderator view ────────────────────────────────
let isModMode = false;
let modCardDef = null;

// ── Completion tracking ───────────────────────────
let _prevLineCount = 0;
let _prevFullCard = false;

// ── Event closed state ────────────────────────────
let eventClosed = false;
let fbUnsubEventClosed = null;

// ── DOM refs ──────────────────────────────────────
const bingoCard     = document.getElementById('bingo-card');
const searchInput   = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
const searchHint    = document.getElementById('search-hint');

// ── Helpers ───────────────────────────────────────

function getFreeIndex() {
  if (!state.hasFreeCell) return -1;
  return Math.floor((state.gridSize * state.gridSize) / 2);
}

function cellHasItems(cell) {
  return cell && cell.items && cell.items.length > 0;
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function resizeCells() {
  const total = state.gridSize * state.gridSize;
  while (state.cells.length < total) state.cells.push(null);
  if (state.cells.length > total) state.cells.splice(total);
  while (state.crossed.length < total) state.crossed.push([]);
  if (state.crossed.length > total) state.crossed.splice(total);
}

// Normalize a crossed entry to object format
function normCrossed(arr, count) {
  const result = [];
  for (let i = 0; i < count; i++) {
    const v = arr[i];
    if (v && typeof v === 'object') {
      result.push({ checked: !!v.checked, date: v.date || null });
    } else {
      result.push({ checked: !!v, date: null });
    }
  }
  return result;
}

// Is a specific item checked?
function isItemChecked(cellIdx, itemIdx) {
  const arr = state.crossed[cellIdx];
  if (!arr || !arr[itemIdx]) return false;
  return !!(arr[itemIdx].checked);
}

// Is a cell fully complete? (all items checked, or FREE)
function isCellComplete(idx) {
  if (idx === getFreeIndex()) return true;
  const cell = state.cells[idx];
  if (!cellHasItems(cell)) return false;
  return cell.items.every((_, i) => isItemChecked(idx, i));
}

// ── Line highlights ───────────────────────────────

function getCompletedLineCells() {
  const n = state.gridSize;
  const set = new Set();
  const complete = i => isCellComplete(i);
  for (let r = 0; r < n; r++) {
    const idx = Array.from({length: n}, (_, c) => r * n + c);
    if (idx.every(complete)) idx.forEach(i => set.add(i));
  }
  for (let c = 0; c < n; c++) {
    const idx = Array.from({length: n}, (_, r) => r * n + c);
    if (idx.every(complete)) idx.forEach(i => set.add(i));
  }
  if (n >= 2) {
    const dl = Array.from({length: n}, (_, i) => i * n + i);
    if (dl.every(complete)) dl.forEach(i => set.add(i));
    const dr = Array.from({length: n}, (_, i) => i * n + (n - 1 - i));
    if (dr.every(complete)) dr.forEach(i => set.add(i));
  }
  return set;
}

function updateLineHighlights() {
  if (!state.playMode) return;
  const set = getCompletedLineCells();
  bingoCard.querySelectorAll('.bingo-cell').forEach((el, i) => {
    el.classList.toggle('line-complete', set.has(i));
  });
}

// ── Score calculation ─────────────────────────────

function calculateScore() {
  const n = state.gridSize;
  const bd = { items: 0, tiles: 0, rows: 0, cols: 0, diagLeft: 0, diagRight: 0, fullCard: 0 };
  const details = { rows: [], cols: [], diags: [] };

  for (let i = 0; i < n * n; i++) {
    if (i === getFreeIndex()) continue;
    const cell = state.cells[i];
    if (!cellHasItems(cell)) continue;
    cell.items.forEach((item, itemIdx) => {
      if (isItemChecked(i, itemIdx)) bd.items += (item.points || 0);
    });
    if (isCellComplete(i)) bd.tiles += (cell.tilePoints || 0);
  }

  for (let r = 0; r < n; r++) {
    const indices = Array.from({length: n}, (_, c) => r * n + c);
    if (indices.every(isCellComplete)) {
      bd.rows += state.bonuses.row;
      details.rows.push(r + 1);
    }
  }
  for (let c = 0; c < n; c++) {
    const indices = Array.from({length: n}, (_, r) => r * n + c);
    if (indices.every(isCellComplete)) {
      bd.cols += state.bonuses.col;
      details.cols.push(c + 1);
    }
  }
  if (n >= 2) {
    const dl = Array.from({length: n}, (_, i) => i * n + i);
    if (dl.every(isCellComplete)) { bd.diagLeft += state.bonuses.diagLeft; details.diags.push('\\'); }
    const dr = Array.from({length: n}, (_, i) => i * n + (n - 1 - i));
    if (dr.every(isCellComplete)) { bd.diagRight += state.bonuses.diagRight; details.diags.push('/'); }
  }
  const all = Array.from({length: n * n}, (_, i) => i).every(isCellComplete);
  if (all) bd.fullCard += state.bonuses.fullCard;

  const total = Object.values(bd).reduce((a, b) => a + b, 0);
  return { total, bd, details };
}

function updateScore() {
  const { total, bd, details } = calculateScore();
  document.getElementById('score-total').textContent = total;

  const el = document.getElementById('score-breakdown');
  const rows = [
    ['📦 Items',     bd.items],
    ['🟩 Tiles',     bd.tiles],
    ['→ Rijen',      bd.rows,     details.rows.length ? `(rij ${details.rows.join(', ')})` : ''],
    ['↓ Kolommen',   bd.cols,     details.cols.length ? `(kol ${details.cols.join(', ')})` : ''],
    ['╲ Diagonaal',  bd.diagLeft],
    ['╱ Diagonaal',  bd.diagRight],
    ['★ Volle kaart',bd.fullCard],
  ];
  el.innerHTML = rows.filter(r => r[1] > 0).map(r =>
    `<div class="score-row"><span>${r[0]}</span><span>${r[1]} pt${r[2] ? ' <em>' + r[2] + '</em>' : ''}</span></div>`
  ).join('') || '<div class="score-empty">Nog geen punten</div>';

  if (state.playMode) {
    updateProgressBar();
    updateLineHighlights();
  }
}

function updatePointsLegend() {
  const el = document.getElementById('points-legend');
  const lines = [];
  const n = state.gridSize;

  for (let i = 0; i < n * n; i++) {
    if (i === getFreeIndex()) continue;
    const cell = state.cells[i];
    if (!cellHasItems(cell)) continue;
    cell.items.forEach(item => {
      if (item.points > 0) lines.push(`<div class="legend-row"><span>${item.name}</span><span>${item.points} pt</span></div>`);
    });
    if (cell.tilePoints > 0) {
      const names = cell.items.map(it => it.name).join(' + ');
      lines.push(`<div class="legend-row tile-legend"><span>[Tile] ${names}</span><span>${cell.tilePoints} pt</span></div>`);
    }
  }
  if (state.bonuses.row > 0)       lines.push(`<div class="legend-row bonus-legend"><span>→ Rij voltooid</span><span>${state.bonuses.row} pt</span></div>`);
  if (state.bonuses.col > 0)       lines.push(`<div class="legend-row bonus-legend"><span>↓ Kolom voltooid</span><span>${state.bonuses.col} pt</span></div>`);
  if (state.bonuses.diagLeft > 0)  lines.push(`<div class="legend-row bonus-legend"><span>╲ Diagonaal</span><span>${state.bonuses.diagLeft} pt</span></div>`);
  if (state.bonuses.diagRight > 0) lines.push(`<div class="legend-row bonus-legend"><span>╱ Diagonaal</span><span>${state.bonuses.diagRight} pt</span></div>`);
  if (state.bonuses.fullCard > 0)  lines.push(`<div class="legend-row bonus-legend"><span>★ Volle kaart</span><span>${state.bonuses.fullCard} pt</span></div>`);

  el.innerHTML = lines.length ? lines.join('') : '<div class="score-empty">Geen punten ingesteld</div>';
}

// ── Progress bar ──────────────────────────────────

function countCompletedTiles() {
  const n = state.gridSize;
  let count = 0;
  for (let i = 0; i < n * n; i++) {
    if (i !== getFreeIndex() && isCellComplete(i)) count++;
  }
  return count;
}

function updateProgressBar() {
  const n = state.gridSize;
  const total = n * n - (state.hasFreeCell ? 1 : 0);
  const complete = countCompletedTiles();
  const pct = total > 0 ? Math.round(complete / total * 100) : 0;
  const fill = document.getElementById('progress-bar-fill');
  const label = document.getElementById('progress-label');
  if (fill) fill.style.width = pct + '%';
  if (label) label.textContent = `${complete} / ${total} tiles (${pct}%)`;
}

// ── Completion celebration ────────────────────────

function countCompletedLines() {
  const n = state.gridSize;
  let count = 0;
  const complete = i => isCellComplete(i);
  for (let r = 0; r < n; r++) {
    if (Array.from({length: n}, (_, c) => r * n + c).every(complete)) count++;
  }
  for (let c = 0; c < n; c++) {
    if (Array.from({length: n}, (_, r) => r * n + c).every(complete)) count++;
  }
  if (n >= 2) {
    const dl = Array.from({length: n}, (_, i) => i * n + i);
    if (dl.every(complete)) count++;
    const dr = Array.from({length: n}, (_, i) => i * n + (n - 1 - i));
    if (dr.every(complete)) count++;
  }
  return count;
}

function initCompletionTracking() {
  _prevLineCount = countCompletedLines();
  const { bd } = calculateScore();
  _prevFullCard = bd.fullCard > 0;
}

function triggerCelebration(title, subtitle, type) {
  const overlay = document.getElementById('celebration-overlay');
  const titleEl = document.getElementById('celebration-title');
  const subtitleEl = document.getElementById('celebration-subtitle');
  titleEl.textContent = title;
  subtitleEl.textContent = subtitle;
  overlay.className = 'celebration-overlay celebration-' + type + ' celebration-active';
  clearTimeout(overlay._t);
  overlay._t = setTimeout(() => {
    overlay.className = 'celebration-overlay';
  }, 2400);
}

function checkCompletionCelebration() {
  const lineCount = countCompletedLines();
  const { bd } = calculateScore();
  const fullCard = bd.fullCard > 0 || Array.from({length: state.gridSize * state.gridSize}, (_, i) => i).every(isCellComplete);
  if (fullCard && !_prevFullCard) {
    triggerCelebration('BINGO!', 'Volle kaart voltooid! ★', 'full');
  } else if (lineCount > _prevLineCount) {
    const diff = lineCount - _prevLineCount;
    triggerCelebration('BINGO!', diff > 1 ? `${diff} lijnen voltooid!` : 'Lijn voltooid!', 'line');
  }
  _prevLineCount = lineCount;
  _prevFullCard = fullCard;
}

// ── Rendering ─────────────────────────────────────

function renderGrid() {
  resizeCells();
  bingoCard.style.gridTemplateColumns = `repeat(${state.gridSize}, 1fr)`;
  bingoCard.innerHTML = '';
  for (let i = 0; i < state.gridSize * state.gridSize; i++) {
    bingoCard.appendChild(buildCell(i));
  }
  if (state.playMode) updateLineHighlights();
}

function buildCell(index) {
  const isFree = index === getFreeIndex();
  const cell = document.createElement('div');
  cell.className = 'bingo-cell' + (isFree ? ' free' : '');
  if (!state.playMode && index === state.selectedCell) cell.classList.add('selected');

  const data = state.cells[index];
  const crossed = state.crossed[index] || [];

  if (isFree) {
    const lbl = document.createElement('span');
    lbl.className = 'free-label'; lbl.textContent = 'FREE';
    cell.appendChild(lbl);

  } else if (cellHasItems(data)) {
    const count = data.items.length;
    cell.dataset.count = count;

    const grid = document.createElement('div');
    grid.className = 'items-grid';

    data.items.forEach((item, itemIdx) => {
      const itemEl = document.createElement('div');
      const checked = crossed[itemIdx] && crossed[itemIdx].checked;
      itemEl.className = 'cell-item' + (checked ? ' item-crossed' : '');
      itemEl.title = item.name + (item.points ? ` (${item.points} pt)` : '');

      if (item.imageUrl) {
        const img = document.createElement('img');
        img.src = item.imageUrl; img.alt = item.name;
        itemEl.appendChild(img);
      }
      if (count <= 2) {
        const nameEl = document.createElement('span');
        nameEl.className = 'item-name';
        nameEl.textContent = item.name;
        itemEl.appendChild(nameEl);
      }
      if (state.playMode && checked && crossed[itemIdx].date) {
        const chip = document.createElement('span');
        chip.className = 'date-chip';
        chip.textContent = formatDateShort(crossed[itemIdx].date);
        itemEl.appendChild(chip);
      }

      if (state.playMode) {
        itemEl.addEventListener('click', e => { e.stopPropagation(); handleItemClick(index, itemIdx); });
      }
      grid.appendChild(itemEl);
    });

    cell.appendChild(grid);

    if (state.playMode && isCellComplete(index)) cell.classList.add('all-crossed');

    const totalCellPts = (data.tilePoints || 0) + data.items.reduce((s, it) => s + (it.points || 0), 0);
    if (state.playMode && totalCellPts > 0 && !isCellComplete(index)) {
      const badge = document.createElement('span');
      badge.className = 'pts-badge';
      badge.textContent = totalCellPts + 'pt';
      cell.appendChild(badge);
    }

    if (data.info) {
      if (state.playMode) {
        const btn = document.createElement('button');
        btn.className = 'cell-info-btn'; btn.textContent = '?';
        btn.addEventListener('click', e => { e.stopPropagation(); showInfoPopup(data.info, btn); });
        cell.appendChild(btn);
      } else {
        const badge = document.createElement('span');
        badge.className = 'cell-info-badge'; badge.textContent = 'i'; badge.title = data.info;
        cell.appendChild(badge);
      }
    }

    if (!state.playMode) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'cell-remove'; removeBtn.textContent = '✕'; removeBtn.title = 'Cel leegmaken';
      removeBtn.addEventListener('click', e => {
        e.stopPropagation();
        state.cells[index] = null; state.crossed[index] = [];
        const existing = bingoCard.querySelectorAll('.bingo-cell')[index];
        bingoCard.replaceChild(buildCell(index), existing);
        if (state.selectedCell === index) updateSearchPanel();
      });
      cell.appendChild(removeBtn);
    }

  } else if (!state.playMode) {
    const ph = document.createElement('span');
    ph.className = 'cell-empty'; ph.textContent = '+';
    cell.appendChild(ph);
  }

  if (!state.playMode && !isFree) cell.addEventListener('click', () => selectCell(index));
  return cell;
}

function refreshCell(index) {
  const cells = bingoCard.querySelectorAll('.bingo-cell');
  if (cells[index]) bingoCard.replaceChild(buildCell(index), cells[index]);
  if (state.playMode) updateLineHighlights();
}

function formatDateShort(d) {
  if (!d) return '';
  const [, m, day] = d.split('-');
  return `${day}/${m}`;
}

// ── Item click → date picker ──────────────────────

function handleItemClick(cellIndex, itemIndex) {
  if (eventClosed) return;
  const cur = state.crossed[cellIndex][itemIndex];
  if (cur && cur.checked) {
    state.crossed[cellIndex][itemIndex] = { checked: false, date: null };
    refreshCell(cellIndex);
    saveProgress(); updateScore(); updateCharts();
    return;
  }
  pendingCheck = { cellIndex, itemIndex };
  document.getElementById('date-picker-input').value = today();
  document.getElementById('date-picker-popup').style.display = 'flex';
}

document.getElementById('date-picker-ok').addEventListener('click', () => {
  if (!pendingCheck) return;
  const date = document.getElementById('date-picker-input').value || today();
  const { cellIndex, itemIndex } = pendingCheck;
  pendingCheck = null;
  document.getElementById('date-picker-popup').style.display = 'none';
  state.crossed[cellIndex][itemIndex] = { checked: true, date };
  refreshCell(cellIndex);
  saveProgress(); updateScore(); updateCharts();
  checkCompletionCelebration();
  flashSaved();
});

document.getElementById('date-picker-cancel').addEventListener('click', () => {
  pendingCheck = null;
  document.getElementById('date-picker-popup').style.display = 'none';
});

document.getElementById('date-picker-popup').addEventListener('click', e => {
  if (e.target === document.getElementById('date-picker-popup')) {
    pendingCheck = null;
    document.getElementById('date-picker-popup').style.display = 'none';
  }
});

function flashSaved() {
  const msg = document.getElementById('play-save-msg');
  if (!msg) return;
  msg.textContent = '✓ Opgeslagen';
  clearTimeout(msg._t);
  msg._t = setTimeout(() => { msg.textContent = ''; }, 1500);
}

// ── Cell selection (editor) ───────────────────────

function selectCell(index) {
  state.selectedCell = index;
  bingoCard.querySelectorAll('.bingo-cell').forEach((el, i) => el.classList.toggle('selected', i === index));
  searchInput.disabled = false;
  searchInput.value = '';
  searchResults.innerHTML = '';
  document.getElementById('info-field-wrap').style.display = 'block';
  document.getElementById('tile-points-wrap').style.display = 'block';
  updateSearchPanel();
  searchInput.focus();
}

function updateSearchPanel() {
  const index = state.selectedCell;
  if (index === null) return;
  const data = state.cells[index];
  searchHint.textContent = cellHasItems(data)
    ? `Cel ${index + 1} — ${data.items.length} item(s):`
    : `Cel ${index + 1} — voeg een item toe:`;
  renderCurrentItems(index);
  document.getElementById('info-textarea').value = data ? (data.info || '') : '';
  document.getElementById('tile-points-input').value = data ? (data.tilePoints || 0) : 0;
}

function renderCurrentItems(index) {
  const panel = document.getElementById('current-items-panel');
  panel.innerHTML = '';
  const data = state.cells[index];
  if (!cellHasItems(data)) return;

  data.items.forEach((item, itemIdx) => {
    const row = document.createElement('div');
    row.className = 'current-item-row';
    row.draggable = true;

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.textContent = '⠿';
    handle.title = 'Sleep om te herordenen';
    row.appendChild(handle);

    if (item.imageUrl) {
      const img = document.createElement('img');
      img.src = item.imageUrl; img.alt = item.name; img.className = 'current-item-img';
      row.appendChild(img);
    }
    const name = document.createElement('span');
    name.className = 'current-item-name'; name.textContent = item.name;
    row.appendChild(name);

    const ptsWrap = document.createElement('label');
    ptsWrap.className = 'item-pts-label';
    ptsWrap.title = 'Punten voor dit item';
    const ptsInput = document.createElement('input');
    ptsInput.type = 'number'; ptsInput.min = '0'; ptsInput.value = item.points || 0;
    ptsInput.className = 'item-pts-input pts-input';
    ptsInput.addEventListener('input', e => {
      item.points = Math.max(0, parseInt(e.target.value, 10) || 0);
      refreshCell(index);
    });
    const ptsLabel = document.createElement('span');
    ptsLabel.textContent = 'pt';
    ptsWrap.appendChild(ptsInput); ptsWrap.appendChild(ptsLabel);
    row.appendChild(ptsWrap);

    const del = document.createElement('button');
    del.className = 'current-item-remove'; del.textContent = '✕'; del.title = 'Verwijder item';
    del.addEventListener('click', () => {
      data.items.splice(itemIdx, 1);
      if (data.items.length === 0) state.cells[index] = null;
      state.crossed[index] = (state.cells[index] || { items: [] }).items.map(() => ({ checked: false, date: null }));
      refreshCell(index); updateSearchPanel();
    });
    row.appendChild(del);

    // Drag-and-drop events
    row.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', String(itemIdx));
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', e => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (isNaN(fromIdx) || fromIdx === itemIdx) return;
      const items = state.cells[index].items;
      const [moved] = items.splice(fromIdx, 1);
      items.splice(itemIdx, 0, moved);
      const crossedArr = state.crossed[index] || [];
      const [movedC] = crossedArr.splice(fromIdx, 1);
      crossedArr.splice(itemIdx, 0, movedC);
      refreshCell(index);
      renderCurrentItems(index);
    });

    panel.appendChild(row);
  });
}

// ── Style ─────────────────────────────────────────

function applyStyle() {
  const { borderColor, cellBg, cellOpacity, textColor, borderWidth, fontSize, cellSize } = state.style;
  bingoCard.style.setProperty('--border-color', borderColor);
  bingoCard.style.setProperty('--border-width', borderWidth + 'px');
  bingoCard.style.setProperty('--text-color', textColor);
  bingoCard.style.setProperty('--font-size', fontSize + 'px');
  bingoCard.style.setProperty('--cell-size', cellSize + 'px');
  const r = parseInt(cellBg.slice(1,3),16), g = parseInt(cellBg.slice(3,5),16), b = parseInt(cellBg.slice(5,7),16);
  bingoCard.style.setProperty('--cell-bg', `rgba(${r},${g},${b},${cellOpacity/100})`);
}

function setBackground(dataUrl) {
  state.background = dataUrl;
  bingoCard.style.backgroundImage = dataUrl ? `url(${dataUrl})` : 'none';
}

// ── Search ────────────────────────────────────────

let searchTimeout = null;

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  const q = searchInput.value.trim();
  if (!q) { searchResults.innerHTML = ''; return; }
  searchTimeout = setTimeout(() => runSearch(q), 320);
});

async function runSearch(query) {
  searchResults.innerHTML = '<div class="search-status">Zoeken...</div>';
  try {
    const results = await searchItems(query);
    searchResults.innerHTML = '';
    if (!results.length) { searchResults.innerHTML = '<div class="search-status">Geen resultaten.</div>'; return; }
    results.forEach(({ title }) => searchResults.appendChild(buildResultRow(title)));
  } catch {
    searchResults.innerHTML = '<div class="search-status">Fout bij zoeken.</div>';
  }
}

function buildResultRow(title) {
  const row = document.createElement('div');
  row.className = 'search-result';
  const imgWrap = document.createElement('div'); imgWrap.className = 'result-img-wrap';
  const nameEl = document.createElement('span'); nameEl.className = 'result-name'; nameEl.textContent = title;
  const status = document.createElement('span'); status.className = 'result-status'; status.textContent = '⏳';
  row.appendChild(imgWrap); row.appendChild(nameEl); row.appendChild(status);
  row.addEventListener('click', () => assignItem(title, row));
  fetchItemImageAsDataUrl(title).then(url => {
    status.textContent = '';
    if (url) { const img = document.createElement('img'); img.src = url; img.alt = title; imgWrap.appendChild(img); row._imageUrl = url; }
    else { imgWrap.textContent = '?'; imgWrap.style.color = 'var(--text-muted)'; }
  }).catch(() => { status.textContent = ''; });
  return row;
}

async function assignItem(title, row) {
  if (state.selectedCell === null) return;
  const idx = state.selectedCell;
  let imageUrl = row._imageUrl;
  if (imageUrl === undefined) {
    row._loadingPromise = row._loadingPromise || fetchItemImageAsDataUrl(title);
    imageUrl = await row._loadingPromise;
  }
  if (!state.cells[idx]) state.cells[idx] = { items: [], info: '', tilePoints: 0 };
  state.cells[idx].items.push({ name: title, imageUrl: imageUrl || '', points: 0 });
  state.crossed[idx] = state.cells[idx].items.map(() => ({ checked: false, date: null }));
  refreshCell(idx); updateSearchPanel();
}

// ── PNG export ────────────────────────────────────

async function exportToPng(btn, label) {
  btn.textContent = 'Bezig...'; btn.disabled = true;
  try {
    const canvas = await html2canvas(bingoCard, { scale: 2, useCORS: true, allowTaint: false, backgroundColor: null, logging: false });
    canvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'osrs-bingo.png';
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    }, 'image/png');
  } catch (err) { alert('Export mislukt.\n\n' + err.message); }
  btn.textContent = label; btn.disabled = false;
}
document.getElementById('btn-export').addEventListener('click', function() { exportToPng(this, '📥 Download PNG'); });
document.getElementById('btn-play-export').addEventListener('click', function() { exportToPng(this, '📥 Download PNG'); });

// ── Editor: save/load JSON ────────────────────────

document.getElementById('btn-save-editor').addEventListener('click', () => {
  downloadJson({
    v: 3,
    gridSize: state.gridSize, hasFreeCell: state.hasFreeCell,
    style: state.style, bonuses: state.bonuses, endDate: state.endDate,
    cells: state.cells.map(c => cellHasItems(c) ? {
      items: c.items.map(it => ({ name: it.name, points: it.points || 0 })),
      info: c.info || '', tilePoints: c.tilePoints || 0,
    } : null),
  }, 'osrs-bingo-kaart.json');
});

document.getElementById('btn-load-editor').addEventListener('click', () => document.getElementById('load-editor-file').click());
document.getElementById('load-editor-file').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return; e.target.value = '';
  try { await applyLoadedState(JSON.parse(await file.text())); }
  catch (err) { alert('Laden mislukt: ' + err.message); }
});

async function applyLoadedState(loaded) {
  if (!loaded.v || loaded.v < 2 || !Number.isInteger(loaded.gridSize) || loaded.gridSize < 2) {
    alert('Ongeldig bestand.'); return;
  }
  state.gridSize = loaded.gridSize; state.hasFreeCell = !!loaded.hasFreeCell;
  if (loaded.style) Object.assign(state.style, loaded.style);
  if (loaded.bonuses) Object.assign(state.bonuses, loaded.bonuses);
  state.endDate = loaded.endDate || '';

  state.cells = (Array.isArray(loaded.cells) ? loaded.cells : []).map(c =>
    c ? { items: c.items.map(it => ({ name: it.name, imageUrl: '', points: it.points || 0 })),
          info: c.info || '', tilePoints: c.tilePoints || 0 } : null
  );
  state.crossed = state.cells.map(c => cellHasItems(c) ? c.items.map(() => ({ checked: false, date: null })) : []);
  state.selectedCell = null;
  resizeCells(); renderGrid(); applyStyle(); syncUiToState();
  document.getElementById('info-field-wrap').style.display = 'none';
  document.getElementById('tile-points-wrap').style.display = 'none';
  document.getElementById('current-items-panel').innerHTML = '';
  refetchAllImages();
}

function refetchAllImages() {
  state.cells.forEach((cell, i) => {
    if (!cellHasItems(cell)) return;
    cell.items.forEach((item, itemIdx) => {
      fetchItemImageAsDataUrl(item.name).then(url => {
        if (state.cells[i] && state.cells[i].items[itemIdx]) {
          state.cells[i].items[itemIdx].imageUrl = url || ''; refreshCell(i);
        }
      }).catch(() => {});
    });
  });
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── Collapsible panels ────────────────────────────

function initCollapsiblePanels() {
  document.querySelectorAll('.panel[data-collapsible] h2').forEach(h2 => {
    h2.addEventListener('click', e => {
      if (e.target.closest('button') && !e.target.classList.contains('panel-toggle')) return;
      h2.closest('.panel').classList.toggle('panel-collapsed');
    });
  });
}

// ── Play mode: progress save/load ─────────────────

function saveProgress() {
  if (!isFbMode) {
    try { localStorage.setItem('bingo-crossed-' + currentHash, JSON.stringify(state.crossed)); } catch {}
  }
  if (isFbMode && fbEventId && fbTeamId && !_fbIncoming) {
    const { total } = calculateScore();
    const tilesComplete = countCompletedTiles();
    fbSaveTeamProgress(fbEventId, fbTeamId, state.crossed, total, teamState.players, teamState.teamName, tilesComplete).catch(() => {});
  }
}

function loadProgress(hash) {
  try {
    const s = localStorage.getItem('bingo-crossed-' + hash);
    if (!s) return;
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) return;
    arr.forEach((v, i) => {
      if (i >= state.crossed.length) return;
      const cell = state.cells[i];
      const count = cellHasItems(cell) ? cell.items.length : 0;
      if (Array.isArray(v)) state.crossed[i] = normCrossed(v, count);
    });
  } catch {}
}

// ── Player progress export/import ─────────────────

document.getElementById('btn-play-export-json').addEventListener('click', () => {
  downloadJson({ v: 2, cardHash: currentHash, crossed: state.crossed, savedAt: new Date().toISOString() }, 'osrs-bingo-voortgang.json');
});
document.getElementById('btn-play-import-json').addEventListener('click', () => document.getElementById('load-progress-file').click());
document.getElementById('load-progress-file').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return; e.target.value = '';
  try {
    const loaded = JSON.parse(await file.text());
    if (loaded.cardHash && loaded.cardHash !== currentHash)
      if (!confirm('Voortgang is van een andere kaart. Toch laden?')) return;
    if (!Array.isArray(loaded.crossed)) { alert('Ongeldig bestand.'); return; }
    loaded.crossed.forEach((v, i) => {
      if (i >= state.crossed.length || !Array.isArray(v)) return;
      const cell = state.cells[i];
      const count = cellHasItems(cell) ? cell.items.length : 0;
      state.crossed[i] = normCrossed(v, count);
    });
    renderGrid(); applyStyle(); saveProgress(); updateScore(); updateCharts();
    const msg = document.getElementById('play-save-msg');
    msg.textContent = '✓ Voortgang geladen'; setTimeout(() => { msg.textContent = ''; }, 2000);
  } catch (err) { alert('Laden mislukt: ' + err.message); }
});

// ── Countdown clock ───────────────────────────────

function startCountdown() {
  clearInterval(countdownInterval);
  if (!state.endDate) {
    document.getElementById('countdown-display').textContent = '—';
    document.getElementById('countdown-end-label').textContent = '';
    return;
  }
  const endMs = new Date(state.endDate + 'T23:59:59').getTime();
  document.getElementById('countdown-end-label').textContent = 'Tot ' + formatDateNL(state.endDate);

  function tick() {
    const diff = endMs - Date.now();
    if (diff <= 0) {
      document.getElementById('countdown-display').textContent = 'Afgelopen!';
      clearInterval(countdownInterval);
      return;
    }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    document.getElementById('countdown-display').textContent =
      `${d}d ${String(h).padStart(2,'0')}u ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
  }
  tick();
  countdownInterval = setInterval(tick, 1000);
}

function formatDateNL(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${day}-${m}-${y}`;
}

// ── Team state ────────────────────────────────────

function teamKey() { return 'bingo-team-' + currentHash; }

function saveTeamState() {
  try { localStorage.setItem(teamKey(), JSON.stringify(teamState)); } catch {}
  if (isFbMode && fbEventId && fbTeamId) {
    const { total } = calculateScore();
    const tilesComplete = countCompletedTiles();
    fbSaveTeamProgress(fbEventId, fbTeamId, state.crossed, total, teamState.players, teamState.teamName, tilesComplete).catch(() => {});
  }
}

function loadTeamState() {
  try {
    const s = localStorage.getItem(teamKey());
    if (s) teamState = JSON.parse(s);
  } catch {}
}

// ── Team UI ───────────────────────────────────────

document.getElementById('team-name-input').addEventListener('input', e => {
  teamState.teamName = e.target.value;
  saveTeamState();
});

document.getElementById('btn-add-player').addEventListener('click', () => {
  const name = document.getElementById('new-player-name').value.trim();
  if (!name) return;
  teamState.players.push({ name });
  saveTeamState();
  document.getElementById('new-player-name').value = '';
  renderPlayersList();
});

function renderPlayersList() {
  const el = document.getElementById('players-list');
  el.innerHTML = '';
  teamState.players.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.innerHTML = `
      <span class="player-name">${escHtml(p.name)}</span>
      <button class="current-item-remove player-remove" data-idx="${idx}" title="Verwijder speler">✕</button>
    `;
    row.querySelector('.player-remove').addEventListener('click', () => {
      teamState.players.splice(idx, 1);
      saveTeamState(); renderPlayersList();
    });
    el.appendChild(row);
  });
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function hashPassword(pw) {
  if (!pw) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ── Charts ────────────────────────────────────────

function updateCharts() {
  updateHistoryChart();
}

function chartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#8a7248', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
      y: { ticks: { color: '#8a7248', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true },
    },
  };
}

function updateHistoryChart() {
  const dateCounts = {};
  state.crossed.forEach(arr => {
    arr.forEach(item => {
      if (item && item.checked && item.date) {
        dateCounts[item.date] = (dateCounts[item.date] || 0) + 1;
      }
    });
  });
  const labels = Object.keys(dateCounts).sort();
  const data = labels.map(d => dateCounts[d]);
  const ctx = document.getElementById('chart-history');
  if (!ctx) return;
  if (historyChart) historyChart.destroy();
  historyChart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: 'rgba(200,170,110,0.75)', borderColor: '#c8aa6e', borderWidth: 1, borderRadius: 3 }] },
    options: { ...chartDefaults(), plugins: { ...chartDefaults().plugins, tooltip: { callbacks: {
      title: t => t[0].label,
      label: t => `${t.parsed.y} item(s) afgevinkt`,
    }}}},
  });
}

// ── Info popup ────────────────────────────────────

const infoPopup = document.getElementById('info-popup');
document.getElementById('info-popup-close').addEventListener('click', () => { infoPopup.style.display = 'none'; });
document.addEventListener('click', e => {
  if (infoPopup.style.display !== 'none' && !infoPopup.contains(e.target) && !e.target.classList.contains('cell-info-btn'))
    infoPopup.style.display = 'none';
});

function showInfoPopup(text, anchor) {
  document.getElementById('info-popup-text').textContent = text;
  infoPopup.style.display = 'block';
  const rect = anchor.getBoundingClientRect();
  const pw = infoPopup.offsetWidth || 220, ph = infoPopup.offsetHeight || 80;
  let left = rect.right + 8, top = rect.top;
  if (left + pw > window.innerWidth - 8) left = rect.left - pw - 8;
  if (top + ph > window.innerHeight - 8) top = window.innerHeight - ph - 8;
  infoPopup.style.left = Math.max(8, left) + 'px';
  infoPopup.style.top = Math.max(8, top) + 'px';
}

// ── Load from URL hash ────────────────────────────

async function loadFromHash() {
  const hash = location.hash.slice(1);
  if (!hash) return;
  try {
    const loaded = JSON.parse(decodeURIComponent(escape(atob(hash))));
    if (Number.isInteger(loaded.gridSize) && loaded.gridSize >= 2) state.gridSize = loaded.gridSize;
    if (typeof loaded.hasFreeCell === 'boolean') state.hasFreeCell = loaded.hasFreeCell;
    if (loaded.style) Object.assign(state.style, loaded.style);
    if (loaded.bonuses) Object.assign(state.bonuses, loaded.bonuses);
    state.endDate = loaded.endDate || '';

    if ((loaded.v === 2 || loaded.v === 3) && Array.isArray(loaded.cells)) {
      state.cells = loaded.cells.map(c => c ? {
        items: c.items.map(it => ({ name: it.name, imageUrl: '', points: it.points || 0 })),
        info: c.info || '', tilePoints: c.tilePoints || 0,
      } : null);
    } else if (Array.isArray(loaded.cellNames)) {
      state.cells = loaded.cellNames.map(name => name
        ? { items: [{ name, imageUrl: '', points: 0 }], info: '', tilePoints: 0 } : null);
    }

    state.playMode = true;
    currentHash = hash;
    state.crossed = state.cells.map(c => cellHasItems(c) ? c.items.map(() => ({ checked: false, date: null })) : []);
    resizeCells();
    loadProgress(hash);
    loadTeamState();

    renderGrid(); applyStyle(); activatePlayMode();
    refetchAllImages();
  } catch {
    history.replaceState(null, '', location.pathname);
  }
}

function activatePlayMode() {
  document.querySelector('.app').classList.add('play-mode');
  document.getElementById('play-bar').style.display = 'flex';
  document.getElementById('play-team-header').style.display = 'flex';
  document.getElementById('play-extended').style.display = 'block';
  document.getElementById('play-progress-wrap').style.display = 'flex';
  if (eventClosed) {
    document.getElementById('event-closed-banner').style.display = 'flex';
  }

  document.getElementById('team-name-input').value = teamState.teamName;
  renderPlayersList();
  startCountdown();
  updateScore();
  updatePointsLegend();
  updateCharts();
  initCompletionTracking();
}

// ── Sync inputs → state ───────────────────────────

function syncUiToState() {
  document.getElementById('grid-size').value = state.gridSize;
  document.getElementById('free-cell').checked = state.hasFreeCell;
  document.getElementById('end-date').value = state.endDate;
  document.getElementById('style-border-color').value = state.style.borderColor;
  document.getElementById('style-cell-bg').value = state.style.cellBg;
  document.getElementById('style-text-color').value = state.style.textColor;
  [['style-border-width','border-width-val','borderWidth'],
   ['style-font-size','font-size-val','fontSize'],
   ['style-cell-opacity','cell-opacity-val','cellOpacity'],
   ['style-cell-size','cell-size-val','cellSize']].forEach(([inputId, labelId, key]) => {
    document.getElementById(inputId).value = state.style[key];
    document.getElementById(labelId).textContent = state.style[key];
  });
  document.getElementById('bonus-row').value = state.bonuses.row;
  document.getElementById('bonus-col').value = state.bonuses.col;
  document.getElementById('bonus-diag-left').value = state.bonuses.diagLeft;
  document.getElementById('bonus-diag-right').value = state.bonuses.diagRight;
  document.getElementById('bonus-fullcard').value = state.bonuses.fullCard;
}

// ── Event listeners ───────────────────────────────

document.getElementById('grid-size').addEventListener('change', e => {
  const val = parseInt(e.target.value, 10);
  if (!Number.isInteger(val) || val < 2) return;
  state.gridSize = val; state.selectedCell = null;
  searchInput.disabled = true;
  searchHint.textContent = 'Klik een cel om items toe te voegen.';
  searchResults.innerHTML = '';
  document.getElementById('info-field-wrap').style.display = 'none';
  document.getElementById('tile-points-wrap').style.display = 'none';
  document.getElementById('current-items-panel').innerHTML = '';
  renderGrid(); applyStyle();
});

document.getElementById('free-cell').addEventListener('change', e => { state.hasFreeCell = e.target.checked; renderGrid(); applyStyle(); });
document.getElementById('end-date').addEventListener('change', e => { state.endDate = e.target.value; });

document.getElementById('bg-upload').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader(); reader.onloadend = () => setBackground(reader.result); reader.readAsDataURL(file);
});
document.getElementById('bg-clear').addEventListener('click', () => { setBackground(null); document.getElementById('bg-upload').value = ''; });

document.getElementById('style-border-color').addEventListener('input', e => { state.style.borderColor = e.target.value; applyStyle(); });
document.getElementById('style-cell-bg').addEventListener('input', e => { state.style.cellBg = e.target.value; applyStyle(); });
document.getElementById('style-text-color').addEventListener('input', e => { state.style.textColor = e.target.value; applyStyle(); });
document.getElementById('style-cell-opacity').addEventListener('input', e => { state.style.cellOpacity = parseInt(e.target.value,10); document.getElementById('cell-opacity-val').textContent = state.style.cellOpacity; applyStyle(); });
document.getElementById('style-border-width').addEventListener('input', e => { state.style.borderWidth = parseInt(e.target.value,10); document.getElementById('border-width-val').textContent = state.style.borderWidth; applyStyle(); });
document.getElementById('style-font-size').addEventListener('input', e => { state.style.fontSize = parseInt(e.target.value,10); document.getElementById('font-size-val').textContent = state.style.fontSize; applyStyle(); });
document.getElementById('style-cell-size').addEventListener('input', e => { state.style.cellSize = parseInt(e.target.value,10); document.getElementById('cell-size-val').textContent = state.style.cellSize; applyStyle(); });

['row','col','diag-left','diag-right','fullcard'].forEach(key => {
  document.getElementById('bonus-' + key).addEventListener('input', e => {
    const stateKey = key.replace('-','').replace('fullcard','fullCard').replace('diagleft','diagLeft').replace('diagright','diagRight');
    state.bonuses[stateKey] = Math.max(0, parseInt(e.target.value,10) || 0);
  });
});

document.getElementById('info-textarea').addEventListener('input', e => {
  const idx = state.selectedCell; if (idx === null) return;
  if (!state.cells[idx]) state.cells[idx] = { items: [], info: '', tilePoints: 0 };
  state.cells[idx].info = e.target.value; refreshCell(idx);
});

document.getElementById('tile-points-input').addEventListener('input', e => {
  const idx = state.selectedCell; if (idx === null) return;
  if (!state.cells[idx]) state.cells[idx] = { items: [], info: '', tilePoints: 0 };
  state.cells[idx].tilePoints = Math.max(0, parseInt(e.target.value,10) || 0); refreshCell(idx);
});

// ── Connection handling ───────────────────────────

window.addEventListener('offline', () => {
  document.getElementById('connection-banner').style.display = 'block';
});

window.addEventListener('online', () => {
  document.getElementById('connection-banner').style.display = 'none';
  if (isFbMode) {
    const msg = document.getElementById('play-save-msg');
    if (msg) {
      msg.textContent = '✓ Verbinding hersteld';
      clearTimeout(msg._reconnect);
      msg._reconnect = setTimeout(() => { msg.textContent = ''; }, 2000);
    }
  }
});

// ── Firebase UI helpers ───────────────────────────

function showFbLoading(text) {
  document.getElementById('fb-loading-text').textContent = text || 'Laden...';
  document.getElementById('fb-loading-overlay').style.display = 'flex';
}
function hideFbLoading() {
  document.getElementById('fb-loading-overlay').style.display = 'none';
}

document.getElementById('btn-publish-event').addEventListener('click', async () => {
  const filledCells = state.cells.filter(c => cellHasItems(c)).length;
  const totalCells = state.gridSize * state.gridSize - (state.hasFreeCell ? 1 : 0);
  if (filledCells === 0) {
    alert('Je kaart heeft geen ingevulde cellen. Voeg eerst items toe.');
    return;
  }
  if (filledCells < Math.ceil(totalCells / 2)) {
    if (!confirm(`Je kaart heeft maar ${filledCells} van de ${totalCells} cellen ingevuld. Toch publiceren?`)) return;
  }
  const eventName = document.getElementById('event-name-input').value.trim();
  const payload = {
    v: 3, gridSize: state.gridSize, hasFreeCell: state.hasFreeCell,
    style: state.style, bonuses: state.bonuses, endDate: state.endDate,
    cells: state.cells.map(c => cellHasItems(c) ? {
      items: c.items.map(it => ({ name: it.name, points: it.points || 0 })),
      info: c.info || '', tilePoints: c.tilePoints || 0,
    } : null),
  };
  showFbLoading('Event aanmaken...');
  try {
    const eventId = await fbPublishEvent(payload, eventName);
    hideFbLoading();
    const base = location.origin + location.pathname;
    const playerUrl = base + '?event=' + eventId;
    const modUrl = base + '?event=' + eventId + '&mod=1';
    document.getElementById('event-url-display').value = playerUrl;
    document.getElementById('mod-url-display').value = modUrl;
    document.getElementById('event-published-wrap').style.display = 'flex';
    document.getElementById('event-published-wrap').style.flexDirection = 'column';
    saveMyEvent(eventId, playerUrl, modUrl, eventName);
  } catch (err) {
    hideFbLoading();
    alert('Publiceren mislukt: ' + err.message);
  }
});

document.getElementById('btn-copy-event-url').addEventListener('click', () => {
  const url = document.getElementById('event-url-display').value;
  navigator.clipboard.writeText(url).catch(() => { prompt('Kopieer:', url); });
});

document.getElementById('btn-copy-mod-url').addEventListener('click', () => {
  const url = document.getElementById('mod-url-display').value;
  navigator.clipboard.writeText(url).catch(() => { prompt('Kopieer:', url); });
});

// ── Load from Firebase event ──────────────────────

async function loadFromEvent(eventId) {
  showFbLoading('Event laden...');
  try {
    const data = await fbLoadEvent(eventId);
    if (!data || !data.card) { hideFbLoading(); alert('Event niet gevonden.'); return; }
    const loaded = data.card;
    if (Number.isInteger(loaded.gridSize) && loaded.gridSize >= 2) state.gridSize = loaded.gridSize;
    if (typeof loaded.hasFreeCell === 'boolean') state.hasFreeCell = loaded.hasFreeCell;
    if (loaded.style) Object.assign(state.style, loaded.style);
    if (loaded.bonuses) Object.assign(state.bonuses, loaded.bonuses);
    state.endDate = loaded.endDate || '';
    if (Array.isArray(loaded.cells)) {
      state.cells = loaded.cells.map(c => c ? {
        items: c.items.map(it => ({ name: it.name, imageUrl: '', points: it.points || 0 })),
        info: c.info || '', tilePoints: c.tilePoints || 0,
      } : null);
    }
    if (data.closed) eventClosed = true;
    state.playMode = true;
    isFbMode = true;
    fbEventId = eventId;
    state.crossed = state.cells.map(c => cellHasItems(c) ? c.items.map(() => ({ checked: false, date: null })) : []);
    resizeCells();
    renderGrid(); applyStyle();
    refetchAllImages();
    hideFbLoading();
    if (fbUnsubEventClosed) fbUnsubEventClosed();
    fbUnsubEventClosed = fbListenEventClosed(eventId, closed => {
      if (closed && !eventClosed) {
        eventClosed = true;
        document.getElementById('event-closed-banner').style.display = 'flex';
        const msg = document.getElementById('play-save-msg');
        if (msg) { msg.textContent = '⚠ Event afgesloten'; }
      }
    });

    const savedTeamId = localStorage.getItem('bingo-fb-team-' + eventId);
    if (savedTeamId) {
      await joinTeam(eventId, savedTeamId);
    } else {
      await showTeamPicker(eventId);
    }
  } catch (err) {
    hideFbLoading();
    alert('Laden mislukt: ' + err.message);
  }
}

// ── Team picker ───────────────────────────────────

async function showTeamPicker(eventId) {
  document.getElementById('team-picker-overlay').style.display = 'flex';
  document.getElementById('team-picker-loading').style.display = 'block';
  document.getElementById('team-picker-list').innerHTML = '';
  document.getElementById('team-picker-error').style.display = 'none';
  document.getElementById('new-team-name-input').value = '';
  try {
    const teams = await fbGetTeams(eventId);
    document.getElementById('team-picker-loading').style.display = 'none';
    renderTeamPickerList(teams);
  } catch (err) {
    document.getElementById('team-picker-loading').textContent = 'Fout: ' + err.message;
  }
}

function renderTeamPickerList(teams) {
  const el = document.getElementById('team-picker-list');
  el.innerHTML = '';
  if (!teams.length) {
    el.innerHTML = '<div class="team-picker-empty">Nog geen teams — maak het eerste aan!</div>';
    return;
  }
  teams.forEach(team => {
    const isLocked = !!team.passwordHash;
    const wrapper = document.createElement('div');

    const btn = document.createElement('button');
    btn.className = 'team-picker-team-btn';
    btn.innerHTML = `<span class="tp-name">${escHtml(team.name)}${isLocked ? ' <span class="tp-lock">🔒</span>' : ''}</span><span class="tp-score">${team.score || 0} pt</span>`;

    if (!isLocked) {
      btn.addEventListener('click', async () => {
        document.getElementById('team-picker-overlay').style.display = 'none';
        await joinTeam(fbEventId, team.id);
      });
      wrapper.appendChild(btn);
    } else {
      const pwRow = document.createElement('div');
      pwRow.className = 'tp-password-row';
      pwRow.style.display = 'none';

      const pwInput = document.createElement('input');
      pwInput.type = 'password';
      pwInput.className = 'tp-password-input';
      pwInput.placeholder = 'Wachtwoord...';

      const joinBtn = document.createElement('button');
      joinBtn.className = 'btn-primary';
      joinBtn.style.cssText = 'width:auto;margin-bottom:0;padding:6px 12px;white-space:nowrap';
      joinBtn.textContent = 'Doe mee';

      const pwError = document.createElement('div');
      pwError.className = 'tp-pw-error';
      pwError.style.display = 'none';
      pwError.textContent = 'Verkeerd wachtwoord';

      pwRow.appendChild(pwInput);
      pwRow.appendChild(joinBtn);
      pwRow.appendChild(pwError);

      btn.addEventListener('click', () => {
        const open = pwRow.style.display !== 'none';
        pwRow.style.display = open ? 'none' : 'flex';
        if (!open) { pwInput.value = ''; pwError.style.display = 'none'; pwInput.focus(); }
      });

      async function attemptJoin() {
        const hash = await hashPassword(pwInput.value);
        if (hash !== team.passwordHash) {
          pwError.style.display = 'block';
          pwInput.select();
          return;
        }
        document.getElementById('team-picker-overlay').style.display = 'none';
        await joinTeam(fbEventId, team.id);
      }

      joinBtn.addEventListener('click', attemptJoin);
      pwInput.addEventListener('keydown', e => { if (e.key === 'Enter') attemptJoin(); });

      wrapper.appendChild(btn);
      wrapper.appendChild(pwRow);
    }

    el.appendChild(wrapper);
  });
}

document.getElementById('btn-create-team').addEventListener('click', async () => {
  const name = document.getElementById('new-team-name-input').value.trim();
  if (!name) return;
  const pw = document.getElementById('new-team-password-input').value;
  const passwordHash = await hashPassword(pw);
  document.getElementById('team-picker-error').style.display = 'none';
  try {
    const teamId = await fbCreateTeam(fbEventId, name, passwordHash);
    document.getElementById('team-picker-overlay').style.display = 'none';
    await joinTeam(fbEventId, teamId);
  } catch (err) {
    const errEl = document.getElementById('team-picker-error');
    errEl.textContent = 'Aanmaken mislukt: ' + err.message;
    errEl.style.display = 'block';
  }
});

async function joinTeam(eventId, teamId) {
  showFbLoading('Team laden...');
  try {
    const teams = await fbGetTeams(eventId);
    const team = teams.find(t => t.id === teamId);
    if (!team) {
      localStorage.removeItem('bingo-fb-team-' + eventId);
      hideFbLoading();
      await showTeamPicker(eventId);
      return;
    }
    fbTeamId = teamId;
    localStorage.setItem('bingo-fb-team-' + eventId, teamId);
    applyFbCrossed(team.crossed);
    teamState.teamName = team.name;
    teamState.players = Array.isArray(team.players) ? team.players : [];
    hideFbLoading();
    activatePlayMode();
    document.getElementById('play-scoreboard-wrap').style.display = 'block';

    if (fbUnsubTeam) fbUnsubTeam();
    fbUnsubTeam = fbListenTeam(eventId, teamId, data => {
      if (_fbIncoming) return;
      _fbIncoming = true;
      applyFbCrossed(data.crossed);
      renderGrid(); applyStyle();
      updateScore(); updateCharts();
      _fbIncoming = false;
    });

    if (fbUnsubScoreboard) fbUnsubScoreboard();
    fbUnsubScoreboard = fbListenAllTeams(eventId, renderScoreboard);
  } catch (err) {
    hideFbLoading();
    alert('Team laden mislukt: ' + err.message);
  }
}

function applyFbCrossed(crossedJson) {
  try {
    const arr = typeof crossedJson === 'string' ? JSON.parse(crossedJson) : crossedJson;
    if (!Array.isArray(arr)) return;
    arr.forEach((v, i) => {
      if (i >= state.crossed.length) return;
      const cell = state.cells[i];
      const count = cellHasItems(cell) ? cell.items.length : 0;
      if (Array.isArray(v)) state.crossed[i] = normCrossed(v, count);
    });
  } catch {}
}

function renderScoreboard(teams) {
  const n = state.gridSize;
  const totalTiles = n * n - (state.hasFreeCell ? 1 : 0);
  const el = document.getElementById('scoreboard-list');
  if (!teams.length) { el.innerHTML = '<div class="score-empty">Geen teams</div>'; return; }
  el.innerHTML = teams.map((t, i) => {
    const isYou = t.id === fbTeamId;
    const tiles = t.tilesComplete !== undefined ? t.tilesComplete : 0;
    const pct = totalTiles > 0 ? Math.round(tiles / totalTiles * 100) : 0;
    return `<div class="scoreboard-row${isYou ? ' scoreboard-you' : ''}">
      <span class="scoreboard-rank">#${i + 1}</span>
      <div class="scoreboard-info">
        <div class="scoreboard-name">${escHtml(t.name)}${isYou ? ' <em>(jij)</em>' : ''}</div>
        <div class="scoreboard-progress-bar"><div class="scoreboard-progress-fill" style="width:${pct}%"></div></div>
      </div>
      <span class="scoreboard-pts">${t.score || 0} pt</span>
    </div>`;
  }).join('');
}

// ── Moderator view ────────────────────────────────

function isCellCompleteForCard(cardCells, crossedArr, idx, freeIdx) {
  if (idx === freeIdx) return true;
  const cell = cardCells[idx];
  if (!cell || !cell.items || !cell.items.length) return false;
  const crossed = crossedArr[idx] || [];
  return cell.items.every((_, i) => {
    const v = crossed[i];
    return v && (typeof v === 'object' ? v.checked : !!v);
  });
}

function getCompletedLineCellsForCard(cardDef, crossedArr) {
  const n = cardDef.gridSize;
  const freeIdx = cardDef.hasFreeCell ? Math.floor(n * n / 2) : -1;
  const cells = cardDef.cells || [];
  const set = new Set();
  const complete = i => isCellCompleteForCard(cells, crossedArr, i, freeIdx);
  for (let r = 0; r < n; r++) {
    const idx = Array.from({length: n}, (_, c) => r * n + c);
    if (idx.every(complete)) idx.forEach(i => set.add(i));
  }
  for (let c = 0; c < n; c++) {
    const idx = Array.from({length: n}, (_, r) => r * n + c);
    if (idx.every(complete)) idx.forEach(i => set.add(i));
  }
  if (n >= 2) {
    const dl = Array.from({length: n}, (_, i) => i * n + i);
    if (dl.every(complete)) dl.forEach(i => set.add(i));
    const dr = Array.from({length: n}, (_, i) => i * n + (n - 1 - i));
    if (dr.every(complete)) dr.forEach(i => set.add(i));
  }
  return set;
}

function buildMiniGrid(cardDef, crossedData) {
  const n = cardDef.gridSize || 5;
  const freeIdx = cardDef.hasFreeCell ? Math.floor(n * n / 2) : -1;
  const cells = cardDef.cells || [];
  let crossed = [];
  try {
    crossed = typeof crossedData === 'string' ? JSON.parse(crossedData) : (crossedData || []);
  } catch {}

  const lineSet = getCompletedLineCellsForCard(cardDef, crossed);
  const countable = n * n - (cardDef.hasFreeCell ? 1 : 0);
  let completeCount = 0;

  const grid = document.createElement('div');
  grid.className = 'mod-mini-grid';
  grid.style.gridTemplateColumns = `repeat(${n}, 1fr)`;

  for (let i = 0; i < n * n; i++) {
    const isFree = i === freeIdx;
    const complete = isCellCompleteForCard(cells, crossed, i, freeIdx);
    if (complete && !isFree) completeCount++;

    const cellEl = document.createElement('div');
    const classes = ['mod-mini-cell'];
    if (isFree) classes.push('mod-free');
    if (complete) classes.push('mod-complete');
    if (lineSet.has(i)) classes.push('mod-line');
    cellEl.className = classes.join(' ');

    const cellData = cells[i];
    if (!isFree && cellData && cellData.items && cellData.items.length) {
      cellEl.title = cellData.items.map(it => it.name).join(', ');
    }
    grid.appendChild(cellEl);
  }

  return { grid, completeCount, countable };
}

function buildTeamCard(team, cardDef) {
  const card = document.createElement('div');
  card.className = 'mod-team-card';

  const { grid, completeCount, countable } = buildMiniGrid(cardDef, team.crossed);
  const pct = countable > 0 ? Math.round(completeCount / countable * 100) : 0;

  const header = document.createElement('div');
  header.className = 'mod-card-header';
  header.innerHTML = `<span class="mod-team-name">${escHtml(team.name)}</span><span class="mod-team-score">${team.score || 0} pt</span>`;
  card.appendChild(header);

  const progressBar = document.createElement('div');
  progressBar.className = 'mod-progress';
  progressBar.innerHTML = `<div class="mod-progress-fill" style="width:${pct}%"></div>`;
  card.appendChild(progressBar);

  const tileLabel = document.createElement('div');
  tileLabel.className = 'mod-tile-count';
  tileLabel.textContent = `${completeCount} / ${countable} tiles`;
  card.appendChild(tileLabel);

  card.appendChild(grid);

  if (team.players && team.players.length) {
    const pl = document.createElement('div');
    pl.className = 'mod-players';
    pl.textContent = team.players.map(p => p.name).join(', ');
    card.appendChild(pl);
  }

  card.addEventListener('click', () => showModTeamDetail(team, cardDef));
  return card;
}

function renderModTeams(teams) {
  const el = document.getElementById('mod-teams-grid');
  if (!modCardDef) return;
  const sorted = [...teams].sort((a, b) => (b.score || 0) - (a.score || 0));
  el.innerHTML = '';
  if (!sorted.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;grid-column:1/-1;padding:20px 0">Geen teams aangemeld...</div>';
  } else {
    sorted.forEach(team => el.appendChild(buildTeamCard(team, modCardDef)));
  }
  document.getElementById('mod-team-count').textContent = `${sorted.length} team${sorted.length !== 1 ? 's' : ''}`;
}

async function loadModView(eventId) {
  isModMode = true;
  showFbLoading('Moderator view laden...');
  try {
    const data = await fbLoadEvent(eventId);
    if (!data || !data.card) { hideFbLoading(); alert('Event niet gevonden.'); return; }
    modCardDef = data.card;
    hideFbLoading();
    document.querySelector('.app').style.display = 'none';
    const modView = document.getElementById('mod-view');
    modView.style.display = 'flex';
    document.getElementById('mod-event-id').textContent = data.name || ('Event: ' + eventId);

    const closeBtn  = document.getElementById('btn-close-event');
    const reopenBtn = document.getElementById('btn-reopen-event');
    const deleteBtn = document.getElementById('btn-delete-event');

    function applyClosedState(closed) {
      closeBtn.style.display  = closed ? 'none' : '';
      reopenBtn.style.display = closed ? '' : 'none';
    }
    applyClosedState(!!data.closed);

    closeBtn.addEventListener('click', async () => {
      if (!confirm('Weet je zeker dat je dit event wil sluiten? Spelers kunnen dan niet meer afvinken.')) return;
      try { await fbCloseEvent(eventId); }
      catch (err) { alert('Sluiten mislukt: ' + err.message); }
    });

    reopenBtn.addEventListener('click', async () => {
      if (!confirm('Event heropenen? Spelers kunnen dan weer afvinken.')) return;
      try { await fbReopenEvent(eventId); }
      catch (err) { alert('Heropenen mislukt: ' + err.message); }
    });

    deleteBtn.addEventListener('click', async () => {
      if (!confirm('Weet je zeker dat je dit event permanent wil verwijderen?')) return;
      if (!confirm('Alle teams en voortgang worden ook verwijderd. Dit kan niet ongedaan worden gemaakt.')) return;
      try {
        showFbLoading('Event verwijderen...');
        await fbDeleteEvent(eventId);
        hideFbLoading();
        try {
          const stored = JSON.parse(localStorage.getItem('bingo-my-events') || '[]');
          localStorage.setItem('bingo-my-events', JSON.stringify(stored.filter(e => e.id !== eventId)));
        } catch {}
        window.location.href = location.pathname;
      } catch (err) {
        hideFbLoading();
        alert('Verwijderen mislukt: ' + err.message);
      }
    });

    fbListenEventClosed(eventId, applyClosedState);
    fbListenAllTeams(eventId, renderModTeams);
  } catch (err) {
    hideFbLoading();
    alert('Moderator view laden mislukt: ' + err.message);
  }
}

function showModTeamDetail(team, cardDef) {
  const n = cardDef.gridSize || 5;
  const freeIdx = cardDef.hasFreeCell ? Math.floor(n * n / 2) : -1;
  const cells = cardDef.cells || [];
  let crossed = [];
  try { crossed = typeof team.crossed === 'string' ? JSON.parse(team.crossed) : (team.crossed || []); } catch {}

  const lineSet = getCompletedLineCellsForCard(cardDef, crossed);
  document.getElementById('mod-detail-team-name').textContent = team.name;
  document.getElementById('mod-detail-team-score').textContent = `${team.score || 0} pt · ${team.tilesComplete || 0} tiles`;

  const content = document.getElementById('mod-detail-content');
  content.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'mod-detail-card';
  grid.style.gridTemplateColumns = `repeat(${n}, 1fr)`;

  for (let i = 0; i < n * n; i++) {
    const isFree    = i === freeIdx;
    const complete  = isCellCompleteForCard(cells, crossed, i, freeIdx);
    const inLine    = lineSet.has(i);
    const cellData  = cells[i];
    const cArr      = crossed[i] || [];

    const cellEl = document.createElement('div');
    const cls = ['mod-detail-cell'];
    if (isFree)              cls.push('mod-detail-free');
    if (complete && !isFree) cls.push('mod-detail-complete');
    if (inLine)              cls.push('mod-detail-line');
    cellEl.className = cls.join(' ');

    if (isFree) {
      const lbl = document.createElement('span');
      lbl.className = 'mod-detail-free-label';
      lbl.textContent = 'FREE';
      cellEl.appendChild(lbl);
    } else if (cellData && cellData.items && cellData.items.length) {
      cellData.items.forEach((item, itemIdx) => {
        const cv        = cArr[itemIdx];
        const checked   = cv && (typeof cv === 'object' ? cv.checked : !!cv);
        const date      = cv && typeof cv === 'object' && cv.date ? cv.date : null;

        const row = document.createElement('div');
        row.className = 'mod-detail-item ' + (checked ? 'mod-item-checked' : 'mod-item-unchecked');

        const chk = document.createElement('span');
        chk.className = 'mod-detail-check';
        chk.textContent = checked ? '✓' : '○';
        row.appendChild(chk);

        const nm = document.createElement('span');
        nm.className = 'mod-detail-item-name';
        nm.textContent = item.name;
        row.appendChild(nm);

        if (date) {
          const dt = document.createElement('span');
          dt.className = 'mod-detail-date';
          dt.textContent = formatDateShort(date);
          row.appendChild(dt);
        }
        cellEl.appendChild(row);
      });
    }
    grid.appendChild(cellEl);
  }
  content.appendChild(grid);

  if (team.players && team.players.length) {
    const pl = document.createElement('div');
    pl.className = 'mod-detail-players';
    pl.textContent = '👥 ' + team.players.map(p => p.name).join(', ');
    content.appendChild(pl);
  }

  document.getElementById('mod-detail-overlay').style.display = 'flex';
}

document.getElementById('mod-detail-close').addEventListener('click', () => {
  document.getElementById('mod-detail-overlay').style.display = 'none';
});
document.getElementById('mod-detail-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('mod-detail-overlay'))
    document.getElementById('mod-detail-overlay').style.display = 'none';
});

// ── My events (localStorage) ──────────────────────

function saveMyEvent(id, eventUrl, modUrl, name) {
  try {
    const events = JSON.parse(localStorage.getItem('bingo-my-events') || '[]');
    const filtered = events.filter(e => e.id !== id);
    filtered.unshift({ id, name: name || '', createdAt: new Date().toISOString(), eventUrl, modUrl });
    localStorage.setItem('bingo-my-events', JSON.stringify(filtered.slice(0, 20)));
  } catch {}
  renderMyEvents();
}

function renderMyEvents() {
  const el = document.getElementById('my-events-list');
  if (!el) return;
  try {
    const events = JSON.parse(localStorage.getItem('bingo-my-events') || '[]');
    if (!events.length) {
      el.innerHTML = '<div class="my-events-empty">Nog geen events gepubliceerd.</div>';
      return;
    }
    el.innerHTML = events.map((e, idx) => {
      const d = new Date(e.createdAt);
      const dateStr = `${d.getDate()}-${d.getMonth()+1}-${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      const primary = e.name ? escHtml(e.name) : dateStr;
      const secondary = e.name ? dateStr : escHtml(e.id);
      return `<div class="my-event-row">
        <div class="my-event-info">
          <span class="my-event-date">${primary}</span>
          <span class="my-event-id">${secondary}</span>
        </div>
        <div class="my-event-actions">
          <a href="${escHtml(e.modUrl)}" target="_blank" class="btn-link-sm" title="Open moderator view">&#9876; Mod</a>
          <button class="btn-link-sm my-event-copy" data-url="${escHtml(e.eventUrl)}" title="Kopieer spelers link">&#128279;</button>
          <button class="current-item-remove my-event-del" data-idx="${idx}" title="Verwijder uit lijst">&#215;</button>
        </div>
      </div>`;
    }).join('');
    el.querySelectorAll('.my-event-del').forEach(btn => {
      btn.addEventListener('click', () => {
        try {
          const events = JSON.parse(localStorage.getItem('bingo-my-events') || '[]');
          events.splice(parseInt(btn.dataset.idx, 10), 1);
          localStorage.setItem('bingo-my-events', JSON.stringify(events));
        } catch {}
        renderMyEvents();
      });
    });
    el.querySelectorAll('.my-event-copy').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.url;
        navigator.clipboard.writeText(url).catch(() => prompt('Kopieer:', url));
        btn.textContent = '✓';
        setTimeout(() => { btn.innerHTML = '&#128279;'; }, 1500);
      });
    });
  } catch {
    el.innerHTML = '';
  }
}

// ── Init ──────────────────────────────────────────

async function init() {
  const params = new URLSearchParams(location.search);
  const eventId = params.get('event');
  const isMod = params.get('mod') === '1';

  if (eventId && isMod) {
    await loadModView(eventId);
  } else if (eventId) {
    await loadFromEvent(eventId);
  } else if (location.hash.length > 1) {
    await loadFromHash();
  } else {
    renderGrid(); applyStyle();
    renderMyEvents();
    initCollapsiblePanels();
  }
}

init();
