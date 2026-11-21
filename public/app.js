'use strict';

/*
 * PIXEL CIPHER LAB — browser client.
 *
 * No encryption happens here. The browser decodes an image to 65536
 * grayscale bytes, posts them to the server, and renders what comes back.
 * Timelines use the bundled anime.js; control feedback is styled in CSS.
 */

const $ = id => document.getElementById(id);

const apiStatus = $('apiStatus');
const apiLatency = $('apiLatency');
const dropzone = $('dropzone');
const fileInput = $('fileInput');
const chooseBtn = $('chooseBtn');
const keyInput = $('keyInput');
const ivInput = $('ivInput');
const randomKeyBtn = $('randomKeyBtn');
const randomIvBtn = $('randomIvBtn');
const newIvBtn = $('newIvBtn');
const gridToggle = $('gridToggle');
const pipeDot = $('pipeDot');
const panelOriginal = $('panelOriginal');
const panelECB = $('panelECB');
const panelCBC = $('panelCBC');
const canvasOriginal = $('canvasOriginal');
const canvasECB = $('canvasECB');
const canvasCBC = $('canvasCBC');
const unchangedBadge = $('unchangedBadge');
const insightText = $('insightText');
const leakEcbRing = $('leakEcbRing');
const leakCbcRing = $('leakCbcRing');
const leakEcbNum = $('leakEcbNum');
const leakCbcNum = $('leakCbcNum');
const histogramCanvas = $('histogramCanvas');
const eventLog = $('eventLog');
const presentCaption = $('presentCaption');
const presentBtn = $('presentBtn');

const motionQuery = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;
const reduced = Boolean(motionQuery && motionQuery.matches);
const HEX32 = /^[0-9a-fA-F]{32}$/;
const SIZE = 65536;
const BLOCKS = 4096;

let jobCounter = 0;
let busy = false;
let gridOn = false;
let currentGray = null; // Uint8Array(65536) of the loaded image
let lastResult = null; // { ecbBytes, cbcBytes, ecbDup, cbcDup }

/* ------------------------------------------------------------------ */
/* Base64 helpers (chunked — spreading 65536 args overflows the stack) */
/* ------------------------------------------------------------------ */

function bytesToBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 8192) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  }
  return btoa(s);
}

function base64ToBytes(b) {
  const s = atob(b);
  const o = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i);
  return o;
}

/* ------------------------------------------------------------------ */
/* Insight line                                                        */
/* ------------------------------------------------------------------ */

function setInsight(text, isError) {
  insightText.textContent = text;
  insightText.classList.toggle('bad', Boolean(isError));
  insightText.style.color = isError ? 'var(--orange)' : '';
}

/* ------------------------------------------------------------------ */
/* Image decoding                                                      */
/* ------------------------------------------------------------------ */

function canvasToGray(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, 256, 256).data;
  const gray = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    const j = i * 4;
    gray[i] = Math.round(0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]);
  }
  return gray;
}

function imageToGray(img) {
  const off = document.createElement('canvas');
  off.width = 256;
  off.height = 256;
  const ctx = off.getContext('2d', { willReadFrequently: true });
  // Fill first so transparent PNGs are not black.
  ctx.fillStyle = '#0F172A';
  ctx.fillRect(0, 0, 256, 256);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  ctx.drawImage(img, sx, sy, side, side, 0, 0, 256, 256);
  return canvasToGray(off);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

const IMAGE_NAME = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

async function handleFile(file) {
  if (!file) return;
  // Some drag sources report an empty type, so fall back to the file name.
  const looksImage = file.type ? file.type.startsWith('image/') : IMAGE_NAME.test(file.name || '');
  if (!looksImage) {
    setInsight('That file is not an image.', true);
    return;
  }
  if (file.size > 12 * 1024 * 1024) {
    setInsight('Image is larger than 12 MB.', true);
    return;
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    submitPlate(imageToGray(img));
  } catch (error) {
    setInsight('Could not read that image.', true);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* Sample plates are drawn locally — no external requests. */

function makeSample(kind) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  if (kind === 'gradient') {
    const grad = ctx.createLinearGradient(0, 0, 256, 256);
    grad.addColorStop(0, '#0F172A');
    grad.addColorStop(0.5, '#C4471F');
    grad.addColorStop(1, '#EFEDE6');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
  } else if (kind === 'text') {
    ctx.fillStyle = '#EFEDE6';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = '#C4471F';
    ctx.lineWidth = 2;
    ctx.strokeRect(48, 40, 160, 170);
    ctx.fillStyle = '#141414';
    ctx.textAlign = 'center';
    ctx.font = 'bold 34px Georgia, serif';
    ctx.fillText('ECB', 128, 90);
    ctx.fillText('LEAKS', 128, 130);
    ctx.font = '12px ui-monospace, Menlo, monospace';
    ctx.fillText('4096 BLOCKS', 128, 170);
    ctx.fillText('SAME KEY SAME IMAGE', 128, 190);
  } else {
    // penguin
    ctx.fillStyle = '#0F172A';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#EFEDE6';
    ctx.beginPath();
    ctx.ellipse(128, 150, 70, 85, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#141414';
    ctx.beginPath();
    ctx.ellipse(128, 95, 52, 48, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#EFEDE6';
    ctx.beginPath();
    ctx.ellipse(128, 105, 34, 30, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#141414';
    ctx.beginPath();
    ctx.arc(115, 100, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(141, 100, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#C4471F';
    ctx.beginPath();
    ctx.moveTo(128, 112);
    ctx.lineTo(118, 120);
    ctx.lineTo(138, 120);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#141414';
    ctx.beginPath();
    ctx.ellipse(60, 150, 16, 45, -0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(196, 150, 16, 45, 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvasToGray(canvas);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

// Pattern press: preview locally, submit only when the plate is printed.
const pressPreview = $('pressPreview');
function inkPattern() {
  const pitch = $('pressPitch').valueAsNumber;
  const die = $('pressDie').value;
  $('pitchValue').value = pitch + ' px';
  const bytes = new Uint8Array(SIZE);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const u = Math.floor(x / pitch), v = Math.floor(y / pitch);
      let band = u + v;
      if (die === 'rings') band = Math.floor(Math.hypot(x - 128, y - 128) / pitch);
      if (die === 'weave') band = (u + v) % 2 ? Math.floor(x * 4 / pitch) : Math.floor(y * 4 / pitch);
      bytes[y * 256 + x] = band % 2 ? 40 : 228;
    }
  }
  renderGray(pressPreview, bytes, SIZE);
}
$('pressPitch').addEventListener('input', inkPattern);
$('pressDie').addEventListener('change', inkPattern);
$('patternPress').addEventListener('toggle', () => { if ($('patternPress').open) inkPattern(); });
$('printPattern').addEventListener('click', () => submitPlate(canvasToGray(pressPreview)));

function submitPlate(bytes) {
  if (busy) return;
  currentGray = bytes;
  renderGray(canvasOriginal, bytes, SIZE);
  $('exportPlate').disabled = true;
  probe.hidden = true;
  document.querySelector('.match-finder').hidden = true;
  runEncrypt('both');
}

function renderGray(canvas, bytes, size) {
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(256, 256);
  const data = img.data;
  const n = Math.min(bytes.length, size);
  for (let i = 0; i < n; i++) {
    const v = bytes[i];
    const j = i * 4;
    data[j] = v;
    data[j + 1] = v;
    data[j + 2] = v;
    data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function drawOverlay(canvas, dupMap) {
  if (!dupMap) return;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(196,71,31,0.28)';
  for (let i = 0; i < BLOCKS; i++) {
    if (dupMap[i] === 1) {
      const col = i % 16;
      const row = Math.floor(i / 16);
      ctx.fillRect(col * 16, row, 16, 1);
    }
  }
  ctx.strokeStyle = 'rgba(196,71,31,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0; k <= 256; k += 16) {
    ctx.moveTo(k + 0.5, 0);
    ctx.lineTo(k + 0.5, 256);
    ctx.moveTo(0, k + 0.5);
    ctx.lineTo(256, k + 0.5);
  }
  ctx.stroke();
}

function redrawCiphertexts() {
  if (!lastResult) return;
  if (lastResult.ecbBytes) {
    renderGray(canvasECB, lastResult.ecbBytes, SIZE);
    if (gridOn) drawOverlay(canvasECB, lastResult.ecbDup);
  }
  if (lastResult.cbcBytes) {
    renderGray(canvasCBC, lastResult.cbcBytes, SIZE);
    if (gridOn) drawOverlay(canvasCBC, lastResult.cbcDup);
  }
}

/* ------------------------------------------------------------------ */
/* Gauges, histogram                                                   */
/* ------------------------------------------------------------------ */

function setGauge(ring, num, pct) {
  const r = parseFloat(ring.getAttribute('r')) || 34;
  const circ = 2 * Math.PI * r;
  ring.style.strokeDasharray = String(circ);
  ring.style.strokeDashoffset = String(circ);
  if (reduced) {
    ring.style.strokeDashoffset = String(circ * (1 - pct / 100));
    num.textContent = pct.toFixed(1) + '%';
    return;
  }
  anime.remove(ring);
  anime({
    targets: ring,
    strokeDashoffset: [circ, circ * (1 - pct / 100)],
    duration: 900,
    easing: 'easeOutExpo',
  });
  const counter = { v: parseFloat(num.textContent) || 0 };
  anime({
    targets: counter,
    v: pct,
    duration: 900,
    easing: 'easeOutExpo',
    update: () => {
      num.textContent = counter.v.toFixed(1) + '%';
    },
  });
}

function drawHistogram(hists) {
  const ctx = histogramCanvas.getContext('2d');
  const W = histogramCanvas.width;
  const H = histogramCanvas.height;
  ctx.clearRect(0, 0, W, H);

  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(107,104,98,0.28)';
  ctx.beginPath();
  for (let y = 0; y <= H; y += 45) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(W, y + 0.5);
  }
  for (let x = 0; x <= W; x += 60) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
  }
  ctx.stroke();

  const css = getComputedStyle(document.documentElement);
  const series = [
    { key: 'plain', label: 'PLAIN', color: css.getPropertyValue('--muted').trim() || '#6B6862' },
    { key: 'ecb', label: 'ECB', color: css.getPropertyValue('--orange').trim() || '#C4471F' },
    { key: 'cbc', label: 'CBC', color: css.getPropertyValue('--teal').trim() || '#0F6B60' },
  ];

  const top = 16;
  const bottom = H - 2;
  for (const s of series) {
    const hist = hists[s.key];
    if (!hist) continue;
    const max = Math.max(1, ...hist);
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * W;
      const y = bottom - (hist[i] / max) * (bottom - top);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  ctx.font = '9px ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'top';
  let lx = 6;
  for (const s of series) {
    if (!hists[s.key]) continue;
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, 4, 8, 8);
    ctx.fillText(s.label, lx + 12, 3);
    lx += 12 + ctx.measureText(s.label).width + 14;
  }
}

/* ------------------------------------------------------------------ */
/* Event log, pipeline, scans                                          */
/* ------------------------------------------------------------------ */

function appendLog(message) {
  const li = document.createElement('li');
  li.className = 'log-row';
  const now = new Date();
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':');
  li.textContent = time + ' ' + message;
  eventLog.appendChild(li);
  if (!reduced) {
    anime({
      targets: li,
      opacity: [0, 1],
      translateY: [8, 0],
      duration: 350,
      easing: 'easeOutExpo',
    });
  }
}

const stageToNode = {
  received: 'image',
  ecb: 'aes',
  cbc: 'aes',
  analysis: 'analysis',
  done: 'result',
};

const pipeOrder = ['image', 'api', 'aes', 'analysis', 'result'];

// Stages arrive in order, so reaching one implies every earlier one finished.
// This keeps the whole chain lit even if a frame is dropped on the wire.
function markNode(step) {
  const index = pipeOrder.indexOf(step);
  if (index < 0) return;
  pipeOrder.slice(0, index + 1).forEach(name => {
    const node = document.querySelector('.pipe-node[data-step="' + name + '"]');
    if (node) node.classList.add('active');
  });
}

function resetPipeline() {
  document.querySelectorAll('.pipe-node').forEach(node => node.classList.remove('active'));
}

function animatePipeDot() {
  if (reduced) {
    pipeDot.style.left = '100%';
    return;
  }
  anime.remove(pipeDot);
  pipeDot.style.left = '0%';
  anime({
    targets: '#pipeDot',
    left: ['0%', '100%'],
    duration: 900,
    easing: 'easeInOutSine',
  });
}

// Reveal the finished pixels and the read head together, at the plate's
// actual size. No scan runs while the server is idle or still computing.
function printPlate(panel) {
  if (motionQuery?.matches) return;
  const scan = panel.querySelector('.scan');
  const canvas = panel.querySelector('canvas');
  const timing = { duration: 410, easing: 'cubic-bezier(.23,.7,.32,1)' };
  for (const element of [scan, canvas]) {
    element.getAnimations().forEach(animation => animation.cancel());
  }
  canvas.animate([{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0)' }], timing);
  scan.animate([{ top: '0%', opacity: .85 }, { top: '100%', opacity: 0 }], timing);
}

// Each grayscale AES block is 16 consecutive pixels on one 256-pixel row.
const bay = $('compare');
const probe = bay.querySelector('.probe');
const probeBlock = $('probeBlock');
function inspectBlock(index) {
  probeBlock.value = index;
  $('probeReadout').textContent = String(index).padStart(4, '0') + ' / 4095';
  bay.style.setProperty('--probe-x', (index % 16) * 100 / 16 + '%');
  bay.style.setProperty('--probe-y', Math.floor(index / 16) * 100 / 256 + '%');
  bay.classList.add('probing');
}
probeBlock.addEventListener('input', () => inspectBlock(probeBlock.valueAsNumber));
probeBlock.addEventListener('focus', () => inspectBlock(probeBlock.valueAsNumber));
probeBlock.addEventListener('blur', () => bay.classList.remove('probing'));
bay.querySelectorAll('.canvas-wrap').forEach(wrap => {
  function point(event) {
    if (probe.hidden) return;
    const rect = wrap.getBoundingClientRect();
    const bin = (offset, extent, count) => Math.max(0, Math.min(count - 1, Math.floor(offset / extent * count)));
    inspectBlock(bin(event.clientY - rect.top, rect.height, 256) * 16 + bin(event.clientX - rect.left, rect.width, 16));
  }
  wrap.addEventListener('pointerdown', point);
  wrap.addEventListener('pointermove', point);
  wrap.addEventListener('pointerleave', () => {
    if (document.activeElement !== probeBlock) bay.classList.remove('probing');
  });
});

function showBadgeAndPulse() {
  unchangedBadge.classList.remove('hidden');
  if (reduced) {
    unchangedBadge.style.opacity = '1';
    setTimeout(() => {
      unchangedBadge.style.opacity = '0';
      unchangedBadge.classList.add('hidden');
    }, 1400);
    return;
  }
  anime.remove(unchangedBadge);
  anime({
    targets: unchangedBadge,
    opacity: [0, 1],
    duration: 300,
    easing: 'easeOutExpo',
    complete: () => {
      setTimeout(() => {
        anime({
          targets: unchangedBadge,
          opacity: [1, 0],
          duration: 300,
          easing: 'easeInOutQuad',
          complete: () => unchangedBadge.classList.add('hidden'),
        });
      }, 1400);
    },
  });

}

/* ------------------------------------------------------------------ */
/* Key / IV                                                            */
/* ------------------------------------------------------------------ */

async function ensureKeyIv() {
  let key = keyInput.value.trim();
  let iv = ivInput.value.trim();
  if (!key) {
    const res = await fetch('/api/new-key', { method: 'POST' });
    if (!res.ok) throw new Error('Could not get a new key from the server.');
    key = (await res.json()).key;
    keyInput.value = key;
  }
  if (!iv) {
    const res = await fetch('/api/new-iv', { method: 'POST' });
    if (!res.ok) throw new Error('Could not get a new IV from the server.');
    iv = (await res.json()).iv;
    ivInput.value = iv;
  }
  if (!HEX32.test(key)) {
    keyInput.classList.add('invalid');
    throw new Error('Key must be 32 hex characters.');
  }
  if (!HEX32.test(iv)) {
    ivInput.classList.add('invalid');
    throw new Error('IV must be 32 hex characters.');
  }
  keyInput.classList.remove('invalid');
  ivInput.classList.remove('invalid');
  return { key, iv };
}

async function randomise(url, input, label) {
  try {
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    input.value = data.key || data.iv;
    input.classList.remove('invalid');
  } catch (error) {
    setInsight('Could not get a new ' + label + ' from the server.', true);
  }
}

/* ------------------------------------------------------------------ */
/* Encrypt flow                                                        */
/* ------------------------------------------------------------------ */

// Index exact 16-byte matches, not pixels that merely look alike. Keep one
// witness per repeated occurrence, paired with its first plaintext block.
let pairs = [], pairIndex = 0;
function indexPairs(plain) {
  const first = new Map();
  pairs = [];
  pairIndex = 0;
  for (let block = 0; block < BLOCKS; block++) {
    const key = String.fromCharCode(...plain.subarray(block * 16, block * 16 + 16));
    if (first.has(key)) pairs.push([first.get(key), block]);
    else first.set(key, block);
  }
}
function showPair() {
  const rows = $('pairRows');
  rows.replaceChildren();
  document.querySelector('.match-finder').hidden = false;
  $('nextPair').disabled = pairs.length < 2;
  if (!pairs.length) {
    $('pairStatus').textContent = 'No repeated plaintext blocks. Try a checkerboard from the pattern press.';
    return;
  }
  const [a, b] = pairs[pairIndex];
  $('pairStatus').textContent = `Block ${a} (top) and block ${b} (bottom) have identical input. Compare their 16 bytes in hex.`;
  for (const [label, bytes] of [['Plaintext', currentGray], ['ECB', lastResult.ecbBytes], ['CBC', lastResult.cbcBytes]]) {
    const row = document.createElement('div');
    row.className = 'pair-row';
    const heading = document.createElement('h3');
    heading.textContent = label;
    const plate = document.createElement('div');
    plate.className = 'byte-plate';
    for (const pos of [a, b]) {
      const line = document.createElement('div');
      line.className = 'byte-line';
      for (const byte of bytes.subarray(pos * 16, pos * 16 + 16)) {
        const cell = document.createElement('span');
        cell.textContent = byte.toString(16).padStart(2, '0');
        cell.style.backgroundColor = `rgb(${byte},${byte},${byte})`;
        cell.style.color = byte < 118 ? '#fff' : '#000';
        line.append(cell);
      }
      plate.append(line);
    }
    const same = bytes.subarray(a * 16, a * 16 + 16).every((n, i) => n === bytes[b * 16 + i]);
    const mark = document.createElement('span');
    mark.className = 'pair-mark' + (same ? ' same' : '');
    mark.textContent = same ? 'Match' : 'Differ';
    row.append(heading, plate, mark);
    rows.append(row);
  }
}
$('nextPair').addEventListener('click', () => {
  pairIndex = (pairIndex + 1) % pairs.length;
  showPair();
});

// Export the measured bytes rather than a screenshot of animated overlays.
$('exportPlate').addEventListener('click', () => {
  if (!lastResult?.ecbBytes) return;
  const sheet = document.createElement('canvas');
  sheet.width = 864;
  sheet.height = 390;
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#EFEDE6';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.fillStyle = '#141414';
  ctx.font = '26px Georgia, serif';
  ctx.fillText('Pixel Cipher Lab', 24, 36);
  ctx.font = '12px monospace';
  ctx.fillText('AES-128 / COMPARISON PLATE', 24, 58);
  const tile = document.createElement('canvas');
  tile.width = tile.height = 256;
  for (const [i, [label, bytes]] of [['01 / PLAINTEXT', lastResult.plain], ['02 / ECB', lastResult.ecbBytes], ['03 / CBC', lastResult.cbcBytes]].entries()) {
    const x = 24 + i * 280;
    renderGray(tile, bytes, SIZE);
    ctx.drawImage(tile, x, 78);
    ctx.fillText(label, x, 358);
  }
  sheet.toBlob(blob => {
    if (!blob) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'pixel-cipher-plate.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    appendLog('comparison plate exported');
  });
});

function handleResult(data, scope) {
  const stats = data.stats;
  lastResult = {
    plain: currentGray,
    key: data.meta.key,
    ecbBytes: data.ecb ? base64ToBytes(data.ecb) : lastResult?.ecbBytes,
    cbcBytes: base64ToBytes(data.cbc),
    ecbDup: stats.ecb ? base64ToBytes(stats.ecb.dupMapBase64) : lastResult?.ecbDup,
    cbcDup: base64ToBytes(stats.cbc.dupMapBase64),
  };

  renderGray(canvasOriginal, currentGray, SIZE);

  if (scope === 'both') {
    renderGray(canvasECB, lastResult.ecbBytes, SIZE);
    renderGray(canvasCBC, lastResult.cbcBytes, SIZE);
    if (gridOn) {
      drawOverlay(canvasECB, lastResult.ecbDup);
      drawOverlay(canvasCBC, lastResult.cbcDup);
    }
    setGauge(leakEcbRing, leakEcbNum, stats.ecb.leakPct);
    setGauge(leakCbcRing, leakCbcNum, stats.cbc.leakPct);
    drawHistogram(stats.hists);
    setInsight(
      'ECB repeated ' + stats.ecb.repeats + ' of 4096 blocks. CBC repeated ' + stats.cbc.repeats + '.'
    );
    printPlate(panelECB);
    printPlate(panelCBC);
  } else {
    // scope 'cbc' — the New IV proof. Never touch #canvasECB.
    renderGray(canvasCBC, lastResult.cbcBytes, SIZE);
    if (gridOn) drawOverlay(canvasCBC, lastResult.cbcDup);
    setGauge(leakCbcRing, leakCbcNum, stats.cbc.leakPct);
    drawHistogram(stats.hists);
    setInsight('New IV, same image: ECB is identical every time. CBC is different every time.');
    printPlate(panelCBC);
    showBadgeAndPulse();
  }

  if (scope === 'both') indexPairs(currentGray);
  showPair();
  $('exportPlate').disabled = false;
  probe.hidden = false;
  if (data.meta && typeof data.meta.durationMs === 'number') {
    apiLatency.textContent = 'API ' + data.meta.durationMs + 'MS';
  }
}

/* Open the stage stream and wait for the connection to be accepted, so the
   server's first stage event cannot fire before anyone is listening. */

function openEvents(jobId) {
  const source = new EventSource('/api/events?id=' + encodeURIComponent(jobId));
  const ready = new Promise(resolve => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    source.addEventListener('open', settle);
    source.addEventListener('error', settle);
    setTimeout(settle, 500);
  });
  return { source, ready };
}

async function runEncrypt(scope) {
  if (busy) return;
  if (!currentGray) {
    setInsight('Upload an image to begin.');
    return;
  }
  busy = true;
  let key;
  let iv;
  try {
    ({ key, iv } = await ensureKeyIv());
  } catch (error) {
    busy = false;
    setInsight(error.message, true);
    return;
  }
  if (scope === 'cbc' && (lastResult?.plain !== currentGray || lastResult.key !== key)) scope = 'both';

  const jobId = 'job-' + ++jobCounter;
  resetPipeline();
  animatePipeDot();
  markNode('api');

  const { source: events, ready } = openEvents(jobId);
  let closing = false;
  // Let any frames already in flight land before the stream is torn down.
  const closeEvents = () => {
    if (closing) return;
    closing = true;
    setTimeout(() => events.close(), 400);
  };

  events.addEventListener('stage', event => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    appendLog(payload.message);
    const node = stageToNode[payload.stage];
    if (node) markNode(node);
    if (payload.stage === 'done') closeEvents();
  });

  await ready;

  try {
    const res = await fetch('/api/encrypt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId,
        key,
        iv,
        gray: bytesToBase64(currentGray),
        scope,
      }),
    });
    if (!res.ok) {
      let message = 'Encryption failed.';
      try {
        message = (await res.json()).error || message;
      } catch (error) {
        /* keep default message */
      }
      throw new Error(message);
    }
    handleResult(await res.json(), scope);
  } catch (error) {
    setInsight(error.message || 'Encryption failed.', true);
  } finally {
    closeEvents();
    busy = false;
  }
}

/* ------------------------------------------------------------------ */
/* API pill                                                            */
/* ------------------------------------------------------------------ */

async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error('unhealthy');
    apiStatus.textContent = 'LIVE';
    apiStatus.classList.remove('bad');
  } catch (error) {
    apiStatus.textContent = 'OFFLINE';
    apiStatus.classList.add('bad');
  }
}

/* ------------------------------------------------------------------ */
/* Loading screen                                                      */
/* ------------------------------------------------------------------ */

function startLoading() {
  const curtain = document.querySelector('.load-curtain');
  if (reduced) return;

  const shell = document.querySelector('.shell');
  const ink = $('proofInk').getContext('2d');
  const noise = $('proofNoise').getContext('2d');
  if (!ink || !noise) return;

  // Sample the same penguin used by the experiment. This is a print proof,
  // not an encryption request or a progress estimate for the health check.
  const source = makeSample('penguin');
  const stock = ['#141414', '#474747', '#918f87', '#d2cec4', '#efede6'];
  let seed = 101;
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      noise.fillStyle = stock[(seed >>> 16) % stock.length];
      noise.fillRect(x, y, 1, 1);
      const value = source[(4 * y + 2) * 256 + 4 * x + 2];
      ink.fillStyle = stock[Math.round(value * 4 / 255)];
      ink.fillRect(x, y, 1, 1);
    }
  }

  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  const finish = () => {
    listeners.abort();
    clearTimeout(fallback);
    curtain.hidden = true;
    shell.inert = false;
  };
  // Do not trap the visitor if CSS animations are suppressed or interrupted.
  const fallback = setTimeout(finish, 1800);
  $('skipProof').addEventListener('click', finish, options);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') finish();
  }, options);
  curtain.addEventListener('animationend', event => {
    if (event.animationName === 'lift-proof') finish();
  }, options);
  motionQuery?.addEventListener('change', event => {
    if (event.matches) finish();
  }, options);
  shell.inert = true;
  curtain.hidden = false;
}

/* ------------------------------------------------------------------ */
/* Present mode                                                        */
/* ------------------------------------------------------------------ */

function togglePresent() {
  const on = document.body.classList.toggle('present');
  if (!on) return;
  if (reduced) {
    presentCaption.style.opacity = '1';
    return;
  }
  anime.remove(presentCaption);
  anime({
    targets: presentCaption,
    opacity: [0, 1],
    duration: 300,
    easing: 'easeOutQuad',
  });
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

chooseBtn.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('click', event => {
  // The label opens the picker itself, and a programmatic input click bubbles
  // back here — either would otherwise re-enter this handler.
  if (event.target === fileInput || event.target.closest('label')) return;
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  handleFile(fileInput.files[0]);
  fileInput.value = '';
});

['dragover', 'dragenter'].forEach(name => {
  dropzone.addEventListener(name, event => {
    event.preventDefault();
    dropzone.classList.add('dragging');
  });
});
['dragleave', 'drop'].forEach(name => {
  dropzone.addEventListener(name, event => {
    event.preventDefault();
    dropzone.classList.remove('dragging');
  });
});
dropzone.addEventListener('drop', event => {
  handleFile(event.dataTransfer.files && event.dataTransfer.files[0]);
});
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => event.preventDefault());

document.querySelectorAll('#sampleRow button[data-sample]').forEach(button => {
  button.addEventListener('click', () => {
    submitPlate(makeSample(button.dataset.sample));
  });
});

[keyInput, ivInput].forEach(input => {
  input.addEventListener('input', () => {
    const value = input.value.trim();
    input.classList.toggle('invalid', value !== '' && !HEX32.test(value));
  });
});

randomKeyBtn.addEventListener('click', () => randomise('/api/new-key', keyInput, 'key'));
randomIvBtn.addEventListener('click', () => randomise('/api/new-iv', ivInput, 'IV'));

newIvBtn.addEventListener('click', async () => {
  if (busy) return;
  if (!currentGray) {
    setInsight('Upload an image to begin.');
    return;
  }
  try {
    const res = await fetch('/api/new-iv', { method: 'POST' });
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    ivInput.value = data.iv;
    ivInput.classList.remove('invalid');
    appendLog('new IV issued by server');
    await runEncrypt('cbc');
  } catch (error) {
    setInsight('Could not get a new IV from the server.', true);
  }
});

gridToggle.addEventListener('click', () => {
  gridOn = !gridOn;
  gridToggle.setAttribute('aria-pressed', String(gridOn));
  redrawCiphertexts();
});

presentBtn.addEventListener('click', togglePresent);

document.addEventListener('keydown', event => {
  if (event.key !== 'p' && event.key !== 'P') return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  togglePresent();
});

/* Boot */

startLoading();
checkHealth();
