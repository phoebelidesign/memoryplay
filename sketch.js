// A layout image or video becomes a grid filling the whole window; each
// active cell is filled with a photo or video from your own archive.

// ---------------------------------------------------------------- state

let layoutKind = null;       // 'image' | 'video'
let layoutImg = null;
let layoutVid = null;
let layoutW = 0, layoutH = 0;
let layoutReady = false;
let layoutFile = null;       // { name, size } of the uploaded layout, for exporting

let media = [];              // { kind:'image'|'video', img, el, w, h }
let mask = null;             // Uint8Array, one flag per grid cell
let maskBuf = null;          // small offscreen buffer for sampling video frames
let assignment = null;       // media index per grid cell, stable as the mask moves
let activeCount = 0;

let blockSize = 12;          // source pixels per grid cell
let cols = 0, rows = 0;
const DEFAULT_BLOCK_MIN = 7, DEFAULT_BLOCK_MAX = 12;
function clampDefaultBlock(v) { return constrain(Math.round(v), DEFAULT_BLOCK_MIN, DEFAULT_BLOCK_MAX); }

// A pixelated layout has real blocks of some size (say 37px). Cells of 7-12px
// keep the grid a sensible size, so pick the whole number in that range whose
// cells line up best with the image's own blocks: 37px blocks give 12px cells
// (about three per block), 40px blocks give 10px cells (exactly four). A block
// size already in range is kept as it is.
function startingBlockFor(detected) {
  if (detected >= DEFAULT_BLOCK_MIN && detected <= DEFAULT_BLOCK_MAX) return detected;
  let best = DEFAULT_BLOCK_MIN, bestMisfit = Infinity;
  for (let b = DEFAULT_BLOCK_MIN; b <= DEFAULT_BLOCK_MAX; b++) {
    const ratio = detected > b ? detected / b : b / detected;
    const misfit = Math.abs(ratio - Math.round(ratio));
    const middle = (DEFAULT_BLOCK_MIN + DEFAULT_BLOCK_MAX) / 2;
    const nearer = Math.abs(b - middle) < Math.abs(best - middle);   // on a tie, prefer the middle of the range
    if (misfit < bestMisfit - 1e-9 || (Math.abs(misfit - bestMisfit) <= 1e-9 && nearer)) { best = b; bestMisfit = misfit; }
  }
  return best;
}

let threshold = 128;         // luminance below this = an active cell
let invert = false;
let shuffleSeed = 1;

let view = { x: 0, y: 0, zoom: 1 };
let baseCell = 1;
let dragging = false, dragX = 0, dragY = 0;

let layoutVideoPlaying = true;  // spacebar toggles this, for a video "think of a memory" layout

let musicEl = null;          // uploaded audio track, if any
let musicFile = null;        // { name, size } of that track, for exporting
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

// Three ways the page runs:
//   index.html          the maker: upload files and build a collage.
//   index.html#rabbit   the viewer: opens the episode in episodes/rabbit/.
//   index.html?author   the maker, plus an Export episode button for preparing
//                       showcase episodes (see exportEpisode).
const EPISODE_SLUG = location.hash.slice(1);
const VIEWER_MODE = EPISODE_SLUG !== '';
const AUTHOR_MODE = !VIEWER_MODE && new URLSearchParams(location.search).has('author');
const EPISODES_DIR = 'episodes';

let viewerMessage = '';      // drawn on the canvas, in place of the poem, while an episode loads
let episodePreviewMask = null;
let previewToken = 0;

// ---------------------------------------------------------------- setup

function setup() {
  const c = createCanvas(windowWidth, windowHeight);
  c.parent('stage');
  pixelDensity(displayDensity());
  buildOverlay();
  noLoop();
  redraw();
  if (VIEWER_MODE) { document.body.classList.add('viewer'); startViewer(); }
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

  // The episode's title, shown in viewer mode.
  ui.episodeTitle = createDiv('').class('episodeTitle').parent(panel);
  ui.episodeTitle.style('display', 'none');

  // Rows marked editOnly are hidden in viewer mode (see style.css).
  const makeRow = (labelText, editOnly) => {
    const row = createDiv().class(editOnly ? 'row editOnly' : 'row').parent(panel);
    if (labelText) createSpan(labelText).class('label').parent(row);
    return row;
  };

  let r = makeRow('Think of a memory', true);
  ui.layout = createFileInput(handleLayoutFile).parent(r);
  ui.layout.elt.setAttribute('accept', 'image/*,video/*');

  r = makeRow('Piece together everything it is made up of', true);
  ui.mediaIn = createFileInput(handleMediaFile, true).parent(r);
  ui.mediaIn.elt.setAttribute('accept', 'image/*,video/*');

  r = makeRow('Pick a tune (if desired)', true);
  ui.audioIn = createFileInput(handleAudioFile).parent(r);
  ui.audioIn.elt.setAttribute('accept', 'audio/*');

  r = makeRow('Block size', true);
  ui.block = createInput(String(blockSize), 'number').parent(r);
  ui.block.size(60);
  ui.block.input(() => {
    const v = parseInt(ui.block.value(), 10);
    if (v >= 1) { blockSize = v; setupGrid(); }
  });
  ui.blockNote = createSpan('').class('note').parent(r);

  r = makeRow('Darkness', true);
  ui.thresh = createSlider(0, 255, threshold).parent(r);
  ui.thresh.input(() => { threshold = ui.thresh.value(); refreshMask(); redraw(); });

  r = makeRow('', true);
  ui.invertBtn = createButton('Invert').parent(r);
  ui.invertBtn.mousePressed(toggleInvert);

  r = makeRow('Filter by tag');
  ui.tagFilterRow = r;
  ui.tagsContainer = createDiv().class('tagRow').parent(r);
  rebuildTagChips();

  // Appears once a layout is loaded (see refreshSaveRow). Save is a placeholder
  // for everyone; Export is for preparing showcase episodes, in author mode only.
  r = makeRow('', true);
  ui.saveRow = r;
  ui.saveBtn = createButton('Save episode').parent(r);
  ui.exportBtn = createButton('Export episode').parent(r);
  // Native click listeners rather than mousePressed: the dialog focuses its
  // text field, and a mousedown handler would have that focus taken straight back.
  ui.saveBtn.elt.addEventListener('click', saveEpisode);
  ui.exportBtn.elt.addEventListener('click', exportEpisode);
  if (!AUTHOR_MODE) ui.exportBtn.style('display', 'none');
  r.style('display', 'none');

  createDiv('Scroll to zoom, drag to move. Press spacebar to play/pause, S to shuffle, 0 to reset view, D to download a large image.' + (VIEWER_MODE ? '' : ' Double-click a pixel to tag it.'))
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
  ui.modalPreview = createDiv().id('modalPreview').parent(box);
  ui.modalPreview.style('display', 'none');
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
// `options.preview`, if given, is a function handed a fresh canvas to draw into
// above the input; `options.placeholder` is the input's hint text.
function showInputModal(label, initial, suggestions, options) {
  options = options || {};
  return new Promise((resolve) => {
    modalOpen = true;
    modalResolve = resolve;
    ui.modalLabel.html(label);
    ui.modalInput.value(initial || '');
    ui.modalInput.attribute('placeholder', options.placeholder || '');
    ui.modalBackdrop.style('display', 'flex');  // first, so the preview can measure its space
    renderModalPreview(options.preview);
    renderModalSuggestions(suggestions || []);
    ui.modalInput.elt.focus();
    ui.modalInput.elt.select();
  });
}

// A fresh canvas each time the dialog opens, so a slow preview from an earlier
// opening can never paint over a later one. Hidden when there's nothing to draw.
function renderModalPreview(drawPreview) {
  ui.modalPreview.html('');
  if (!drawPreview) { ui.modalPreview.style('display', 'none'); return; }
  ui.modalPreview.style('display', 'flex');
  const canvas = document.createElement('canvas');
  ui.modalPreview.elt.appendChild(canvas);
  drawPreview(canvas);
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

// For text that may contain a visitor's own words or a file name.
function setStatusText(msg) { if (ui.status) ui.status.elt.textContent = msg; }

function fileInfo(file) { return { name: file.name || '', size: file.size || 0 }; }

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

// With a music track present, it takes over and the main video stays silent.
// The small pixel videos aren't affected.
function layoutMuted() { return !soundOn || musicEl !== null; }

function applySoundState() {
  if (layoutVid) { layoutVid.elt.muted = layoutMuted(); layoutVid.elt.volume = LAYOUT_VID_VOLUME; }
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
  musicFile = fileInfo(file);
  if (musicEl) musicEl.remove();
  const el = createAudio([srcFor(file)]);
  el.hide();
  el.elt.loop = true;
  el.elt.volume = musicVolume;
  musicEl = el;
  if (layoutVid) layoutVid.elt.muted = layoutMuted();   // the track replaces the main video's sound
  if (soundOn) el.elt.play().catch(() => {});
  setStatus('Music added.');
}

// ---------------------------------------------------------------- loading

function handleLayoutFile(file) {
  if (file.type === 'image') {
    loadImage(srcFor(file), (img) => {
      layoutKind = 'image';
      layoutImg = img;
      layoutFile = fileInfo(file);
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
    el.elt.muted = layoutMuted();  // muted unless sound is on and there's no music track
    attachSmoothLoop(el.elt);
    el.elt.playsInline = true;
    el.elt.addEventListener('loadedmetadata', () => {
      layoutKind = 'video';
      layoutImg = null;
      layoutVid = el;
      layoutFile = fileInfo(file);
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
      media.push({ kind: 'image', img, w: img.width, h: img.height, tags: [], ...fileInfo(file) });
      onMediaChanged();
    });

  } else if (file.type === 'video') {
    const el = createVideo([srcFor(file)]);
    el.hide();
    el.elt.muted = !soundOn;
    attachSmoothLoop(el.elt);
    el.elt.playsInline = true;
    el.elt.preload = 'auto';
    const entry = { kind: 'video', el, w: 0, h: 0, frameCanvas: null, frameCtx: null, tags: [], ...fileInfo(file) };
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
  return best > 1 ? startingBlockFor(best) : clampDefaultBlock(img.width / 64);
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
  refreshSaveRow();
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
  if (VIEWER_MODE || modalOpen || overlayHit()) return;
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
    text(VIEWER_MODE ? viewerMessage : 'Memory as\nmountaintop\nspiral staircase\nbreeze\nrabbit\nwindchimes\ncheese knife\nwarmth\nnail clippers\nmandarin peel\ntrain window\nsnail trail\naccident\nsea urchin\nsisters\nupstairs\nthe brink of\n...', width / 2, height / 2);
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

// ---------------------------------------------------------------- saving + exporting
// Save is a placeholder: it shows the name-and-preview dialog, but nothing is
// stored anywhere. Export (author mode only, index.html?author) turns what's on
// screen into the two files a showcase episode needs: episode.json, which
// records how it was made, and thumb.png, the black-and-white pixel preview for
// the gallery. The small files themselves aren't re-saved: copy the originals
// you uploaded into the episode's files/ folder, under their own names.

function refreshSaveRow() {
  if (!ui.saveRow) return;
  ui.saveRow.style('display', layoutReady && !VIEWER_MODE ? 'flex' : 'none');
}

async function saveEpisode() {
  if (!layoutReady || modalOpen) return;

  const input = await showInputModal('Name this episode', '', null, {
    preview: drawEpisodePreview,
    placeholder: 'Episode name',
  });
  if (input === null) return;

  const title = input.trim() || 'Untitled episode';
  // TODO: this is where an upload would go, if saving is ever connected.
  setStatusText(`Saving isn't connected yet, so "${title}" wasn't stored.`);
}

async function exportEpisode() {
  if (!layoutReady || modalOpen) return;

  if (media.length === 0) {
    setStatusText('Add the small files first; an episode needs something to be made of.');
    return;
  }
  const problem = exportProblem();
  if (problem) { setStatusText(problem); return; }

  const input = await showInputModal('Name this episode', '', null, {
    preview: drawEpisodePreview,
    placeholder: 'Episode name',
  });
  if (input === null) return;

  const title = input.trim() || 'Untitled episode';
  const slug = slugify(title);

  const manifest = buildManifest(title);
  downloadBlob(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }), 'episode.json');

  const thumb = await makeThumbnail(episodePreviewMask || mask.slice());
  if (thumb) setTimeout(() => downloadBlob(thumb, 'thumb.png'), 400);  // spaced so browsers see two downloads

  setStatusText(`Exported "${title}". Make the folder ${EPISODES_DIR}/${slug}/, put episode.json and thumb.png in it, and your original files in a files/ folder inside it.`);
}

// The manifest lists the small files in their current order. That order, the
// shuffle seed and the block size are what reproduce this exact arrangement.
function buildManifest(title) {
  return {
    version: 1,
    title,
    layout: { file: layoutFile.name, kind: layoutKind },
    settings: { blockSize, threshold, invert, shuffleSeed },
    media: media.map((m) => ({ file: m.name, kind: m.kind, tags: m.tags || [] })),
    music: musicFile ? musicFile.name : null,
  };
}

// Every file goes in one files/ folder by name, so two different files sharing
// a name would overwrite each other. The same file used twice is fine.
function exportProblem() {
  const seen = new Map();
  for (const f of [layoutFile, ...media, musicFile]) {
    if (!f) continue;
    if (!f.name) return "One of the files has no name, so it can't be exported. Try uploading it again.";
    if (seen.has(f.name) && seen.get(f.name) !== f.size) {
      return `Two different files are both called ${f.name}. Rename one and upload it again.`;
    }
    seen.set(f.name, f.size);
  }
  return '';
}

function slugify(text) {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'episode';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function makeThumbnail(maskArr) {
  const canvas = document.createElement('canvas');
  paintMaskPreview(canvas, maskArr, { maxW: 480, maxH: 360, dpr: 1 });
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// The episode with the small files stripped out: just the pixelated main image,
// black where pieces would go. A video layout gets a random frame instead.
function drawEpisodePreview(canvas) {
  const token = ++previewToken;
  if (layoutKind !== 'video' || !layoutVid) {
    episodePreviewMask = mask.slice();
    paintMaskPreview(canvas, episodePreviewMask);
    return;
  }
  episodePreviewMask = null;
  paintMaskPreview(canvas, null);  // blank at the right size until the frame arrives
  grabRandomFrameMask((frameMask) => {
    if (token !== previewToken) return;  // a newer dialog has opened since
    episodePreviewMask = frameMask || mask.slice();
    paintMaskPreview(canvas, episodePreviewMask);
  });
}

function paintMaskPreview(canvas, maskArr, opts) {
  opts = opts || {};
  const maxW = opts.maxW || (canvas.parentElement && canvas.parentElement.clientWidth) || 284;
  const maxH = opts.maxH || 200;
  const dpr = opts.dpr || window.devicePixelRatio || 1;
  const cs = Math.min(maxW / cols, maxH / rows);
  const w = Math.round(cols * cs), h = Math.round(rows * cs);

  canvas.width = Math.round(w * dpr);   // setting width also resets the transform
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  if (!maskArr) return;

  ctx.fillStyle = '#000';
  for (let r = 0; r < rows; r++) {
    // Round the edges rather than the size, so neighbours never leave seams.
    const y0 = Math.round((r * h) / rows), y1 = Math.round(((r + 1) * h) / rows);
    for (let c = 0; c < cols; c++) {
      if (!maskArr[c + r * cols]) continue;
      const x0 = Math.round((c * w) / cols), x1 = Math.round(((c + 1) * w) / cols);
      ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
    }
  }
}

// ---------------------------------------------------------------- viewer
// index.html#rabbit opens episodes/rabbit/. There, episode.json says how it was
// made and files/ holds the originals. Everything is rebuilt from those: same
// settings, same file order, same shuffle seed, so it matches what the author built.

window.addEventListener('hashchange', () => location.reload());

class EpisodeError extends Error {}

function showViewerMessage(msg) {
  viewerMessage = msg;
  redraw();
}

async function startViewer() {
  // The slug goes into a URL, so only plain names are accepted.
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(EPISODE_SLUG)) {
    showViewerMessage("This episode isn't available.");
    return;
  }
  const dir = `${EPISODES_DIR}/${EPISODE_SLUG}`;

  try {
    showViewerMessage('Loading…');
    const res = await fetch(`${dir}/episode.json`);
    if (!res.ok) throw new EpisodeError("This episode isn't available.");
    const manifest = validateManifest(await res.json());
    await loadEpisode(manifest, dir);
  } catch (err) {
    console.error(err);
    showViewerMessage(err instanceof EpisodeError ? err.message : "This episode isn't available.");
  }
}

function validateManifest(m) {
  const bad = (why) => new EpisodeError(`This episode's episode.json isn't valid (${why}).`);
  const kinds = ['image', 'video'];

  if (!m || typeof m !== 'object') throw bad('not an object');
  if (m.version !== 1) throw bad('unknown version');
  if (!m.layout || typeof m.layout.file !== 'string' || !m.layout.file || !kinds.includes(m.layout.kind)) throw bad('layout');

  const s = m.settings;
  if (!s || !Number.isInteger(s.blockSize) || s.blockSize < 1 || !Number.isFinite(s.threshold)
      || typeof s.invert !== 'boolean' || !Number.isFinite(s.shuffleSeed)) throw bad('settings');

  if (!Array.isArray(m.media)) throw bad('media');
  for (const item of m.media) {
    if (!item || typeof item.file !== 'string' || !item.file || !kinds.includes(item.kind)) throw bad('a media entry');
  }
  if (m.music != null && typeof m.music !== 'string') throw bad('music');

  return {
    title: typeof m.title === 'string' && m.title.trim() ? m.title.trim() : 'Untitled episode',
    layout: m.layout,
    settings: s,
    media: m.media.map((item) => ({
      file: item.file,
      kind: item.kind,
      tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string') : [],
    })),
    music: m.music || null,
  };
}

async function loadEpisode(manifest, dir) {
  const fileUrl = (name) => `${dir}/files/${encodeURIComponent(name)}`;
  const total = manifest.media.length + 1;
  let done = 0;
  const tick = () => { done++; showViewerMessage(`Loading… ${done} of ${total}`); };

  // Files load in parallel but are assembled in the manifest's order, since
  // that order is part of what reproduces the author's arrangement.
  const entries = await Promise.all(manifest.media.map(async (item) => {
    const entry = item.kind === 'video'
      ? await loadVideoEntry(fileUrl(item.file), item.file)
      : await loadImageEntry(fileUrl(item.file), item.file);
    entry.tags = item.tags;
    tick();
    return entry;
  }));
  media = entries;

  await loadLayoutFromManifest(manifest, fileUrl(manifest.layout.file));
  tick();

  if (manifest.music) {
    const el = createAudio([fileUrl(manifest.music)]);
    el.hide();
    el.elt.loop = true;
    el.elt.volume = musicVolume;
    musicEl = el;   // starts when the visitor turns sound on
    if (layoutVid) layoutVid.elt.muted = layoutMuted();
  }

  rebuildTagChips();
  // Nothing to filter by if the episode was made without tags.
  if (!media.some((m) => m.tags.length > 0)) ui.tagFilterRow.style('display', 'none');
  ui.episodeTitle.elt.textContent = manifest.title;
  ui.episodeTitle.style('display', 'block');
  document.title = `${manifest.title} — Memory play`;
  setStatus('');
  viewerMessage = '';

  if (layoutKind === 'video' || hasPlayingVideo()) loop();
  else redraw();
}

function loadImageEntry(url, name) {
  return new Promise((resolve, reject) => {
    loadImage(
      url,
      (img) => resolve({ kind: 'image', img, w: img.width, h: img.height, tags: [], name, size: 0 }),
      () => reject(new EpisodeError(`Couldn't load ${name}.`))
    );
  });
}

// A missing file fires `error` on the <source> p5 puts inside the video, not on
// the video itself, so both are listened to.
function onVideoError(el, handler) {
  el.elt.addEventListener('error', handler, { once: true });
  el.elt.querySelectorAll('source').forEach((src) => src.addEventListener('error', handler, { once: true }));
}

function loadVideoEntry(url, name) {
  return new Promise((resolve, reject) => {
    const el = createVideo([url]);
    el.hide();
    el.elt.muted = !soundOn;
    attachSmoothLoop(el.elt);
    el.elt.playsInline = true;
    el.elt.preload = 'auto';
    const entry = { kind: 'video', el, w: 0, h: 0, frameCanvas: null, frameCtx: null, tags: [], name, size: 0 };
    el.elt.addEventListener('loadedmetadata', () => {
      entry.w = el.elt.videoWidth;
      entry.h = el.elt.videoHeight;
      el.elt.play().catch(() => {});
      resolve(entry);
    }, { once: true });
    onVideoError(el, () => reject(new EpisodeError(`Couldn't load ${name}.`)));
  });
}

// Like handleLayoutFile, but the settings come from the manifest rather than
// being detected, so the grid is exactly the one the author saw.
function loadLayoutFromManifest(manifest, url) {
  return new Promise((resolve, reject) => {
    const name = manifest.layout.file;
    const bad = () => reject(new EpisodeError(`Couldn't load ${name}.`));
    const s = manifest.settings;
    const applySettings = () => {
      blockSize = s.blockSize;
      threshold = s.threshold;
      invert = s.invert;
      shuffleSeed = s.shuffleSeed;
    };

    if (manifest.layout.kind === 'image') {
      loadImage(url, (img) => {
        layoutKind = 'image';
        layoutImg = img;
        layoutW = img.width; layoutH = img.height;
        applySettings();
        layoutReady = true;
        setupGrid();
        resolve();
      }, bad);
    } else {
      const el = createVideo([url]);
      el.hide();
      el.elt.muted = layoutMuted();
      attachSmoothLoop(el.elt);
      el.elt.playsInline = true;
      el.elt.addEventListener('loadedmetadata', () => {
        layoutKind = 'video';
        layoutImg = null;
        layoutVid = el;
        layoutW = el.elt.videoWidth; layoutH = el.elt.videoHeight;
        applySettings();
        layoutReady = true;
        setupGrid();
        el.elt.play().catch(() => {});
        resolve();
      }, { once: true });
      onVideoError(el, bad);
    }
  });
}


// Reads one random frame of the layout video from a throwaway copy of it, so
// the video on screen keeps playing undisturbed. Calls done(mask), or
// done(null) if the frame can't be read, in which case the caller falls back.
function grabRandomFrameMask(done) {
  const src = layoutVid.elt.currentSrc;
  if (!src) { done(null); return; }

  const v = document.createElement('video');
  let finished = false;
  const finish = (result) => {
    if (finished) return;
    finished = true;
    v.removeAttribute('src');
    v.load();               // release the decoder
    done(result);
  };

  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.addEventListener('loadedmetadata', () => {
    v.currentTime = Math.random() * Math.max(0, v.duration - 0.25);
  }, { once: true });
  v.addEventListener('seeked', () => finish(maskFromFrame(v)), { once: true });
  v.addEventListener('error', () => finish(null), { once: true });
  setTimeout(() => finish(null), 3000);  // never leave the preview blank
  v.src = src;
}

// The same thresholding as sampleMaskFromVideo(), for any frame source.
function maskFromFrame(frameSrc) {
  const buf = document.createElement('canvas');
  buf.width = cols;
  buf.height = rows;
  const ctx = buf.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(frameSrc, 0, 0, cols, rows);
  const px = ctx.getImageData(0, 0, cols, rows).data;

  const out = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) {
    const k = i * 4;
    const lum = 0.299 * px[k] + 0.587 * px[k + 1] + 0.114 * px[k + 2];
    out[i] = (lum < threshold) !== invert ? 1 : 0;
  }
  return out;
}

// ---------------------------------------------------------------- keys

function keyPressed() {
  if (modalOpen) return;
  if (key === ' ') { toggleLayoutVideo(); return false; }
  else if (key === 'd' || key === 'D') { exportHiRes(); return false; }
  else if (key === 's' || key === 'S') reshuffle();
  else if ((key === 'i' || key === 'I') && !VIEWER_MODE) toggleInvert();
  else if (key === '0') resetView();
}