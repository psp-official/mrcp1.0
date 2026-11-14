// Recap Studio frontend — vanilla JS.
// Keys live in localStorage and are sent with the job request only.
// Uploads are chunked (8 MB) so big videos pass through Render's proxy.
(function () {
  'use strict';

  const CHUNK_SIZE = 8 * 1024 * 1024;
  const LS = {
    aai: 'recapstudio.assemblyaiKey',
    or: 'recapstudio.openrouterKey',
    model: 'recapstudio.model',
    lang: 'recapstudio.language',
    style: 'recapstudio.style',
  };
  const FREE_MODELS = [
    'openrouter/free',
    'google/gemma-4-31b-it:free',
    'nvidia/nemotron-3-super:free',
    'openai/gpt-oss-20b:free',
    'meta-llama/llama-3.3-70b-instruct:free',
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    dropzone: $('dropzone'), fileInput: $('file-input'),
    fileInfo: $('file-info'), previewVideo: $('preview-video'),
    fileName: $('file-name'), fileSize: $('file-size'), fileDuration: $('file-duration'),
    clearFile: $('clear-file'),
    keyAai: $('key-assemblyai'), keyOr: $('key-openrouter'),
    testKeys: $('test-keys'), keyStatus: $('key-status'),
    modelSelect: $('model-select'), modelCustom: $('model-custom'), modelToggle: $('model-toggle'),
    styleSelect: $('style-select'), langSelect: $('lang-select'),
    startBtn: $('start-btn'), startHint: $('start-hint'),
    progressCard: $('progress-card'), progressFill: $('progress-fill'),
    progressLabel: $('progress-label'), steps: $('steps'), logBox: $('log-box'),
    errorBox: $('error-box'),
    resultCard: $('result-card'), resultVideo: $('result-video'),
    dlVideo: $('dl-video'), dlSrt: $('dl-srt'), dlScript: $('dl-script'),
    keyframes: $('keyframes'), scriptEditor: $('script-editor'),
    rerenderBtn: $('rerender-btn'), rerenderStatus: $('rerender-status'),
  };

  let selectedFile = null;
  let currentJobId = null;
  let pollTimer = null;
  let customModel = false;

  // ------------------------------------------------------------ settings
  function loadSettings() {
    els.keyAai.value = localStorage.getItem(LS.aai) || '';
    els.keyOr.value = localStorage.getItem(LS.or) || '';
    els.langSelect.value = localStorage.getItem(LS.lang) || 'Burmese';
    els.styleSelect.value = localStorage.getItem(LS.style) || 'dialogue';
    els.modelSelect.innerHTML = FREE_MODELS.map((m) => `<option value="${m}">${m}</option>`).join('');
    els.modelSelect.value = localStorage.getItem(LS.model) || FREE_MODELS[0];
  }
  function saveSettings() {
    localStorage.setItem(LS.aai, els.keyAai.value.trim());
    localStorage.setItem(LS.or, els.keyOr.value.trim());
    localStorage.setItem(LS.model, customModel ? els.modelCustom.value.trim() : els.modelSelect.value);
    localStorage.setItem(LS.lang, els.langSelect.value);
    localStorage.setItem(LS.style, els.styleSelect.value);
  }
  [els.keyAai, els.keyOr, els.modelSelect, els.modelCustom, els.langSelect, els.styleSelect]
    .forEach((el) => el.addEventListener('change', saveSettings));

  els.modelToggle.addEventListener('click', () => {
    customModel = !customModel;
    els.modelCustom.hidden = !customModel;
    els.modelSelect.hidden = customModel;
    els.modelToggle.textContent = customModel ? 'Free model list ပြန်သုံးမယ်' : 'Custom model သုံးမယ်';
  });

  els.testKeys.addEventListener('click', async () => {
    const aai = els.keyAai.value.trim();
    const or = els.keyOr.value.trim();
    if (!aai && !or) { setKeyStatus('Key တစ်ခုခု အရင်ထည့်ပါ', false); return; }
    saveSettings();
    setKeyStatus('စမ်းနေတယ်…', null);
    try {
      const res = await fetch('/api/keys/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assemblyaiKey: aai || undefined, openrouterKey: or || undefined }),
      });
      const data = await res.json();
      const parts = [];
      if (data.assemblyai) parts.push(`AssemblyAI: ${data.assemblyai.ok ? '✅' : '❌'} ${data.assemblyai.message}`);
      if (data.openrouter) parts.push(`OpenRouter: ${data.openrouter.ok ? '✅' : '❌'} ${data.openrouter.message}`);
      const allOk = Object.values(data).every((v) => v.ok);
      setKeyStatus(parts.join(' · '), allOk);
    } catch (e) {
      setKeyStatus('စမ်းမရပါ: ' + e.message, false);
    }
  });
  function setKeyStatus(text, ok) {
    els.keyStatus.textContent = text;
    els.keyStatus.className = 'key-status' + (ok === true ? ' ok' : ok === false ? ' bad' : '');
  }

  // -------------------------------------------------------------- upload
  els.dropzone.addEventListener('click', () => els.fileInput.click());
  els.dropzone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropzone.classList.add('drag'); });
  els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('drag'));
  els.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('drag');
    if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
  });
  els.fileInput.addEventListener('change', () => {
    if (els.fileInput.files.length) setFile(els.fileInput.files[0]);
  });
  els.clearFile.addEventListener('click', () => setFile(null));

  function fmtBytes(n) {
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function fmtTime(s) {
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  function setFile(file) {
    selectedFile = file;
    if (!file) {
      els.fileInfo.hidden = true;
      els.previewVideo.src = '';
      els.startBtn.disabled = true;
      els.startHint.textContent = 'Video တစ်ခုရွေးပြီးရင် စလို့ရပါပြီ။';
      return;
    }
    if (file.size > 500 * 1024 * 1024) {
      alert('Video ကြီးလွန်းပါတယ် (အများဆုံး 500 MB)');
      setFile(null);
      return;
    }
    els.fileInfo.hidden = false;
    els.previewVideo.src = URL.createObjectURL(file);
    els.fileName.textContent = '📄 ' + file.name;
    els.fileSize.textContent = 'Size: ' + fmtBytes(file.size);
    els.previewVideo.onloadedmetadata = () => {
      els.fileDuration.textContent = 'ကြာချိန်: ' + fmtTime(els.previewVideo.duration);
    };
    els.startBtn.disabled = false;
    els.startHint.textContent = '';
  }

  // -------------------------------------------------------------- pipeline
  els.startBtn.addEventListener('click', async () => {
    if (!selectedFile) return;
    saveSettings();
    els.startBtn.disabled = true;
    els.errorBox.hidden = true;
    els.resultCard.hidden = true;
    els.progressCard.hidden = false;
    setProgress(0, 'Upload ပြင်နေတယ်…');
    try {
      const jobId = await uploadAndStart(selectedFile);
      currentJobId = jobId;
      pollJob(jobId);
    } catch (e) {
      showError(e.message);
      els.startBtn.disabled = false;
    }
  });

  async function uploadAndStart(file) {
    // 1. init
    const initRes = await fetch('/api/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, fileSize: file.size }),
    });
    const init = await initRes.json();
    if (!initRes.ok) throw new Error(init.error || 'Upload init မရပါ');
    const totalChunks = init.totalChunks;

    // 2. chunks (sequential — simple and reliable)
    for (let i = 0; i < totalChunks; i++) {
      const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const res = await fetch(`/api/upload/chunk?uploadId=${init.uploadId}&index=${i}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: chunk,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Chunk ${i} တင်မရပါ`);
      }
      setProgress(Math.round(((i + 1) / totalChunks) * 10), `Uploading… ${i + 1}/${totalChunks}`);
    }

    // 3. complete -> creates the job
    const models = customModel && els.modelCustom.value.trim()
      ? [els.modelCustom.value.trim()]
      : [els.modelSelect.value];
    const res = await fetch('/api/upload/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        uploadId: init.uploadId,
        assemblyaiKey: els.keyAai.value.trim(),
        openrouterKey: els.keyOr.value.trim(),
        models,
        language: els.langSelect.value,
        style: els.styleSelect.value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Job စမရပါ');
    return data.jobId;
  }

  const STEP_LABELS = {
    queued: 'တန်းစီနေတယ်…', probe: 'Video စစ်ဆေးနေတယ်…', audio: 'အသံထုတ်ယူနေတယ်…',
    transcribe: 'အသံကို စာသားပြောင်းနေတယ်…', segment: 'Scene တွေခွဲနေတယ်…',
    script: 'Recap script ရေးနေတယ်…', keyframes: 'Keyframe တွေထုတ်နေတယ်…',
    subtitles: 'စာတန်းထိုး ထည့်နေတယ်…', done: 'ပြီးပြီ!',
  };

  function pollJob(jobId) {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        if (!res.ok) return;
        const job = await res.json();
        setProgress(job.progress, STEP_LABELS[job.step] || job.step);
        markSteps(job.step, job.status);
        els.logBox.textContent = (job.logs || []).join('\n');
        els.logBox.scrollTop = els.logBox.scrollHeight;
        if (job.status === 'done') {
          clearInterval(pollTimer);
          showResult(job);
          els.startBtn.disabled = false;
        } else if (job.status === 'error') {
          clearInterval(pollTimer);
          showError(job.error || 'Job မအောင်မြင်ပါ');
          els.startBtn.disabled = false;
        }
      } catch (e) {
        // transient network error — keep polling
      }
    }, 2000);
  }

  function setProgress(pct, label) {
    els.progressFill.style.width = pct + '%';
    els.progressLabel.textContent = label + (pct ? ` (${pct}%)` : '');
  }
  function markSteps(currentStep, status) {
    const order = ['probe', 'audio', 'transcribe', 'segment', 'script', 'keyframes', 'subtitles', 'done'];
    const curIdx = order.indexOf(currentStep);
    els.steps.querySelectorAll('li').forEach((li) => {
      const idx = order.indexOf(li.dataset.step);
      li.classList.remove('active', 'done');
      if (status === 'done' || idx < curIdx) li.classList.add('done');
      else if (idx === curIdx) li.classList.add('active');
    });
  }
  function showError(msg) {
    els.errorBox.hidden = false;
    els.errorBox.textContent = '❌ ' + msg;
  }

  // -------------------------------------------------------------- results
  function showResult(job) {
    els.resultCard.hidden = false;
    els.resultVideo.src = `/api/jobs/${job.id}/download/video?t=${Date.now()}`;
    els.dlVideo.onclick = () => { window.location = `/api/jobs/${job.id}/download/video`; };
    els.dlSrt.onclick = () => { window.location = `/api/jobs/${job.id}/download/srt`; };
    els.dlScript.onclick = () => { window.location = `/api/jobs/${job.id}/download/script`; };

    const kf = job.result.keyframes || [];
    els.keyframes.innerHTML = kf.map((f, i) =>
      `<figure><img src="/api/jobs/${job.id}/download/keyframe?n=${i}" alt="scene ${i + 1}" loading="lazy">
       <figcaption>Scene ${i + 1} · ${fmtTime(f.start)}–${fmtTime(f.end)}</figcaption></figure>`).join('');

    els.scriptEditor.value = (job.result.lines || [])
      .map((l) => `[${fmtTime(l.start)}–${fmtTime(l.end)}] ${l.speaker}: ${l.text}`)
      .join('\n');
    els.resultCard.scrollIntoView({ behavior: 'smooth' });
  }

  // Parse the edited script textarea back into lines.
  function parseScriptEditor() {
    const lines = [];
    for (const raw of els.scriptEditor.value.split('\n')) {
      const m = raw.match(/^\[(\d+):(\d+)–(\d+):(\d+)\]\s*([^:]+):\s*(.+)$/);
      if (!m) continue;
      const start = Number(m[1]) * 60 + Number(m[2]);
      const end = Number(m[3]) * 60 + Number(m[4]);
      lines.push({ start, end, speaker: m[5].trim(), text: m[6].trim() });
    }
    return lines;
  }

  els.rerenderBtn.addEventListener('click', async () => {
    if (!currentJobId) return;
    const lines = parseScriptEditor();
    if (!lines.length) {
      els.rerenderStatus.textContent = 'Script format မမှန်ပါ — [MM:SS–MM:SS] Speaker: text ပုံစံထားပါ';
      els.rerenderStatus.className = 'key-status bad';
      return;
    }
    els.rerenderBtn.disabled = true;
    els.rerenderStatus.textContent = 'စာတန်းထိုး ပြန်ထည့်နေတယ်…';
    els.rerenderStatus.className = 'key-status';
    try {
      const res = await fetch(`/api/jobs/${currentJobId}/rerender`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lines }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Re-render မရပါ');
      els.resultVideo.src = `/api/jobs/${currentJobId}/download/video?t=${Date.now()}`;
      els.rerenderStatus.textContent = '✅ ပြီးပြီ — video အသစ်ကို ကြည့်လို့ရပြီ';
      els.rerenderStatus.className = 'key-status ok';
    } catch (e) {
      els.rerenderStatus.textContent = '❌ ' + e.message;
      els.rerenderStatus.className = 'key-status bad';
    } finally {
      els.rerenderBtn.disabled = false;
    }
  });

  loadSettings();
})();
