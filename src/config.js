// Shared configuration. No secrets are ever stored here — API keys come
// from the client per job (or optional server env fallbacks, see .env.example).
const path = require('path');

const WORK_DIR = process.env.WORK_DIR
  ? path.resolve(process.env.WORK_DIR)
  : path.join(__dirname, '..', 'data');

const FONT_DIR = process.env.FONT_DIR || '/usr/share/fonts/truetype/noto';

// Chunked upload: 8 MB chunks reassembled server-side (Render's proxy caps
// a single request around 100 MB, so chunking is what lets big videos through).
const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024; // 500 MB
const ALLOWED_EXTS = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'];

// Completed jobs are kept for download for 1 hour, then cleaned up.
const JOB_TTL_MS = 60 * 60 * 1000;

// OpenRouter free models. The free lineup rotates on OpenRouter's side, so
// the first entry is the "openrouter/free" router (it picks a free model for
// you) and the rest are named fallbacks. Users can edit this list in Settings.
const DEFAULT_OPENROUTER_MODELS = [
  'openrouter/free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super:free',
  'openai/gpt-oss-20b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
];

const ASSEMBLYAI_BASE = 'https://api.assemblyai.com/v2';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

module.exports = {
  WORK_DIR,
  FONT_DIR,
  CHUNK_SIZE,
  MAX_VIDEO_BYTES,
  ALLOWED_EXTS,
  JOB_TTL_MS,
  DEFAULT_OPENROUTER_MODELS,
  ASSEMBLYAI_BASE,
  OPENROUTER_BASE,
  MOCK: process.env.RECAP_MOCK === '1',
};
