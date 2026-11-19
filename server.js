'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const engine = require('./lib/engine');

try {
  engine.selfTest();
} catch (error) {
  console.error(error);
  process.exit(1);
}
console.log('engine ok: 69c4e0d86a7b0430d8cdb78070b4c55a');

const publicDir = path.join(__dirname, 'public');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };
const listeners = new Map();
const size = 65536;
const blocks = size / 16;

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function subscribe(req, res, id) {
  if (!id) return json(res, 400, { error: 'Expected job id.' });
  const group = listeners.get(id) || new Set();
  listeners.set(id, group);
  group.add(res);
  req.on('close', () => {
    group.delete(res);
    if (!group.size) listeners.delete(id);
  });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
}

function sendEvent(id, event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of listeners.get(id) || []) res.write(frame);
}

async function readBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 2 * 1024 * 1024) {
      req.resume();
      throw Object.assign(new Error('Request body too large.'), { status: 413 });
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

const base64 = bytes => Buffer.from(bytes).toString('base64');
const histogram = bytes => Array.from(engine.histogram(bytes));
function pack({ uniqueCipher, repeats, leakPct, dupMap }) {
  return { uniqueCipher, repeats, leakPct, dupMapBase64: base64(dupMap) };
}

async function encrypt(req, res) {
  const { jobId, key, iv, gray, scope } = await readBody(req) || {};
  const hex = value => typeof value === 'string' && /^[0-9a-fA-F]{32}$/.test(value);
  if (!hex(key) || !hex(iv)) return json(res, 400, { error: 'Key and IV must be 32 hex characters.' });
  const plain = typeof gray === 'string' && Buffer.from(gray, 'base64');
  if (plain.length !== size) return json(res, 400, { error: 'Expected 65536 grayscale bytes.' });
  if (scope !== 'both' && scope !== 'cbc') return json(res, 400, { error: 'Expected scope both or cbc.' });

  const stage = (name, message) => sendEvent(jobId, 'stage', { stage: name, message });
  const keyBytes = engine.hexToBytes(key), ivBytes = engine.hexToBytes(iv);
  const result = { scope };
  let elapsed = 0;
  let ecb;
  stage('received', 'image received');
  await delay(120);
  if (scope === 'both') {
    const start = performance.now();
    ecb = engine.encryptECB(plain, keyBytes).subarray(0, size);
    result.ecb = base64(ecb);
    elapsed += performance.now() - start;
    stage('ecb', 'ECB complete — 4096 blocks');
    await delay(120);
  }
  const start = performance.now();
  const cbc = engine.encryptCBC(plain, keyBytes, ivBytes).subarray(0, size);
  result.cbc = base64(cbc);
  elapsed += performance.now() - start;
  stage('cbc', 'CBC complete — chained');
  await delay(120);

  const analysisStart = performance.now();
  // The three-input analyzer needs two cipher views; on a CBC-only run
  // reuse CBC for the unused slot rather than generating an ECB stream.
  const analysis = engine.analyze(plain, ecb || cbc, cbc);
  const hists = { plain: histogram(plain), cbc: histogram(cbc) };
  result.stats = { totalBlocks: blocks, uniquePlain: analysis.uniquePlain, cbc: pack(analysis.cbc), hists };
  if (ecb) {
    result.stats.ecb = pack(analysis.ecb);
    hists.ecb = histogram(ecb);
  }
  elapsed += performance.now() - analysisStart;
  if (ecb) {
    stage('analysis', 'analysis complete');
    await delay(120);
  }
  result.meta = { blocks, durationMs: Math.round(elapsed), key, iv };
  stage('done', 'result returned');
  json(res, 200, result);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://server');
  if (url.pathname.startsWith('/api/')) {
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/health': return json(res, 200, { ok: true, engine: 'AES-128', uptime: process.uptime() });
      case 'GET /api/events': return subscribe(req, res, url.searchParams.get('id'));
      case 'POST /api/new-iv': return json(res, 200, { iv: engine.randomHex() });
      case 'POST /api/new-key': return json(res, 200, { key: engine.randomHex() });
      case 'POST /api/encrypt': return encrypt(req, res);
      default: return json(res, 404, { error: 'Endpoint not found.' });
    }
  }
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { return json(res, 400, { error: 'Invalid path.' }); }
  const file = path.resolve(publicDir, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(publicDir + path.sep) || file.includes('\0')) return json(res, 404, { error: 'File not found.' });
  try {
    const real = await fs.realpath(file);
    if (!real.startsWith(publicDir + path.sep)) return json(res, 404, { error: 'File not found.' });
    const data = await fs.readFile(real);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) throw error;
    json(res, 404, { error: 'File not found.' });
  }
}

const server = http.createServer((req, res) => route(req, res).catch(error => {
  if (!error.status) console.error(error);
  if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error.' });
  else res.destroy();
}));
server.listen(process.env.PORT || 8000, '0.0.0.0', () => {
  console.log(`listening on http://0.0.0.0:${server.address().port}`);
});
