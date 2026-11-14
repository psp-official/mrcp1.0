// OpenRouter client (OpenAI-compatible endpoint).
// Used to turn a raw transcript into a Burmese dialogue-style recap script.
// The API key is passed in per call and never stored or logged.
const { OPENROUTER_BASE, DEFAULT_OPENROUTER_MODELS } = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Extract the first JSON array from model text (models often add chatter). */
function extractJsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Model did not return a JSON array');
  }
  return JSON.parse(text.slice(start, end + 1));
}

function buildPrompt({ scenes, duration, language, style }) {
  const transcript = scenes
    .map(
      (s, i) =>
        `[${s.start.toFixed(1)}s–${s.end.toFixed(1)}s${s.speaker ? ` speaker ${s.speaker}` : ''}] ${s.text}`,
    )
    .join('\n');

  const styleNote =
    style === 'narration'
      ? 'Write it as one narrator telling the story (first-person-plural "we watch" recap style is fine).'
      : 'Write it as a mix of a dramatic narrator and short character dialogue lines, like a movie-recap channel: the narrator sets up each scene and the characters speak their key lines.';

  return [
    {
      role: 'system',
      content: `You write movie-recap scripts for short drama videos. The video is ${duration.toFixed(
        0,
      )} seconds long. The user gives you a timestamped transcript of the original audio. ${styleNote}
Rules:
- Write the recap in ${language} (Burmese by default). Keep the original character names if you can infer them; otherwise use descriptive names like "မိန်းကလေး" / "ယောက်ျား".
- Tone: dramatic, warm, affectionate, a little playful — like a recap channel the audience loves, not a dry summary.
- Cover the WHOLE video from start to end, in order. Every recap line must fall inside the video.
- Output ONLY a JSON array, no other text. Each item: {"start": <seconds>, "end": <seconds>, "speaker": "Narrator" or a character name, "text": "<one or two short sentences>"}.
- Lines should be 3–12 seconds long, back to back with no big gaps, and must not overlap each other.
- Do not invent plot points that are not in the transcript.`,
    },
    {
      role: 'user',
      content: `Transcript of the video:\n${transcript}\n\nWrite the ${language} recap script as a JSON array now.`,
    },
  ];
}

/** One chat-completions call against a single model. */
async function chatOnce(apiKey, model, messages) {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://recap.studio.local',
      'X-Title': 'Recap Studio',
    },
    signal: AbortSignal.timeout(180000), // LLM generation can be slow
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      max_tokens: 8192,
    }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message || JSON.stringify(body);
    } catch {
      detail = await res.text().catch(() => '');
    }
    const err = new Error(`OpenRouter ${model} failed (${res.status}): ${String(detail).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`OpenRouter ${model} returned no text`);
  return text;
}

/**
 * Generate the recap script. Tries the model list in order until one works
 * (free models rotate and sometimes rate-limit; 429/402/404 move to the next).
 * Returns validated lines: [{start, end, speaker, text}].
 */
async function generateRecap(apiKey, models, { scenes, duration, language = 'Burmese', style = 'dialogue' }) {
  const list = (models && models.length ? models : DEFAULT_OPENROUTER_MODELS).filter(Boolean);
  const messages = buildPrompt({ scenes, duration, language, style });
  let lastErr = null;

  for (const model of list) {
    try {
      const text = await chatOnce(apiKey, model, messages);
      const raw = extractJsonArray(text);
      const lines = validateLines(raw, duration);
      if (lines.length === 0) throw new Error('Model returned no usable lines');
      return { lines, model };
    } catch (e) {
      lastErr = e;
      // Rate limit / out of credits / model gone: try the next free model.
      if (e.status === 429 || e.status === 402 || e.status === 404) {
        await sleep(1500);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`All OpenRouter models failed. Last error: ${lastErr ? lastErr.message : 'unknown'}`);
}

/** Clean up model output: numbers, sorted, in-bounds, non-overlapping, non-empty. */
function validateLines(raw, duration) {
  const lines = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const start = Number(item.start);
    const end = Number(item.end);
    const text = String(item.text || '').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) continue;
    const s = Math.max(0, Math.min(duration, start));
    const e = Math.max(s + 0.5, Math.min(duration, end));
    if (e <= s) continue;
    lines.push({
      start: Math.round(s * 100) / 100,
      end: Math.round(e * 100) / 100,
      speaker: String(item.speaker || 'Narrator').slice(0, 40),
      text: text.slice(0, 300),
    });
  }
  lines.sort((a, b) => a.start - b.start);
  // Fix overlaps by trimming the earlier line.
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].start < lines[i - 1].end) {
      lines[i - 1].end = Math.max(lines[i - 1].start + 0.5, lines[i].start - 0.05);
    }
  }
  return lines;
}

/** Cheap key check: GET /key returns usage info for a valid key. */
async function testKey(apiKey) {
  try {
    const res = await fetch(`${OPENROUTER_BASE}/key`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(12000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Key မမှန်ပါ (401/403 Unauthorized)' };
    }
    if (!res.ok) return { ok: false, message: `OpenRouter error (${res.status})` };
    const body = await res.json();
    const label = body?.data?.label ? ` (${body.data.label})` : '';
    return { ok: true, message: `OpenRouter key အလုပ်လုပ်ပါတယ်${label}` };
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return { ok: false, message: 'OpenRouter ကို ဆက်သွယ်မရပါ (timeout) — internet / API status စစ်ပါ' };
    }
    return { ok: false, message: e.message };
  }
}

module.exports = { generateRecap, validateLines, testKey, DEFAULT_OPENROUTER_MODELS };
