# 🎬 Recap Studio

Upload a video (e.g. a Chinese donghua drama clip) and get a **dialogue-style movie recap video** with **Burmese subtitles** burned onto the scenes — like the recap channels on TikTok/Facebook.

**Pipeline:** chunked upload → ffmpeg audio extraction → AssemblyAI transcription (auto language detect + speaker diarization) → scene segmentation → OpenRouter (free models) generates a Burmese dialogue-style recap script → keyframe per scene → ffmpeg + libass burns the subtitles (Noto Sans Myanmar) → downloadable MP4 + .srt + script .txt.

**v1 does NOT include Burmese voiceover** — subtitles + script only. For voiceover, paste the generated script into Narakeet / CapCut (Burmese TTS) and mix it in. This is an honest limit of the current build, not a bug.

## Quick start (Burmese)

1. **API key နှစ်ခု ယူပါ (အခမဲ့)**
   - AssemblyAI: https://www.assemblyai.com/ — အကောင့်သစ်မှာ **$50 free credit** ရတယ်၊ ကတ်မလိုဘူး။ နာရီ 185 လောက်အထိ transcribe လုပ်လို့ရတယ်။ Dashboard က API key ကို ကူးပါ။
   - OpenRouter: https://openrouter.ai/ — အကောင့်ဖွင့်ပြီး API key ယူပါ။ `:free` နဲ့ဆုံးတဲ့ model တွေက အခမဲ့ပါ (တစ်နေ့ 50 requests)။
2. **GitHub ပေါ်တင်ပါ** — ဒီ folder ကို GitHub repo တစ်ခုထဲ push လုပ်ပါ။
3. **Render မှာ deploy လုပ်ပါ** — Render Dashboard → **New → Blueprint** → repo ကို ရွေးပါ။ `render.yaml` က web service + 5 GB disk ကို အလိုအလျောက် ဖန်တီးပေးပါတယ်။ (Paid plan လိုပါတယ် — disk သုံးလို့။)
4. **Website ဖွင့်ပြီး Settings ထဲမှာ key နှစ်ခု ထည့်ပါ** — key တွေက သင့် browser ထဲမှာပဲ သိမ်းပါတယ် (localStorage)။ Server ပေါ်မှာ လုံးဝမသိမ်းပါဘူး။ "Key တွေ စမ်းကြည့်မယ်" နဲ့ စစ်လို့ရပါတယ်။
5. **Video တင်ပြီး "Recap Video ထုတ်မယ်" ကို နှိပ်ပါ** — ပြီးရင် video preview ကြည့်ပြီး download လုပ်လို့ရပါတယ်။ Script ကို ပြင်ချင်ရင် textarea ထဲမှာ ပြင်ပြီး "စာတန်းထိုး ပြန်ထည့်မယ်" ကို နှိပ်ပါ။

## Local development

```bash
npm install
# Optional: copy .env.example to .env and set server-side default keys.
# Test the full pipeline without real keys:
RECAP_MOCK=1 FONT_DIR=./fonts node server.js
# then open http://localhost:3000
```

`RECAP_MOCK=1` uses fake transcript/script data so the ffmpeg, subtitle burn-in, keyframes and queue code can be verified locally. It is **off by default** and must stay off in production.

## How it works

```
public/            Frontend (vanilla JS, Burmese UI)
  index.html       Upload / Settings / Progress / Results
  app.js           Chunked upload (8 MB), polling, script editor, re-render
  styles.css
server.js          Express: static hosting + API
src/
  config.js        Limits, model list, env
  store.js         In-memory job store + one-at-a-time queue
  pipeline.js      The 8 pipeline steps + re-render
  media.js         ffmpeg/ffprobe helpers (probe, audio, keyframes, burn-in)
  subtitles.js     SRT/ASS generation + transcript -> scene segmentation
  assemblyai.js    Upload + transcribe + poll (word timestamps, diarization)
  openrouter.js    Chat completions with free-model fallback list
  mock.js          Fake providers for local testing
```

### API endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Health + ffmpeg check + limits |
| `/api/upload/init` | POST | Start a chunked upload session |
| `/api/upload/chunk?uploadId&index` | POST | One 8 MB chunk (raw binary) |
| `/api/upload/complete` | POST | Assemble chunks, create + enqueue job (keys in body) |
| `/api/jobs/:id` | GET | Job status, step, progress, logs, result |
| `/api/jobs/:id/download/:type` | GET | `video` / `srt` / `script` / `keyframe?n=` |
| `/api/jobs/:id/rerender` | POST | Re-burn subtitles from edited lines |
| `/api/keys/test` | POST | Check AssemblyAI / OpenRouter keys (never stored) |

## Limits (honest)

- **One job at a time.** The queue is sequential on purpose — transcription + x264 encoding are CPU-heavy. Add more instances or a worker queue for scale.
- **Videos up to 500 MB.** Chunked upload bypasses Render's ~100 MB single-request cap.
- **Jobs kept 1 hour** after finishing, then files are deleted automatically.
- **Transcription accuracy** depends on AssemblyAI's model and the audio quality. Noisy audio or heavy music gives worse transcripts.
- **OpenRouter free models rotate** — the default list uses `openrouter/free` (auto-router) first, then named fallbacks. If a model disappears, edit the list in Settings.
- **No Burmese voiceover in v1** (see above).
- **Keys are per-user, per-browser.** If you open the site in another browser, enter the keys again. Server-side defaults can be set via `ASSEMBLYAI_API_KEY` / `OPENROUTER_API_KEY` env vars if you prefer.

## Deploy notes

- Render plan: `starter` in `render.yaml` is the cheapest paid plan with disk support. A 500 MB video job needs ~1.5 GB of scratch space (input + audio + output + keyframes), hence the 5 GB disk.
- The Dockerfile downloads Noto Sans Myanmar at build time from the Google Fonts GitHub mirror — no font binaries in the repo.
- Health check: `/api/health` (Render pings this).
