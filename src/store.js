// In-memory job store + a simple one-at-a-time queue.
// One job at a time is fine for a personal Render instance: transcription
// and subtitle burning are CPU/IO heavy and Render's smallest instances
// have limited cores. Jobs keep their files for JOB_TTL_MS after finishing.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WORK_DIR, JOB_TTL_MS } = require('./config');

const jobs = new Map(); // id -> job object
const queue = []; // job ids waiting to run
let running = false;
let runner = null; // injected by pipeline.js: async (job) => void

function jobDir(id) {
  return path.join(WORK_DIR, 'jobs', id);
}

function createJob({ fileName, fileSize, options }) {
  const id = crypto.randomBytes(8).toString('hex');
  const dir = jobDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const job = {
    id,
    dir,
    fileName,
    fileSize,
    options,
    status: 'queued', // queued | running | done | error
    step: 'queued',
    progress: 0,
    logs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: null, // {video, srt, script, keyframes[], duration, lines}
    error: null,
    cleanupAt: null,
  };
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function log(job, msg) {
  const line = `[${new Date().toLocaleTimeString('en-GB')}] ${msg}`;
  job.logs.push(line);
  if (job.logs.length > 200) job.logs = job.logs.slice(-200);
  job.updatedAt = Date.now();
}

function setStep(job, step, progress) {
  job.step = step;
  if (typeof progress === 'number') job.progress = progress;
  job.updatedAt = Date.now();
}

function setRunner(fn) {
  runner = fn;
}

/** Enqueue a job; the queue runs one job at a time. */
function enqueue(job) {
  queue.push(job.id);
  drain();
}

async function drain() {
  if (running || !runner) return;
  const id = queue.shift();
  if (!id) return;
  const job = jobs.get(id);
  if (!job) return drain();
  running = true;
  job.status = 'running';
  setStep(job, job.step === 'queued' ? 'probe' : job.step, job.progress);
  try {
    await runner(job);
    job.status = 'done';
    job.progress = 100;
    job.cleanupAt = Date.now() + JOB_TTL_MS;
    scheduleCleanup(job);
  } catch (e) {
    job.status = 'error';
    job.error = e.message || String(e);
    log(job, `ERROR: ${job.error}`);
    job.cleanupAt = Date.now() + JOB_TTL_MS;
    scheduleCleanup(job);
  } finally {
    running = false;
    drain();
  }
}

function scheduleCleanup(job) {
  const delay = Math.max(1000, (job.cleanupAt || Date.now() + JOB_TTL_MS) - Date.now());
  setTimeout(() => {
    fs.rm(job.dir, { recursive: true, force: true }, () => {});
    jobs.delete(job.id);
  }, delay).unref();
}

/** Public view of a job (never includes API keys). */
function publicJob(job) {
  return {
    id: job.id,
    fileName: job.fileName,
    fileSize: job.fileSize,
    status: job.status,
    step: job.step,
    progress: job.progress,
    logs: job.logs,
    error: job.error,
    createdAt: job.createdAt,
    result: job.result,
  };
}

module.exports = { jobs, createJob, getJob, log, setStep, setRunner, enqueue, publicJob, jobDir };
