// Media helpers: a disk cache for photos/voice notes, and converting the browser's
// voice recordings into the format WhatsApp uses for voice messages.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const CACHE_DAYS = 60;
let cacheDir;

function init(dataDir) {
  cacheDir = path.join(dataDir, 'media');
  fs.mkdirSync(cacheDir, { recursive: true });
  // Forget media nobody has opened for a long time, so the disk doesn't fill up.
  const cutoff = Date.now() - CACHE_DAYS * 24 * 3600 * 1000;
  for (const f of fs.readdirSync(cacheDir)) {
    const p = path.join(cacheDir, f);
    try { if (fs.statSync(p).atimeMs < cutoff) fs.unlinkSync(p); } catch (_) {}
  }
}

const safeName = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_');

function cacheGet(id) {
  const base = path.join(cacheDir, safeName(id));
  try {
    const meta = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
    return { buffer: fs.readFileSync(base + '.bin'), mime: meta.mime };
  } catch (_) {
    return null;
  }
}

function cachePut(id, buffer, mime) {
  const base = path.join(cacheDir, safeName(id));
  fs.writeFileSync(base + '.bin', buffer);
  fs.writeFileSync(base + '.json', JSON.stringify({ mime }));
}

function run(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
    p.stdin.on('error', () => {}); // ffmpeg may close stdin early on bad input
    p.stdin.end(input);
  });
}

// Browser recording (webm/opus or similar) -> WhatsApp voice note (ogg/opus, mono, 48kHz),
// plus the 64-bar waveform WhatsApp draws for voice messages.
async function convertVoice(input) {
  const ogg = await run(['-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg', 'pipe:1'], input);
  let waveform;
  try {
    const pcm = await run(['-i', 'pipe:0', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], ogg);
    waveform = computeWaveform(pcm);
  } catch (_) { /* waveform is optional */ }
  return { ogg, waveform };
}

function computeWaveform(pcm, bars = 64) {
  const samples = Math.floor(pcm.length / 2);
  if (!samples) return undefined;
  const per = Math.max(1, Math.floor(samples / bars));
  const levels = [];
  for (let b = 0; b < bars; b++) {
    let sum = 0;
    const start = b * per;
    const end = Math.min(samples, start + per);
    for (let i = start; i < end; i++) sum += Math.abs(pcm.readInt16LE(i * 2));
    levels.push(end > start ? sum / (end - start) : 0);
  }
  const max = Math.max(...levels) || 1;
  return new Uint8Array(levels.map((v) => Math.round((v / max) * 100)));
}

module.exports = { init, cacheGet, cachePut, convertVoice };
