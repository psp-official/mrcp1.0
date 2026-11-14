// ffmpeg / ffprobe helpers. Uses direct execFile calls (no wrapper library)
// so failures surface with the real ffmpeg stderr.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`${cmd} failed: ${(stderr || err.message).slice(-1500)}`);
        e.code = err.code;
        e.stderr = stderr;
        reject(e);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/** Parse ffmpeg progress time (HH:MM:SS.xx) into seconds. */
function parseFfmpegTime(text) {
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Run a long ffmpeg job with live progress.
 * - stdin is ignored so ffmpeg can never block waiting for terminal input.
 * - stderr is consumed and parsed for time= progress; onProgress(seconds)
 *   is called (throttled to ~1/sec) with the encoded position.
 * - timeoutMs kills the process with a clear error instead of hanging forever.
 *   Without this, a slow/stuck encode on a small server looks frozen at 95%.
 */
function runStreaming(cmd, args, { onProgress, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let lastProgressAt = 0;
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs)
      : null;
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
      const t = parseFfmpegTime(text);
      if (t != null && onProgress) {
        const now = Date.now();
        if (now - lastProgressAt > 1000) {
          lastProgressAt = now;
          onProgress(t);
        }
      }
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `${cmd} timed out after ${Math.round(timeoutMs / 60000)} min — video က အရမ်းရှည်နေလို့ ဒီ server plan နဲ့ မနိုင်တာဖြစ်နိုင်တယ်`
          )
        );
      } else if (code !== 0) {
        reject(new Error(`${cmd} failed (code ${code}): ${stderr.slice(-1500)}`));
      } else {
        resolve({ stderr });
      }
    });
  });
}

async function ffmpegAvailable() {
  try {
    await run('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

/** Probe a video file: duration (s), width, height, whether it has audio. */
async function probe(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type,width,height',
    '-of', 'json',
    file,
  ]);
  const data = JSON.parse(stdout);
  const video = (data.streams || []).find((s) => s.codec_type === 'video') || {};
  const audio = (data.streams || []).find((s) => s.codec_type === 'audio');
  return {
    duration: parseFloat(data.format.duration) || 0,
    width: video.width || 0,
    height: video.height || 0,
    hasAudio: Boolean(audio),
  };
}

/** Extract audio as 16 kHz mono MP3 (small, ideal for transcription). */
async function extractAudio(input, output) {
  await run('ffmpeg', [
    '-nostdin', '-y', '-i', input,
    '-vn', '-ac', '1', '-ar', '16000',
    '-c:a', 'libmp3lame', '-q:a', '4',
    output,
  ]);
}

/** Extract a single keyframe (JPEG) at `time` seconds. */
async function extractKeyframe(input, time, output) {
  await run('ffmpeg', [
    '-nostdin', '-y', '-ss', String(time),
    '-i', input,
    '-frames:v', '1', '-q:v', '4',
    output,
  ]);
}

// Escape a path for use inside an ffmpeg filter argument (subtitles filter).
// Colons and quotes must be backslash-escaped, backslashes doubled.
function escapeFilterPath(p) {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/**
 * Burn an .ass subtitle file onto the video.
 * Re-encodes video (libx264) and audio (AAC) so the result plays anywhere.
 * Uses the streaming runner so the caller gets live progress, and
 * `ultrafast` preset: on Render's starter plan (0.5 CPU) a 3-min 1080p
 * re-encode at `veryfast` takes 6-12 min and looks frozen at 95% —
 * ultrafast is roughly 2x faster for a slightly larger file.
 */
async function burnSubtitles(input, assPath, output, fontsDir, { onProgress, timeoutMs } = {}) {
  const filter = `subtitles='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(fontsDir)}'`;
  await runStreaming(
    'ffmpeg',
    [
      '-nostdin', '-y', '-i', input,
      '-vf', filter,
      '-c:v', 'libx264', '-crf', '20', '-preset', 'ultrafast',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      output,
    ],
    { onProgress, timeoutMs }
  );
}

/** Concatenate chunk files (in order) into one file, then delete the chunks. */
async function assembleChunks(chunkFiles, output) {
  const out = fs.createWriteStream(output);
  try {
    for (const chunk of chunkFiles) {
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(chunk);
        rs.on('error', reject);
        rs.on('end', resolve);
        rs.pipe(out, { end: false });
      });
    }
  } finally {
    out.end();
  }
  await new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  for (const chunk of chunkFiles) {
    fs.unlink(chunk, () => {});
  }
}

module.exports = {
  run,
  runStreaming,
  ffmpegAvailable,
  probe,
  extractAudio,
  extractKeyframe,
  burnSubtitles,
  assembleChunks,
};
