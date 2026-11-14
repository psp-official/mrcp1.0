// ffmpeg / ffprobe helpers. Uses direct execFile calls (no wrapper library)
// so failures surface with the real ffmpeg stderr.
const { execFile } = require('child_process');
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
    '-y', '-i', input,
    '-vn', '-ac', '1', '-ar', '16000',
    '-c:a', 'libmp3lame', '-q:a', '4',
    output,
  ]);
}

/** Extract a single keyframe (JPEG) at `time` seconds. */
async function extractKeyframe(input, time, output) {
  await run('ffmpeg', [
    '-y', '-ss', String(time),
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
 */
async function burnSubtitles(input, assPath, output, fontsDir) {
  const filter = `subtitles='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(fontsDir)}'`;
  await run('ffmpeg', [
    '-y', '-i', input,
    '-vf', filter,
    '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    output,
  ]);
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
  ffmpegAvailable,
  probe,
  extractAudio,
  extractKeyframe,
  burnSubtitles,
  assembleChunks,
};
