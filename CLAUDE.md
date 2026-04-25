# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

No build step or server required. Open `index.html` directly in a browser, or serve locally:

```bash
npx serve .
# or
python -m http.server 8080
```

`navigator.clipboard` requires a secure context (HTTPS or localhost). Opening `index.html` as a `file://` URL causes the share-link copy button to fall back to a `prompt()` dialog. The share link itself (URL hash) still works.

**For sharing with others:** the share link only works if the HTML is served from a publicly accessible URL. A local `file://` or `localhost` URL cannot be opened on another machine.

## Architecture

Four files, no framework, no bundler, no transpilation.

### Load order and globals

`wiki.js` is loaded before `app.js` and exposes two functions into global scope:
- `searchItems(query)` — OSRS Wiki OpenSearch API
- `fetchItemImageAsDataUrl(title)` — fetches thumbnail as DataURL (blob→base64) so html2canvas can render it without canvas taint; falls back to raw URL if CORS blocks the blob fetch

CDN scripts loaded in `index.html`: **html2canvas** (PNG export) and **Chart.js** (history/EHB graphs).

### State model

All mutable state lives in a single `state` object in `app.js`:

```js
state = {
  gridSize, hasFreeCell,
  background,          // DataURL of uploaded background image
  style: { borderColor, cellBg, cellOpacity, textColor, borderWidth, fontSize, cellSize },
  cells,               // Array[gridSize²] of {items:[{name,imageUrl,points}], info, tilePoints} | null
  selectedCell,        // index | null — cell currently being edited
  playMode,            // true when loaded from a share link
  crossed,             // Array[gridSize²] of [{checked:bool, date:'YYYY-MM-DD'|null}]
  bonuses: { row, col, diagLeft, diagRight, fullCard },
  endDate,             // 'YYYY-MM-DD' or ''
}
```

Team state (team name, players, WOM EHB) is stored separately in `teamState` and persisted to `localStorage` under key `bingo-team-{hash}`.

Progress (crossed state) is persisted to `localStorage` under key `bingo-crossed-{hash}`.

### Two modes

**Editor mode** (no URL hash): full three-column layout — left sidebar (card/style/bonuses/export), center (bingo card), right sidebar (item search + per-cell editing). Clicking a cell selects it; the right panel shows current items with point inputs, tile bonus points, and info text.

**Play mode** (URL hash present): sidebars hidden. Layout becomes a scrollable column: play bar → team name → bingo card → extended panels (countdown, score, team/EHB, graphs). Clicking an item triggers a date-picker popup, then marks it checked. Progress auto-saves to localStorage.

### Share link / save format

`btn-share` encodes `{v:3, gridSize, hasFreeCell, style, bonuses, endDate, cells[]}` as base64 JSON in `location.hash`. Item **images are not stored** — they are re-fetched from the wiki on load via `refetchAllImages()`. Background images are also excluded.

`btn-save-editor` downloads the same payload as a `.json` file for later re-editing. `applyLoadedState()` handles both v2 (no points) and v3 (with points) formats.

### Scoring

`calculateScore()` computes:
1. Per checked item: `item.points`
2. Per fully completed tile: `cell.tilePoints`
3. Per completed row/column/diagonal: `state.bonuses.*`
4. Full card bonus if every cell is complete

A cell is "complete" if it is the FREE cell, or all its items are checked. FREE cell counts as complete for row/column/diagonal scoring.

### WiseOldMan integration

`fetchEhbFromWom(username)` calls `https://api.wiseoldman.net/v2/players/{username}` and returns `data.ehb`. When a player is added, their current EHB is stored as `baselineEhb`. **Bingo EHB = currentEhb − baselineEhb** (starts at 0). Refresh is manual via the "EHB updaten" button.

### CSS architecture

`style.css` uses CSS custom properties set on `#bingo-card` by `applyStyle()`: `--border-color`, `--border-width`, `--cell-bg`, `--text-color`, `--font-size`, `--cell-size`. These cascade into all `.bingo-cell` and `.cell-item` descendants.

Multi-item cell layout is driven by `data-count` attribute on `.bingo-cell`: `[data-count="1"]` through `[data-count="4"]` use 1- or 2-column grids; 5+ use 3 columns. Play mode activates by adding class `play-mode` to `.app`.
