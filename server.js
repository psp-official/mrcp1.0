// Recap Studio — backend.
// Upload a video -> AssemblyAI transcription -> OpenRouter Burmese recap
// script -> ffmpeg subtitle burn-in -> downloadable recap video.
//
// API keys are sent by the browser per job and live only in memory while
// that job runs. They are never written to disk and never logged.
// Optional server-side fallback keys can be set via env (see .env.example).
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./src/config');
const media = require('./src/media');
const store = require('./src/store');
const pipeline = require('./src/pipeline');
const assemblyai = require('./src/assemblyai');
const openrouter = require('./src/openrouter');

const app = express();
const PORT = process.env.PORT || 3000;

store.setRunner(pipeline.runJob);

const uploadsDir = path.join(config.WORK_DIR, 'uploads');
const jobsBase = path.join(config.WORK_DIR, 'jobs');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(jobsBase, { recursive: true });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------- health
app.get('/api/health', async (req, res) => {
  const ffmpeg = await media.ffmpegAvailable();
  res.json({
    ok: true,
    ffmpeg,
    mock: config.MOCK,
    maxVideoMB: config.MAX_VIDEO_BYTES / (1024 * 1024),
    chunkMB: config.CHUNK_SIZE / (1024 * 1024),
    serverKeys: {
      assemblyai: Boolean(process.env.ASSEMBLYAI_API_KEY),
      openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    },
  });
});

// ------------------------------------------------------- chunked upload
// POST /api/upload/init { fileName, fileSize } -> { uploadId, chunkSize }
// POST /api/upload/chunk?uploadId=...&index=... (raw binary body, 8 MB)
// POST /api/upload/complete { uploadId, ...jobOptions } -> { jobId }
app.post('/api/upload/init', (req, res) => {
  const { fileName, fileSize } = req.body || {};
  if (!fileName || typeof fileName !== 'string') {
    return res.status(400).json({ error: 'fileName လိုပါတယ်' });
  }
  const size = Number(fileSize);
  if (!Number.isFinite(size) || size <= 0) {
    return res.status(400).json({ error: 'fileSize မမှန်ပါ' });
  }
  if (size > config.MAX_VIDEO_BYTES) {
    return res.status(413).json({ error: `Video ကြီးလွန်းပါတယ် (အများဆုံး ${config.MAX_VIDEO_BYTES / 1024 / 1024} MB)` });
  }
  const ext = path.extname(fileName).toLowerCase();
  if (!config.ALLOWED_EXTS.includes(ext)) {
    return res.status(400).json({ error: `Video format မထောက်ပံ့ပါ: ${ext} (${config.ALLOWED_EXTS.join(', ')})` });
  }
  const uploadId = crypto.randomBytes(8).toString('hex');
  const dir = path.join(uploadsDir, uploadId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ fileName, fileSize: size, ext, createdAt: Date.now() }));
  res.json({ uploadId, chunkSize: config.CHUNK_SIZE, totalChunks: Math.ceil(size / config.CHUNK_SIZE) });
});

app.post('/api/upload/chunk', (req, res) => {
  const { uploadId, index } = req.query;
  const idx = Number(index);
  if (!uploadId || !/^[0-9a-f]+$/.test(uploadId) || !Number.isInteger(idx) || idx < 0) {
    return res.status(400).json({ error: 'uploadId / index မမှန်ပါ' });
  }
  const dir = path.join(uploadsDir, uploadId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Upload session မတွေ့ပါ' });
  const dest = path.join(dir, `chunk-${idx}`);
  const ws = fs.createWriteStream(dest);
  let bytes = 0;
  req.on('data', (c) => { bytes += c.length; });
  req.on('error', () => res.status(500).json({ error: 'Chunk လက်ခံရာမှာ error' }));
  ws.on('error', () => res.status(500).json({ error: 'Chunk သိမ်းရာမှာ error' }));
  ws.on('finish', () => res.json({ ok: true, index: idx, bytes }));
  req.pipe(ws);
});

app.post('/api/upload/complete', async (req, res) => {
  const { uploadId, assemblyaiKey, openrouterKey, models, language, style } = req.body || {};
  if (!uploadId || !/^[0-9a-f]+$/.test(uploadId)) {
    return res.status(400).json({ error: 'uploadId မမှန်ပါ' });
  }
  const dir = path.join(uploadsDir, uploadId);
  const metaPath = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'Upload session မတွေ့ပါ' });
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const totalChunks = Math.ceil(meta.fileSize / config.CHUNK_SIZE);
  const chunkFiles = [];
  for (let i = 0; i < totalChunks; i++) {
    const f = path.join(dir, `chunk-${i}`);
    if (!fs.existsSync(f)) {
      return res.status(400).json({ error: `Chunk ${i} ပျောက်နေပါတယ် — upload ပြန်လုပ်ပါ` });
    }
    chunkFiles.push(f);
  }

  // Keys: client-supplied first, server env as fallback. Never persisted.
  const finalAssemblyKey = (assemblyaiKey || '').trim() || process.env.ASSEMBLYAI_API_KEY || '';
  const finalOpenKey = (openrouterKey || '').trim() || process.env.OPENROUTER_API_KEY || '';
  const modelList = Array.isArray(models) && models.length
    ? models.map((m) => String(m).trim()).filter(Boolean)
    : (process.env.OPENROUTER_MODEL ? [process.env.OPENROUTER_MODEL] : config.DEFAULT_OPENROUTER_MODELS);

  const job = store.createJob({
    fileName: meta.fileName,
    fileSize: meta.fileSize,
    options: {
      assemblyaiKey: finalAssemblyKey,
      openrouterKey: finalOpenKey,
      models: modelList,
      language: language || 'Burmese',
      style: style || 'dialogue',
    },
  });

  try {
    await media.assembleChunks(chunkFiles, path.join(job.dir, 'input.mp4'));
    const assembled = fs.statSync(path.join(job.dir, 'input.mp4')).size;
    if (assembled !== meta.fileSize) {
      throw new Error(`Upload မပြည့်စုံပါ (ရ ${assembled} / မျှော် ${meta.fileSize} bytes)`);
    }
  } catch (e) {
    fs.rm(job.dir, { recursive: true, force: true }, () => {});
    store.jobs.delete(job.id);
    return res.status(500).json({ error: e.message });
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }

  store.enqueue(job);
  res.json({ jobId: job.id });
});

// ----------------------------------------------------------------- jobs
app.get('/api/jobs/:id', (req, res) => {
  const job = store.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job မတွေ့ပါ' });
  res.json(store.publicJob(job));
});

app.get('/api/jobs/:id/download/:type', (req, res) => {
  const job = store.getJob(req.params.id);
  if (!job || !job.result) return res.status(404).json({ error: 'Result မရှိသေးပါ' });
  const { type } = req.params;
  const map = {
    video: { file: 'recap.mp4', name: `${path.parse(job.fileName).name}-recap.mp4`, mime: 'video/mp4' },
    srt: { file: 'recap.srt', name: `${path.parse(job.fileName).name}-recap.srt`, mime: 'text/plain' },
    script: { file: 'recap.txt', name: `${path.parse(job.fileName).name}-recap-script.txt`, mime: 'text/plain' },
  };
  if (type === 'keyframe') {
    const n = Number(req.query.n);
    const kf = job.result.keyframes && job.result.keyframes[n];
    if (!kf) return res.status(404).json({ error: 'Keyframe မတွေ့ပါ' });
    const file = path.join(job.dir, kf.file);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Keyframe file ပျောက်နေပါတယ်' });
    return res.sendFile(file);
  }
  const entry = map[type];
  if (!entry) return res.status(400).json({ error: `Download type မမှန်ပါ: ${type}` });
  const file = path.join(job.dir, entry.file);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'File ပျောက်နေပါတယ်' });
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(entry.name)}"`);
  res.type(entry.mime);
  res.sendFile(file);
});

// Re-render subtitles from user-edited script lines.
app.post('/api/jobs/:id/rerender', async (req, res) => {
  const job = store.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job မတွေ့ပါ' });
  if (job.status !== 'done') return res.status(400).json({ error: 'Job မပြီးသေးပါ' });
  const { lines } = req.body || {};
  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'lines array လိုပါတယ်' });
  }
  job.status = 'running';
  try {
    await pipeline.rerenderJob(job, lines);
    job.status = 'done';
    res.json(store.publicJob(job));
  } catch (e) {
    job.status = 'done'; // original output is still usable
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------------ key test
// Tests keys without storing them. Body: { assemblyaiKey?, openrouterKey? }
app.post('/api/keys/test', async (req, res) => {
  const { assemblyaiKey, openrouterKey } = req.body || {};
  const out = {};
  // Run both checks in parallel so a slow API doesn't double the wait.
  const [aai, or] = await Promise.all([
    assemblyaiKey ? assemblyai.testKey(String(assemblyaiKey).trim()) : null,
    openrouterKey ? openrouter.testKey(String(openrouterKey).trim()) : null,
  ]);
  if (aai) out.assemblyai = aai;
  if (or) out.openrouter = or;
  if (Object.keys(out).length === 0) {
    return res.status(400).json({ error: 'စမ်းမယ့် key တစ်ခုခု ထည့်ပါ' });
  }
  res.json(out);
});

// ------------------------------------------------------------------ 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Never log request bodies — they may contain API keys.
  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Server error: ' + err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Recap Studio listening on http://0.0.0.0:${PORT} (mock=${config.MOCK})`);
});
