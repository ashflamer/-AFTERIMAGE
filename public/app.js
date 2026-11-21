'use strict';

/*
 * PIXEL CIPHER LAB — browser client.
 *
 * No encryption happens here. The browser decodes an image to 65536
 * grayscale bytes, posts them to the server, and renders what comes back.
 * All motion is anime.js (public/vendor/anime.min.js).
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
    currentGray = imageToGray(img);
    renderGray(canvasOriginal, currentGray, SIZE);
    await runEncrypt('both');
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
      ctx.fillRect(col * 16, row * 16, 16, 16);
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

function sweepScan(panel) {
  const scan = panel.querySelector('.scan');
  if (!scan || reduced) return;
  anime.remove(scan);
  scan.style.opacity = '1';
  anime({
    targets: scan,
    translateY: ['-8%', '108%'],
    duration: 720,
    easing: 'easeInOutQuad',
    complete: () => {
      scan.style.opacity = '0';
    },
  });
}

/* ------------------------------------------------------------------ */
/* Reveal + New IV badge/pulse                                         */
/* ------------------------------------------------------------------ */

function reveal() {
  const panels = [panelOriginal, panelECB, panelCBC];
  if (reduced) {
    panels.forEach(panel => {
      panel.style.opacity = '1';
      panel.style.transform = 'none';
      panel.style.outline = 'none';
    });
    [canvasOriginal, canvasECB, canvasCBC].forEach(canvas => {
      canvas.style.filter = 'none';
      canvas.style.transform = 'none';
    });
    return;
  }
  panels.forEach(panel => {
    anime.remove(panel);
    panel.style.outline = '1px solid rgba(196,71,31,0)';
  });
  anime({
    targets: panels,
    translateY: [18, 0],
    opacity: [0, 1],
    duration: 600,
    easing: 'easeOutExpo',
    delay: anime.stagger(80),
  });
  // Edge pulse instead of a CSS keyframe flash — all motion stays in anime.js.
  anime({
    targets: panels,
    outlineColor: ['rgba(196,71,31,0.9)', 'rgba(196,71,31,0)'],
    duration: 700,
    easing: 'easeOutQuad',
    delay: anime.stagger(80),
  });
  [canvasOriginal, canvasECB].forEach(canvas => {
    anime.remove(canvas);
    anime({
      targets: canvas,
      filter: ['blur(5px)', 'blur(0px)'],
      scale: [1.02, 1],
      duration: 650,
      easing: 'easeOutExpo',
    });
  });
  anime.remove(canvasCBC);
  anime({
    targets: canvasCBC,
    filter: ['blur(5px)', 'blur(0px)'],
    scale: [1.02, 1],
    duration: 650,
    easing: 'easeOutExpo',
    delay: 120,
  });
}

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
  anime.remove(canvasCBC);
  anime({
    targets: canvasCBC,
    scale: [1, 1.04],
    duration: 220,
    easing: 'easeOutQuad',
    complete: () => {
      anime({
        targets: canvasCBC,
        scale: [1.04, 1],
        duration: 280,
        easing: 'easeInOutQuad',
      });
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

function handleResult(data, scope) {
  const stats = data.stats;
  lastResult = {
    ecbBytes: data.ecb ? base64ToBytes(data.ecb) : null,
    cbcBytes: base64ToBytes(data.cbc),
    ecbDup: stats.ecb ? base64ToBytes(stats.ecb.dupMapBase64) : null,
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
    reveal();
  } else {
    // scope 'cbc' — the New IV proof. Never touch #canvasECB.
    renderGray(canvasCBC, lastResult.cbcBytes, SIZE);
    if (gridOn) drawOverlay(canvasCBC, lastResult.cbcDup);
    setGauge(leakCbcRing, leakCbcNum, stats.cbc.leakPct);
    drawHistogram(stats.hists);
    setInsight('New IV, same image: ECB is identical every time. CBC is different every time.');
    showBadgeAndPulse();
  }

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
  let key;
  let iv;
  try {
    ({ key, iv } = await ensureKeyIv());
  } catch (error) {
    setInsight(error.message, true);
    return;
  }

  busy = true;
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
    if (payload.stage === 'ecb') sweepScan(panelECB);
    if (payload.stage === 'cbc') sweepScan(panelCBC);
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
  const num = document.querySelector('.load-num');
  const step = document.querySelector('.load-step');
  const enters = document.querySelectorAll('[data-enter]');
  const steps = ['STARTING ENGINE', 'BOOTING AES-128', 'CHECKING API', 'READY'];
  const at = [0, 350, 700, 1050];

  if (reduced) {
    step.textContent = 'READY';
    num.textContent = '100';
    enters.forEach(el => {
      el.style.opacity = '1';
      el.style.transform = 'none';
    });
    curtain.style.display = 'none';
    return;
  }

  enters.forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(18px)';
  });
  steps.forEach((text, i) => {
    setTimeout(() => {
      step.textContent = text;
    }, at[i]);
  });

  const tl = anime.timeline({
    easing: 'easeOutExpo',
    complete: () => {
      curtain.style.display = 'none';
    },
  });
  tl.add({ targets: '.load-rule', scaleX: [0, 1], duration: 1100 })
    .add(
      {
        targets: '.load-num',
        innerHTML: [0, 100],
        round: 1,
        duration: 1100,
        easing: 'linear',
        update: () => {
          const el = document.querySelector('.load-num');
          if (el) el.textContent = String(Math.round(parseFloat(el.textContent) || 0)).padStart(3, '0');
        },
      },
      0
    )
    .add(
      {
        targets: '.load-curtain',
        translateY: ['0%', '-100%'],
        duration: 750,
        easing: 'easeInOutQuart',
      },
      '+=180'
    )
    .add(
      {
        targets: '[data-enter]',
        translateY: [18, 0],
        opacity: [0, 1],
        delay: anime.stagger(70),
        duration: 650,
      },
      '-=420'
    )
    .add({ targets: '.load-curtain', display: 'none', duration: 1 });
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
    currentGray = makeSample(button.dataset.sample);
    renderGray(canvasOriginal, currentGray, SIZE);
    runEncrypt('both');
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
