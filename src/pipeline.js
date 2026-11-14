// The recap pipeline: probe -> audio -> transcribe -> segment -> script
// -> keyframes -> subtitles -> done. Each job runs through these steps
// in order, updating job.progress so the frontend can show a progress bar.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const media = require('./media');
const subs = require('./subtitles');
const assemblyai = require('./assemblyai');
const openrouter = require('./openrouter');
const mock = require('./mock');
const store = require('./store');

const STEP_PROGRESS = {
  probe: 5,
  audio: 15,
  transcribe: 45,
  segment: 55,
  script: 70,
  keyframes: 80,
  subtitles: 95,
  done: 100,
};

/**
 * Run a full recap job. `job.options` holds:
 * { assemblyaiKey, openrouterKey, models, language, style }
 * Keys live only in memory for the duration of this job.
 */
async function runJob(job) {
  const { log, setStep } = store;
  const opts = job.options;
  const dir = job.dir;
  const input = path.join(dir, 'input.mp4');
  const audio = path.join(dir, 'audio.mp3');
  const assPath = path.join(dir, 'recap.ass');
  const srtPath = path.join(dir, 'recap.srt');
  const scriptPath = path.join(dir, 'recap.txt');
  const output = path.join(dir, 'recap.mp4');

  // 1. Probe -------------------------------------------------------------
  setStep(job, 'probe', STEP_PROGRESS.probe);
  const info = await media.probe(input);
  if (!info.duration || info.duration <= 0) throw new Error('Video duration ကို ဖတ်လို့မရပါ');
  log(job, `Video: ${info.width}x${info.height}, ${info.duration.toFixed(1)}s`);
  if (!info.hasAudio) throw new Error('Video ထဲမှာ အသံမပါပါ — အသံပါတဲ့ video သုံးပါ');

  // 2. Extract audio -----------------------------------------------------
  setStep(job, 'audio', STEP_PROGRESS.audio);
  log(job, 'အသံထုတ်ယူနေတယ်…');
  await media.extractAudio(input, audio);

  // 3. Transcribe --------------------------------------------------------
  setStep(job, 'transcribe', STEP_PROGRESS.transcribe);
  let transcript;
  if (config.MOCK) {
    log(job, '[MOCK] Transcript အတုသုံးနေတယ် (RECAP_MOCK=1)');
    await new Promise((r) => setTimeout(r, 500));
    transcript = mock.mockTranscript(info.duration);
  } else {
    if (!opts.assemblyaiKey) throw new Error('AssemblyAI API key မထည့်ရသေးပါ');
    log(job, 'AssemblyAI ကို အသံတင်နေတယ်…');
    const uploadUrl = await assemblyai.uploadAudio(opts.assemblyaiKey, audio);
    log(job, 'Transcribe လုပ်နေတယ်… (မိနစ်အနည်းငယ်ကြာနိုင်တယ်)');
    const transcriptId = await assemblyai.createTranscript(opts.assemblyaiKey, uploadUrl);
    transcript = await assemblyai.pollTranscript(opts.assemblyaiKey, transcriptId, {
      onStatus: (s) => log(job, `Transcription status: ${s}`),
    });
  }
  log(job, `Transcript ရပြီ: ${transcript.words.length} words, language=${transcript.language || 'auto'}`);
  if (transcript.words.length === 0) throw new Error('Transcript မှာ စကားလုံးမတွေ့ပါ — အသံတိတ်နေတဲ့ video ဖြစ်နိုင်တယ်');

  // 4. Segment into scenes ----------------------------------------------
  setStep(job, 'segment', STEP_PROGRESS.segment);
  const scenes = subs.segmentTranscript(transcript.words);
  log(job, `Scene ${scenes.length} ခု ခွဲပြီးပြီ`);

  // 5. Generate Burmese recap script -------------------------------------
  setStep(job, 'script', STEP_PROGRESS.script);
  let recap;
  if (config.MOCK) {
    log(job, '[MOCK] Recap script အတုသုံးနေတယ် (RECAP_MOCK=1)');
    recap = { lines: mock.mockRecap(scenes, info.duration), model: 'mock' };
  } else {
    if (!opts.openrouterKey) throw new Error('OpenRouter API key မထည့်ရသေးပါ');
    log(job, 'Recap script ရေးနေတယ်…');
    recap = await openrouter.generateRecap(opts.openrouterKey, opts.models, {
      scenes,
      duration: info.duration,
      language: opts.language || 'Burmese',
      style: opts.style || 'dialogue',
    });
    log(job, `Script ရပြီ (${recap.model}, ${recap.lines.length} lines)`);
  }
  const lines = recap.lines;

  // 6. Keyframes (one per scene) -----------------------------------------
  setStep(job, 'keyframes', STEP_PROGRESS.keyframes);
  const keyframes = [];
  for (let i = 0; i < scenes.length; i++) {
    const t = Math.min(info.duration - 0.1, Math.max(0.1, (scenes[i].start + scenes[i].end) / 2));
    const frame = path.join(dir, `frame-${i}.jpg`);
    try {
      await media.extractKeyframe(input, t, frame);
      keyframes.push({ index: i, start: scenes[i].start, end: scenes[i].end, file: `frame-${i}.jpg` });
    } catch (e) {
      log(job, `Keyframe ${i} ထုတ်မရပါ: ${e.message}`);
    }
  }

  // 7. Build subtitles + burn them in ------------------------------------
  setStep(job, 'subtitles', STEP_PROGRESS.subtitles);
  fs.writeFileSync(srtPath, subs.buildSrt(lines), 'utf8');
  fs.writeFileSync(assPath, subs.buildAss(lines, { width: info.width, height: info.height }), 'utf8');
  fs.writeFileSync(scriptPath, subs.buildScriptTxt(lines), 'utf8');
  log(job, 'စာတန်းထိုးကို video ထဲ ထည့်နေတယ်…');
  await media.burnSubtitles(input, assPath, output, config.FONT_DIR);
  const outInfo = await media.probe(output);
  if (!outInfo.duration) throw new Error('Output video ထုတ်မရပါ');

  // 8. Done --------------------------------------------------------------
  setStep(job, 'done', STEP_PROGRESS.done);
  job.result = {
    video: 'recap.mp4',
    srt: 'recap.srt',
    script: 'recap.txt',
    keyframes,
    duration: info.duration,
    width: info.width,
    height: info.height,
    lines,
    model: recap.model,
  };
  // Keys must not linger in memory longer than needed.
  job.options = { ...job.options, assemblyaiKey: undefined, openrouterKey: undefined };
  log(job, 'ပြီးပြီ! Recap video အဆင်သင့်ဖြစ်ပြီ');
}

/**
 * Re-render subtitles from edited lines (user edited the script in the UI).
 * Reuses the original input video; replaces output files in place.
 */
async function rerenderJob(job, lines) {
  const { log, setStep } = store;
  const dir = job.dir;
  const input = path.join(dir, 'input.mp4');
  const assPath = path.join(dir, 'recap.ass');
  const srtPath = path.join(dir, 'recap.srt');
  const scriptPath = path.join(dir, 'recap.txt');
  const output = path.join(dir, 'recap.mp4');
  const tmpOutput = path.join(dir, 'recap.tmp.mp4');

  const info = await media.probe(input);
  const clean = openrouter.validateLines(lines, info.duration);
  if (clean.length === 0) throw new Error('စာတန်းထိုးလိုင်းတွေ မမှန်ပါ');

  setStep(job, 'subtitles', 50);
  log(job, 'ပြင်ထားတဲ့ script နဲ့ စာတန်းထိုး ပြန်ထည့်နေတယ်…');
  fs.writeFileSync(srtPath, subs.buildSrt(clean), 'utf8');
  fs.writeFileSync(assPath, subs.buildAss(clean, { width: info.width, height: info.height }), 'utf8');
  fs.writeFileSync(scriptPath, subs.buildScriptTxt(clean), 'utf8');
  await media.burnSubtitles(input, assPath, tmpOutput, config.FONT_DIR);
  fs.renameSync(tmpOutput, output);
  job.result.lines = clean;
  job.result.srt = 'recap.srt';
  job.result.script = 'recap.txt';
  job.result.video = 'recap.mp4';
  job.updatedAt = Date.now();
  log(job, 'စာတန်းထိုး ပြန်ထည့်ပြီးပြီ');
  setStep(job, 'done', 100);
}

module.exports = { runJob, rerenderJob };
