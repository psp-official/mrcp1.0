// AssemblyAI client (REST, no SDK needed).
// Docs: https://www.assemblyai.com/docs
// The API key is passed in per call and never stored or logged.
const fs = require('fs');
const { ASSEMBLYAI_BASE } = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers(apiKey) {
  return { authorization: apiKey, 'content-type': 'application/json' };
}

async function assertOk(res, what) {
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.error || body.message || JSON.stringify(body);
    } catch {
      detail = await res.text().catch(() => '');
    }
    const err = new Error(`${what} failed (${res.status}): ${String(detail).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/** Upload the audio file, returns the AssemblyAI upload_url. */
async function uploadAudio(apiKey, filePath) {
  const data = await fs.promises.readFile(filePath);
  const res = await fetch(`${ASSEMBLYAI_BASE}/upload`, {
    method: 'POST',
    headers: { authorization: apiKey },
    body: data,
    duplex: 'half',
    signal: AbortSignal.timeout(120000), // big audio files take a while
  });
  await assertOk(res, 'AssemblyAI audio upload');
  const body = await res.json();
  if (!body.upload_url) throw new Error('AssemblyAI upload returned no URL');
  return body.upload_url;
}

/** Start a transcription job. Returns the transcript id. */
async function createTranscript(apiKey, uploadUrl) {
  const res = await fetch(`${ASSEMBLYAI_BASE}/transcript`, {
    method: 'POST',
    headers: headers(apiKey),
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      audio_url: uploadUrl,
      language_detection: true, // auto-detect (e.g. Chinese donghua audio)
      speaker_labels: true, // diarization: who is speaking
      word_timestamps: true, // word-level start/end for scene splitting
      punctuate: true,
    }),
  });
  await assertOk(res, 'AssemblyAI transcript request');
  const body = await res.json();
  if (!body.id) throw new Error('AssemblyAI transcript request returned no id');
  return body.id;
}

/**
 * Poll until the transcript is completed or errors.
 * Returns { words: [{text, start, end, speaker}], utterances, language }.
 * Times in the API are milliseconds — converted to seconds here.
 */
async function pollTranscript(apiKey, id, { intervalMs = 3000, timeoutMs = 45 * 60 * 1000, onStatus } = {}) {
  const started = Date.now();
  for (;;) {
    const res = await fetch(`${ASSEMBLYAI_BASE}/transcript/${id}`, {
      headers: headers(apiKey),
      signal: AbortSignal.timeout(20000),
    });
    await assertOk(res, 'AssemblyAI transcript poll');
    const body = await res.json();
    if (onStatus) onStatus(body.status);
    if (body.status === 'completed') {
      const words = (body.words || []).map((w) => ({
        text: w.text,
        start: w.start / 1000,
        end: w.end / 1000,
        speaker: w.speaker != null ? String(w.speaker) : null,
        confidence: w.confidence,
      }));
      return {
        words,
        utterances: body.utterances || [],
        language: body.language_code || null,
      };
    }
    if (body.status === 'error') {
      throw new Error(`AssemblyAI transcription failed: ${body.error || 'unknown error'}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error('AssemblyAI transcription timed out (45 min)');
    }
    await sleep(intervalMs);
  }
}

/** Cheap key check: list one transcript. Returns {ok, message}. */
async function testKey(apiKey) {
  try {
    const res = await fetch(`${ASSEMBLYAI_BASE}/transcript?limit=1`, {
      headers: headers(apiKey),
      signal: AbortSignal.timeout(12000),
    });
    if (res.status === 401) return { ok: false, message: 'Key မမှန်ပါ (401 Unauthorized)' };
    await assertOk(res, 'AssemblyAI key test');
    return { ok: true, message: 'AssemblyAI key အလုပ်လုပ်ပါတယ်' };
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return { ok: false, message: 'AssemblyAI ကို ဆက်သွယ်မရပါ (timeout) — internet / API status စစ်ပါ' };
    }
    return { ok: false, message: e.message };
  }
}

module.exports = { uploadAudio, createTranscript, pollTranscript, testKey };
