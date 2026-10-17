// One thing will remind you of another, and another.
// A layout image or video becomes a grid filling the whole window; each
// active cell is filled with a photo or video from your own archive.

// ---------------------------------------------------------------- state

let layoutKind = null;       // 'image' | 'video'
let layoutImg = null;
let layoutVid = null;
let layoutW = 0, layoutH = 0;
let layoutReady = false;

let media = [];              // { kind:'image'|'video', img, el, w, h }
let mask = null;             // Uint8Array, one flag per grid cell
let maskBuf = null;          // small offscreen buffer for sampling video frames
let assignment = null;       // media index per grid cell, stable as the mask moves
let activeCount = 0;

let blockSize = 12;          // source pixels per grid cell
let cols = 0, rows = 0;
const DEFAULT_BLOCK_MIN = 10, DEFAULT_BLOCK_MAX = 15;
function clampDefaultBlock(v) { return constrain(Math.round(v), DEFAULT_BLOCK_MIN, DEFAULT_BLOCK_MAX); }

let threshold = 128;         // luminance below this = an active cell
let invert = false;
let shuffleSeed = 1;

let view = { x: 0, y: 0, zoom: 1 };
let baseCell = 1;
let dragging = false, dragX = 0, dragY = 0;

let layoutVideoPlaying = true;  // spacebar toggles this, for a video "think of a memory" layout

let musicEl = null;          // uploaded audio track, if any
let soundOn = false;         // whether video sound + music are playing
let musicVolume = 0.85;      // the one thing that stays clear at any zoom
let volFactor = null;        // per-media volume, recomputed on every draw
const LAYOUT_VID_VOLUME = 0.5;

let activeTagFilters = new Set();  // showing everything when empty

let ui = {};
let panelOpen = false;
let modalOpen = false;
let modalResolve = null;

const BG = 255;

// ---------------------------------------------------------------- setup

function setup() {
  const c = createCanvas(windowWidth, windowHeight);
  c.parent('stage');
  pixelDensity(displayDensity());
  buildOverlay();
  noLoop();
  redraw();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  fitViewToGrid();
  redraw();
}

// ---------------------------------------------------------------- overlay UI

function buildOverlay() {
  // small "+" toggle, bottom left
  ui.menuBtn = createDiv('+').id('menuBtn').parent('shell');
  ui.menuBtn.mousePressed(togglePanel);

  // hidden controls panel
  const panel = createDiv().id('panel').parent('shell');
  ui.panel = panel;

  const makeRow = (labelText) => {
    const row = createDiv().class('row').parent(panel);
    if (labelText) createSpan(labelText).class('label').parent(row);
    return row;
  };

  let r = makeRow('Think of a memory');
  ui.layout = createFileInput(handleLayoutFile).parent(r);
  ui.layout.elt.setAttribute('accept', 'image/*,video/*');

  r = makeRow('Piece together everything it is made up of');
  ui.mediaIn = createFileInput(handleMediaFile, true).parent(r);
  ui.mediaIn.elt.setAttribute('accept', 'image/*,video/*');

  r = makeRow('Pick a tune (if desired)');
  ui.audioIn = createFileInput(handleAudioFile).parent(r);
  ui.audioIn.elt.setAttribute('accept', 'audio/*');

  r = makeRow('Block size');
  ui.block = createInput(String(blockSize), 'number').parent(r);
  ui.block.size(60);
  ui.block.input(() => {
    const v = parseInt(ui.block.value(), 10);
    if (v >= 1) { blockSize = v; setupGrid(); }
  });
  ui.blockNote = createSpan('').class('note').parent(r);

  r = makeRow('Darkness');
  ui.thresh = createSlider(0, 255, threshold).parent(r);
  ui.thresh.input(() => { threshold = ui.thresh.value(); refreshMask(); redraw(); });

  r = makeRow('');
  ui.invertBtn = createButton('Invert').parent(r);
  ui.invertBtn.mousePressed(toggleInvert);

  r = makeRow('Filter by tag');
  ui.tagsContainer = createDiv().class('tagRow').parent(r);
  rebuildTagChips();

  createDiv('Scroll to zoom, drag to move. Press spacebar to play/pause, S to shuffle, 0 to reset view, D to download a large image. Double-click a pixel to tag it.')
    .class('hint').parent(panel);

  ui.status = createDiv('').class('status').parent(panel);

  // sound toggle, bottom right
  ui.soundBtn = createDiv('♪').id('soundBtn').parent('shell');
  ui.soundBtn.mousePressed(toggleSound);

  buildModal();
}

// A styled stand-in for prompt() — the native dialog can't be styled at all,
// it's drawn by the browser outside the page entirely.
function buildModal() {
  const backdrop = createDiv().id('modalBackdrop').parent('shell');
  const box = createDiv().id('modalBox').parent(backdrop);
  ui.modalLabel = createDiv('').id('modalLabel').parent(box);
  ui.modalInput = createInput('').parent(box);
  ui.modalInput.id('modalInput');
  ui.modalSuggestions = createDiv().class('tagRow').id('modalSuggestions').parent(box);
  const btnRow = createDiv().id('modalButtons').parent(box);
  ui.modalCancel = createButton('Cancel').parent(btnRow);
  ui.modalSave = createButton('Save').parent(btnRow);

  ui.modalCancel.mousePressed(() => closeModal(null));
  ui.modalSave.mousePressed(() => closeModal(ui.modalInput.value()));
  ui.modalInput.elt.addEventListener('keydown', (e) => {
    e.stopPropagation();  // never let typing reach the sketch's own shortcuts
    if (e.key === 'Enter') { e.preventDefault(); closeModal(ui.modalInput.value()); }
    else if (e.key === 'Escape') { e.preventDefault(); closeModal(null); }
  });
  ui.modalInput.elt.addEventListener('input', updateModalSuggestionStates);

  ui.modalBackdrop = backdrop;
  backdrop.style('display', 'none');
}

// Returns a Promise<string|null> — null if cancelled — same contract as
// prompt(), so call sites just read differently (await instead of a direct call).
// `suggestions`, if given, renders as clickable chips under the input that
// toggle themselves in or out of the comma-separated value.
function showInputModal(label, initial, suggestions) {
  return new Promise((resolve) => {
    modalOpen = true;
    modalResolve = resolve;
    ui.modalLabel.html(label);
    ui.modalInput.value(initial || '');
    renderModalSuggestions(suggestions || []);
    ui.modalBackdrop.style('display', 'flex');
    ui.modalInput.elt.focus();
    ui.modalInput.elt.select();
  });
}

function parseTagList(str) { return str.split(',').map((t) => t.trim()).filter(Boolean); }
function tagListToString(arr) { return arr.join(', '); }

let modalSuggestionChips = new Map();

function renderModalSuggestions(suggestions) {
  ui.modalSuggestions.html('');
  modalSuggestionChips = new Map();

  if (suggestions.length === 0) { ui.modalSuggestions.style('display', 'none'); return; }
  ui.modalSuggestions.style('display', 'flex');

  for (const tag of suggestions) {
    const chip = createButton(tag).parent(ui.modalSuggestions);
    chip.mousePressed(() => {
      const current = parseTagList(ui.modalInput.value());
      const idx = current.indexOf(tag);
      if (idx >= 0) current.splice(idx, 1); else current.push(tag);
      ui.modalInput.value(tagListToString(current));
      updateModalSuggestionStates();
      ui.modalInput.elt.focus();
    });
    modalSuggestionChips.set(tag, chip);
  }
  updateModalSuggestionStates();
}

// Keeps the chips in sync whether a tag was added by clicking one or by typing.
function updateModalSuggestionStates() {
  const current = new Set(parseTagList(ui.modalInput.value()));
  for (const [tag, chip] of modalSuggestionChips) {
    chip.class(current.has(tag) ? 'tagChip active' : 'tagChip');
  }
}

function closeModal(value) {
  modalOpen = false;
  ui.modalBackdrop.style('display', 'none');
  const resolve = modalResolve;
  modalResolve = null;
  if (resolve) resolve(value);
}

// Rebuilds the tag chip DOM from whatever tags are currently in use across
// the archive. Only called when the tag vocabulary itself changes (an item
// gets tagged or re-tagged) — never on a plain filter toggle, so a click can
// never land mid-rebuild and get lost.
let tagChips = new Map();  // tag -> its chip element, so toggling never rebuilds

function rebuildTagChips() {
  if (!ui.tagsContainer) return;
  ui.tagsContainer.html('');
  tagChips = new Map();

  const allTags = new Set();
  for (const m of media) (m.tags || []).forEach((t) => allTags.add(t));

  // A filter on a tag that no longer exists anywhere would otherwise sit
  // invisibly active, filtering everything out with nothing to click to undo it.
  for (const t of [...activeTagFilters]) {
    if (!allTags.has(t)) activeTagFilters.delete(t);
  }

  if (allTags.size === 0) {
    createSpan('none yet; double-click a pixel to tag it').class('note').parent(ui.tagsContainer);
    return;
  }

  for (const tag of [...allTags].sort()) {
    const chip = createButton(tag).parent(ui.tagsContainer);
    chip.class(activeTagFilters.has(tag) ? 'tagChip active' : 'tagChip');
    chip.mousePressed(() => {
      if (activeTagFilters.has(tag)) activeTagFilters.delete(tag);
      else activeTagFilters.add(tag);
      updateTagChipStates();
      redraw();
    });
    tagChips.set(tag, chip);
  }
}

// Just flips which chips look active, with no DOM rebuild — this is what
// every filter click actually runs.
function updateTagChipStates() {
  for (const [tag, chip] of tagChips) {
    chip.class(activeTagFilters.has(tag) ? 'tagChip active' : 'tagChip');
  }
}

function togglePanel() {
  panelOpen = !panelOpen;
  ui.panel.class(panelOpen ? 'open' : '');
  ui.menuBtn.html(panelOpen ? '\u00d7' : '+');
}

function setStatus(msg) { if (ui.status) ui.status.html(msg); }

// Native `loop` restarts by jumping to the very end and back, which in some
// browsers shows a black frame for an instant. Seeking back slightly before
// the end avoids that stop/restart edge entirely.
function attachSmoothLoop(elt) {
  elt.loop = false;
  elt.addEventListener('timeupdate', () => {
    if (elt.duration && elt.currentTime > elt.duration - 0.12) {
      elt.currentTime = 0;
    }
  });
  elt.addEventListener('ended', () => {
    elt.currentTime = 0;
    elt.play().catch(() => {});
  });
}

// Only the "think of a memory" layout video responds to this — the archive
// media underneath keeps playing regardless.
function toggleLayoutVideo() {
  if (layoutKind !== 'video' || !layoutVid) return;
  layoutVideoPlaying = !layoutVideoPlaying;
  if (layoutVideoPlaying) layoutVid.elt.play().catch(() => {});
  else layoutVid.elt.pause();
}

function toggleInvert() {
  invert = !invert;
  ui.invertBtn.class(invert ? 'active' : '');
  refreshMask();
  redraw();
}

// ---------------------------------------------------------------- sound

const PAUSE_ICON = '<svg width="13" height="13" viewBox="0 0 13 13"><line x1="4" y1="1.5" x2="4" y2="11.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="9" y1="1.5" x2="9" y2="11.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

function toggleSound() {
  soundOn = !soundOn;
  ui.soundBtn.html(soundOn ? PAUSE_ICON : '&#9834;');
  applySoundState();
}

function applySoundState() {
  if (layoutVid) { layoutVid.elt.muted = !soundOn; layoutVid.elt.volume = LAYOUT_VID_VOLUME; }
  for (const m of media) {
    if (m.kind === 'video' && m.el) m.el.elt.muted = !soundOn;
  }
  if (musicEl) {
    musicEl.elt.volume = musicVolume;
    if (soundOn) musicEl.elt.play().catch(() => {});
    else musicEl.elt.pause();
  }
  redraw();  // recompute per-item volumes immediately against the new state
}

function handleAudioFile(file) {
  if (file.type !== 'audio') { setStatus('That needs to be an audio file.'); return; }
  if (musicEl) musicEl.remove();
  const el = createAudio([srcFor(file)]);
  el.hide();
  el.elt.loop = true;
  el.elt.volume = musicVolume;
  musicEl = el;
  if (soundOn) el.elt.play().catch(() => {});
  setStatus('Music added.');
}

// ---------------------------------------------------------------- loading

function handleLayoutFile(file) {
  if (file.type === 'image') {
    loadImage(srcFor(file), (img) => {
      layoutKind = 'image';
      layoutImg = img;
      if (layoutVid) { layoutVid.remove(); layoutVid = null; }
      layoutW = img.width; layoutH = img.height;
      blockSize = detectBlockSize(img);
      ui.block.value(String(blockSize));
      ui.blockNote.html(`detected from a ${img.width} &times; ${img.height} image`);
      layoutReady = true;
      setupGrid();
      autoDetectInvert();
      if (!hasPlayingVideo()) noLoop();
      redraw();
    }, () => setStatus('That image could not be read.'));

  } else if (file.type === 'video') {
    if (layoutVid) layoutVid.remove();
    const el = createVideo([srcFor(file)]);
    el.hide();
    el.elt.muted = !soundOn;      // muted unless sound has been turned on
    attachSmoothLoop(el.elt);
    el.elt.playsInline = true;
    el.elt.addEventListener('loadedmetadata', () => {
      layoutKind = 'video';
      layoutImg = null;
      layoutVid = el;
      layoutW = el.elt.videoWidth;
      layoutH = el.elt.videoHeight;
      // Video frames aren't pre-pixelated, so there's no real grid to detect —
      // just pick something in the sane default range. Editable in the field.
      blockSize = clampDefaultBlock(layoutW / 64);
      ui.block.value(String(blockSize));
      ui.blockNote.html(`from a ${layoutW} &times; ${layoutH} video`);
      layoutReady = true;
      setupGrid();
      autoDetectInvert();
      if (layoutVideoPlaying) el.elt.play().catch(() => {});
      loop();                     // the mask moves now, so redraw continuously
    });

  } else {
    setStatus('The layout needs to be an image or a video.');
  }
}

function handleMediaFile(file) {
  if (file.type === 'image') {
    loadImage(srcFor(file), (img) => {
      media.push({ kind: 'image', img, w: img.width, h: img.height, tags: [] });
      onMediaChanged();
    });

  } else if (file.type === 'video') {
    const el = createVideo([srcFor(file)]);
    el.hide();
    el.elt.muted = !soundOn;
    attachSmoothLoop(el.elt);
    el.elt.playsInline = true;
    el.elt.preload = 'auto';
    const entry = { kind: 'video', el, w: 0, h: 0, frameCanvas: null, frameCtx: null, tags: [] };
    el.elt.addEventListener('loadedmetadata', () => {
      entry.w = el.elt.videoWidth;
      entry.h = el.elt.videoHeight;
      el.elt.play().catch(() => {});
      loop();
    });
    media.push(entry);
    onMediaChanged();
  }
}

function hasPlayingVideo() {
  return media.some((m) => m.kind === 'video');
}

// Object URLs rather than base64 — large videos and audio won't fit in a data URL.
function srcFor(file) {
  if (file.file instanceof File) return URL.createObjectURL(file.file);
  return file.data;
}

function onMediaChanged() {
  buildAssignment();
  setStatus(`${media.length} item${media.length === 1 ? '' : 's'} in the archive, ${activeCount} cells to fill.`);
  redraw();
}

// ---------------------------------------------------------------- layout analysis

// Find the pixel-block size by locating colour changes along sampled rows and
// columns, then taking the largest spacing that lands on every one of them.
function detectBlockSize(img) {
  img.loadPixels();
  const edges = new Set();
  const tol = 12;

  const sample = (horizontal) => {
    const across = horizontal ? img.width : img.height;
    const down = horizontal ? img.height : img.width;
    const lines = 16;
    for (let n = 1; n <= lines; n++) {
      const fixed = Math.floor((down * n) / (lines + 1));
      let pr = -999, pg = -999, pb = -999;
      for (let i = 0; i < across; i++) {
        const x = horizontal ? i : fixed;
        const y = horizontal ? fixed : i;
        const k = (x + y * img.width) * 4;
        const r = img.pixels[k], g = img.pixels[k + 1], b = img.pixels[k + 2];
        if (i > 0 && (Math.abs(r - pr) > tol || Math.abs(g - pg) > tol || Math.abs(b - pb) > tol)) {
          edges.add(i);
        }
        pr = r; pg = g; pb = b;
      }
    }
  };
  sample(true);
  sample(false);

  const list = [...edges];
  if (list.length === 0) return clampDefaultBlock(img.width / 64);

  const limit = Math.min(400, Math.floor(Math.min(img.width, img.height) / 2));
  let best = 1;
  for (let b = 2; b <= limit; b++) {
    let hits = 0;
    for (const e of list) {
      const m = e % b;
      if (m <= 1 || m >= b - 1) hits++;
    }
    if (hits / list.length >= 0.97) best = b;   // keep the largest that explains them
  }
  return best > 1 ? best : clampDefaultBlock(img.width / 64);
}

function setupGrid() {
  if (!layoutReady) return;

  cols = Math.max(1, Math.floor(layoutW / blockSize));
  rows = Math.max(1, Math.floor(layoutH / blockSize));

  mask = new Uint8Array(cols * rows);

  // One buffer pixel per grid cell — the browser averages each block for us,
  // which is far cheaper than reading a full video frame every tick.
  if (maskBuf) maskBuf.remove();
  maskBuf = createGraphics(cols, rows);
  maskBuf.pixelDensity(1);

  buildAssignment();
  refreshMask();
  fitViewToGrid();
  setStatus(`${cols} &times; ${rows} grid, ${activeCount} cells to fill.`);
}

function refreshMask() {
  if (!layoutReady) return;
  if (layoutKind === 'image') sampleMaskFromImage();
  else sampleMaskFromVideo();
}

// Counts active cells for a hypothetical invert setting, without touching the
// live mask — used to auto-pick whichever reading is sparser.
function countActiveFor(testInvert) {
  let count = 0;
  if (layoutKind === 'image') {
    layoutImg.loadPixels();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const sx = Math.min(layoutW - 1, Math.floor(c * blockSize + blockSize / 2));
        const sy = Math.min(layoutH - 1, Math.floor(r * blockSize + blockSize / 2));
        const k = (sx + sy * layoutW) * 4;
        const lum = 0.299 * layoutImg.pixels[k]
                  + 0.587 * layoutImg.pixels[k + 1]
                  + 0.114 * layoutImg.pixels[k + 2];
        if ((lum < threshold) !== testInvert) count++;
      }
    }
  } else {
    if (!layoutVid || layoutVid.elt.readyState < 2) return 0;
    maskBuf.drawingContext.drawImage(layoutVid.elt, 0, 0, cols, rows);
    maskBuf.loadPixels();
    const px = maskBuf.pixels;
    for (let i = 0; i < cols * rows; i++) {
      const k = i * 4;
      const lum = 0.299 * px[k] + 0.587 * px[k + 1] + 0.114 * px[k + 2];
      if ((lum < threshold) !== testInvert) count++;
    }
  }
  return count;
}

// Dark cells are active by default ("black"); if the light reading would fill
// noticeably fewer cells — usually the true sparse shape, rather than a busy
// background swamping most of the frame — switch to that instead. Ties stay black.
function autoDetectInvert() {
  const dark = countActiveFor(false);
  const light = countActiveFor(true);
  invert = light < dark;
  ui.invertBtn.class(invert ? 'active' : '');
  refreshMask();
  setStatus(`${cols} &times; ${rows} grid, ${activeCount} cells to fill.`);
}

// Pixelated stills get sampled at the centre of each block, which respects the
// blocks the image was made with rather than averaging across their edges.
function sampleMaskFromImage() {
  layoutImg.loadPixels();
  activeCount = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const sx = Math.min(layoutW - 1, Math.floor(c * blockSize + blockSize / 2));
      const sy = Math.min(layoutH - 1, Math.floor(r * blockSize + blockSize / 2));
      const k = (sx + sy * layoutW) * 4;
      const lum = 0.299 * layoutImg.pixels[k]
                + 0.587 * layoutImg.pixels[k + 1]
                + 0.114 * layoutImg.pixels[k + 2];
      const on = (lum < threshold) !== invert;
      mask[c + r * cols] = on ? 1 : 0;
      if (on) activeCount++;
    }
  }
}

// Video frames get averaged down to one pixel per cell, so a moving layout
// resolves into the grid the same way a pixelated still does.
function sampleMaskFromVideo() {
  if (!layoutVid || layoutVid.elt.readyState < 2) return;
  maskBuf.drawingContext.drawImage(layoutVid.elt, 0, 0, cols, rows);
  maskBuf.loadPixels();
  activeCount = 0;
  const px = maskBuf.pixels;
  for (let i = 0; i < cols * rows; i++) {
    const k = i * 4;
    const lum = 0.299 * px[k] + 0.587 * px[k + 1] + 0.114 * px[k + 2];
    const on = (lum < threshold) !== invert;
    mask[i] = on ? 1 : 0;
    if (on) activeCount++;
  }
}

// ---------------------------------------------------------------- ordering

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every cell in the whole grid gets an item, whether or not the mask is
// currently over it, so a moving mask sweeps across a fixed arrangement rather
// than reshuffling the archive on every frame.
function buildAssignment() {
  const total = cols * rows;
  assignment = new Int32Array(total);
  if (media.length === 0 || total === 0) return;

  const rand = mulberry32(shuffleSeed);
  let bag = [], k = 0;

  for (let i = 0; i < total; i++) {
    if (k >= bag.length) {
      bag = [...Array(media.length).keys()];
      for (let j = bag.length - 1; j > 0; j--) {
        const swap = Math.floor(rand() * (j + 1));
        [bag[j], bag[swap]] = [bag[swap], bag[j]];
      }
      k = 0;
    }
    assignment[i] = bag[k++];
  }
}

function reshuffle() {
  shuffleSeed = Math.floor(Math.random() * 1e9);
  buildAssignment();
  redraw();
}

// ---------------------------------------------------------------- view

function fitViewToGrid() {
  if (!cols || !rows) return;
  baseCell = Math.min(width / cols, height / rows);
  resetView();
}

function resetView() {
  view.zoom = 1;
  view.x = (width - cols * baseCell) / 2;
  view.y = (height - rows * baseCell) / 2;
  redraw();
}

function cellSize() { return baseCell * view.zoom; }

function mouseWheel(e) {
  if (modalOpen || !layoutReady) return;
  const factor = Math.exp(-e.delta * 0.0015);
  const next = constrain(view.zoom * factor, 0.2, 400);
  const applied = next / view.zoom;
  view.x = mouseX - (mouseX - view.x) * applied;
  view.y = mouseY - (mouseY - view.y) * applied;
  view.zoom = next;
  redraw();
  return false;
}

// Maps a screen point back to the active grid cell under it, or -1 if there
// isn't one (outside the grid, or an inactive cell).
function screenToCell(mx, my) {
  if (!layoutReady || !mask) return -1;
  const cs = cellSize();
  const col = Math.floor((mx - view.x) / cs);
  const row = Math.floor((my - view.y) / cs);
  if (col < 0 || row < 0 || col >= cols || row >= rows) return -1;
  const idx = col + row * cols;
  return mask[idx] ? idx : -1;
}

function itemAtCell(idx) {
  if (idx < 0 || !media.length) return null;
  return media[assignment[idx]];
}

function itemMatchesFilter(item) {
  if (activeTagFilters.size === 0) return true;
  return !!(item && item.tags && item.tags.some((t) => activeTagFilters.has(t)));
}

// Double-click a pixel to tag the item it's showing — with anything: a name,
// a place, a time, a vibe. Comma-separated, replaces whatever was there.
async function doubleClicked() {
  if (modalOpen || overlayHit()) return;
  const item = itemAtCell(screenToCell(mouseX, mouseY));
  if (!item) return;
  const current = item.tags.join(', ');
  const allTags = [...new Set(media.flatMap((m) => m.tags || []))].sort();
  const input = await showInputModal('Tag this item (separate with commas)', current, allTags);
  if (input === null) return;
  item.tags = input.split(',').map((t) => t.trim()).filter(Boolean);
  rebuildTagChips();
  redraw();
}

function mousePressed() {
  if (modalOpen || overlayHit()) return;
  dragging = true; dragX = mouseX; dragY = mouseY;
}
function mouseDragged() {
  if (!dragging || modalOpen) return;
  view.x += mouseX - dragX;
  view.y += mouseY - dragY;
  dragX = mouseX; dragY = mouseY;
  redraw();
}
function mouseReleased() { dragging = false; }

// Ignore canvas drag/zoom-origin clicks that actually landed on overlay UI.
function overlayHit() {
  const el = document.elementFromPoint(mouseX, mouseY);
  return el && el.closest && el.closest('#panel, #menuBtn, #soundBtn');
}

// ---------------------------------------------------------------- drawing

function draw() {
  background(BG);

  if (!layoutReady) {
    noStroke();
    fill(40);
    textAlign(CENTER, CENTER);
    textFont('Times New Roman');
    textSize(16);
    textLeading(36);
    text('Memory as\nmountaintop\nspiral staircase\nbreeze\nrabbit\nwindchimes\ncheese knife\nwarmth\nnail clippers\nmandarin peel\ntrain window\nsnail trail\naccident\nsea urchin\nsisters\nupstairs\nthe brink of\n...', width / 2, height / 2);
    return;
  }

  if (layoutKind === 'video') sampleMaskFromVideo();

  updateVideoFrames();

  if (!volFactor || volFactor.length !== media.length) volFactor = new Float32Array(media.length);
  volFactor.fill(0);

  renderGrid(drawingContext, cellSize(), view.x, view.y, true, true);

  applyVideoVolumes();
}

// Grabs each video's current frame into its own small offscreen canvas, once
// per draw regardless of how many cells reuse that video. Skipped for the
// brief instant right after a loop reset, so the cell keeps showing the last
// good frame instead of the black frame some browsers produce at that point.
function updateVideoFrames() {
  for (const m of media) {
    if (m.kind !== 'video' || !m.el || !m.w) continue;
    const vEl = m.el.elt;
    if (vEl.readyState < 2) continue;
    if (vEl.currentTime < 0.08) continue;  // just looped — reuse last frame
    if (!m.frameCanvas) {
      m.frameCanvas = document.createElement('canvas');
      m.frameCanvas.width = m.w;
      m.frameCanvas.height = m.h;
      m.frameCtx = m.frameCanvas.getContext('2d');
    }
    m.frameCtx.drawImage(vEl, 0, 0, m.w, m.h);
  }
}

// Louder the bigger and more central a video's cell is on screen; silent the
// moment it's panned or zoomed out of view. The uploaded music track ignores
// all of this, so it's the one thing that stays clear at any zoom level.
function applyVideoVolumes() {
  if (!volFactor) return;
  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    if (m.kind === 'video' && m.el) m.el.elt.volume = soundOn ? volFactor[i] : 0;
  }
}

// Shared by the on-screen view and the export. Each cell samples its source at
// full resolution, so zooming in reveals real detail rather than a blur.
// trackAudio (main view only) records how big and how central each visible
// video's cell is, which is what its volume ends up following.
function renderGrid(ctx, cs, ox, oy, cull, trackAudio) {
  ctx.save();
  ctx.imageSmoothingQuality = 'high';

  const cw = cull ? width : cs * cols;
  const ch = cull ? height : cs * rows;
  const cx = cw / 2, cy = ch / 2;
  const maxDist = Math.hypot(cx, cy) || 1;
  // Silent at the fitted "see everything" zoom (and right after pressing 0);
  // volume ramps in only once you've zoomed in a little.
  const ZOOM_AUDIBLE_AT = 1.25;
  const ZOOM_FULL_AT = 6;
  const sizeFactor = view.zoom <= ZOOM_AUDIBLE_AT
    ? 0
    : constrain((view.zoom - ZOOM_AUDIBLE_AT) / (ZOOM_FULL_AT - ZOOM_AUDIBLE_AT), 0, 1);

  for (let r = 0; r < rows; r++) {
    const y0 = Math.round(oy + r * cs);
    const h = Math.round(oy + (r + 1) * cs) - y0;
    if (cull && (y0 + h < 0 || y0 > ch)) continue;

    for (let c = 0; c < cols; c++) {
      const i = c + r * cols;
      if (!mask[i]) continue;

      const x0 = Math.round(ox + c * cs);
      const w = Math.round(ox + (c + 1) * cs) - x0;
      if (cull && (x0 + w < 0 || x0 > cw)) continue;

      const item = media.length ? media[assignment[i]] : null;
      if (!itemMatchesFilter(item)) continue;

      const src = sourceFor(item);

      if (!src) {
        ctx.fillStyle = '#141414';
        ctx.fillRect(x0, y0, w, h);
        continue;
      }

      // Whole item, centred in its cell, original proportions kept.
      const scale = Math.min(w / item.w, h / item.h);
      const dw = item.w * scale, dh = item.h * scale;
      ctx.drawImage(src, x0 + (w - dw) / 2, y0 + (h - dh) / 2, dw, dh);

      if (trackAudio && item.kind === 'video') {
        const dist = Math.hypot(x0 + w / 2 - cx, y0 + h / 2 - cy);
        const proximity = 1 - constrain(dist / maxDist, 0, 1);
        const factor = sizeFactor * (0.15 + 0.85 * proximity);
        const idx = assignment[i];
        if (factor > volFactor[idx]) volFactor[idx] = factor;
      }
    }
  }
  ctx.restore();
}

function sourceFor(item) {
  if (!item) return null;
  if (item.kind === 'image') return item.img ? item.img.canvas : null;
  if (item.kind === 'video') {
    if (item.frameCanvas) return item.frameCanvas;
    if (item.el && item.el.elt.readyState >= 2 && item.w > 0) return item.el.elt;  // before the first cached frame
  }
  return null;
}

// ---------------------------------------------------------------- export

function exportHiRes(targetCell = 96) {
  if (!layoutReady) return;

  // Keep the buffer inside what browsers will allocate.
  const maxSide = 8192;
  const cs = Math.max(1, Math.floor(Math.min(targetCell, maxSide / cols, maxSide / rows)));
  const w = cols * cs, h = rows * cs;

  setStatus(`Saving at ${w} &times; ${h}…`);
  const g = createGraphics(w, h);
  g.pixelDensity(1);
  g.background(BG);
  renderGrid(g.drawingContext, cs, 0, 0, false, false);
  save(g, 'dont-forget-about-me.png');
  g.remove();
  setStatus(`Saved at ${w} &times; ${h}.`);
}

// ---------------------------------------------------------------- keys

function keyPressed() {
  if (modalOpen) return;
  if (key === ' ') { toggleLayoutVideo(); return false; }
  else if (key === 'd' || key === 'D') { exportHiRes(); return false; }
  else if (key === 's' || key === 'S') reshuffle();
  else if (key === 'i' || key === 'I') toggleInvert();
  else if (key === '0') resetView();
}