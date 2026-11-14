// Subtitle generation: SRT + ASS (libass burn-in) + plain-text recap script.
// All text is Burmese by default, rendered with Noto Sans Myanmar.

// "12.34" -> "00:00:12,340" (SRT)
function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(r, 3)}`;
}

// "12.34" -> "0:00:12.34" (ASS)
function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const r = cs % 100;
  const p = (n, w) => String(n).padStart(w, '0');
  return `${h}:${p(m, 2)}:${p(s, 2)}.${p(r, 2)}`;
}

// "12.34" -> "00:12" (script .txt)
function clockTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function escapeAssText(t) {
  return String(t)
    .replace(/\\/g, '\\\\')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

// Models often put the speaker name at the start of the text too
// ("မင်းသား: ..."), which would double up with our own "Speaker: " prefix.
// Strip a leading "Name:" when it matches (or nearly matches) the speaker.
function cleanLineText(l) {
  let text = String(l.text || '').trim();
  if (l.speaker && l.speaker !== 'Narrator') {
    const m = text.match(/^([^:\n]{1,30}):\s*(.+)$/s);
    if (m) {
      const name = m[1].trim();
      const sp = l.speaker.trim();
      if (name === sp || name.startsWith(sp) || sp.startsWith(name)) {
        text = m[2].trim();
      }
    }
  }
  return text;
}

// lines: [{start, end, speaker, text}]
function buildSrt(lines) {
  return lines
    .map((l, i) => {
      const who = l.speaker && l.speaker !== 'Narrator' ? `${l.speaker}: ` : '';
      return `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${who}${cleanLineText(l)}\n`;
    })
    .join('\n');
}

function buildAss(lines, { width, height }) {
  // Font size scales with video height; readable on phones and desktop.
  const fontSize = Math.max(28, Math.min(72, Math.round(height / 34)));
  const header = `[Script Info]
Title: Recap Studio
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans Myanmar,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2.5,1,2,60,60,${Math.round(height * 0.06)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = lines
    .map((l) => {
      const who = l.speaker && l.speaker !== 'Narrator' ? `{\\b1}${escapeAssText(l.speaker)}: {\\b0}` : '';
      return `Dialogue: 0,${assTime(l.start)},${assTime(l.end)},Default,,0,0,0,,${who}${escapeAssText(cleanLineText(l))}`;
    })
    .join('\n');
  return header + events + '\n';
}

function buildScriptTxt(lines) {
  return lines
    .map((l) => `[${clockTime(l.start)}–${clockTime(l.end)}] ${l.speaker || 'Narrator'}: ${cleanLineText(l)}`)
    .join('\n');
}

/**
 * Split the transcript words into scenes.
 * A new scene starts on a long pause (>1.5s) or a speaker change.
 * Very short scenes are merged forward; very long scenes are split at the
 * biggest internal pause. Returns [{start, end, speaker, text}].
 */
function segmentTranscript(words, { minSceneSec = 6, maxSceneSec = 40, gapSec = 1.5 } = {}) {
  if (!words || words.length === 0) return [];
  const sorted = [...words].sort((a, b) => a.start - b.start);

  // Pass 1: cut on gaps / speaker changes.
  let scenes = [];
  let cur = { start: sorted[0].start, end: sorted[0].end, speaker: sorted[0].speaker, words: [sorted[0]] };
  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i];
    const gap = w.start - cur.end;
    if (gap > gapSec || (w.speaker != null && cur.speaker != null && w.speaker !== cur.speaker)) {
      scenes.push(cur);
      cur = { start: w.start, end: w.end, speaker: w.speaker, words: [w] };
    } else {
      cur.words.push(w);
      cur.end = w.end;
    }
  }
  scenes.push(cur);

  // Pass 2: merge scenes shorter than minSceneSec into the next one.
  const merged = [];
  for (const s of scenes) {
    if (merged.length > 0 && (merged[merged.length - 1].end - merged[merged.length - 1].start) < minSceneSec) {
      const prev = merged[merged.length - 1];
      prev.words.push(...s.words);
      prev.end = s.end;
      if (!prev.speaker) prev.speaker = s.speaker;
    } else {
      merged.push({ ...s, words: [...s.words] });
    }
  }
  scenes = merged;

  // Pass 3: split scenes longer than maxSceneSec at the biggest pause.
  const split = [];
  for (const s of scenes) {
    if (s.end - s.start <= maxSceneSec || s.words.length < 2) {
      split.push(s);
      continue;
    }
    let bestIdx = -1;
    let bestGap = -1;
    for (let i = 1; i < s.words.length; i++) {
      const g = s.words[i].start - s.words[i - 1].end;
      const mid = (s.words[i].start + s.words[i - 1].end) / 2;
      const balanced = Math.abs(mid - (s.start + s.end) / 2) < (s.end - s.start) / 4;
      if (balanced && g > bestGap) {
        bestGap = g;
        bestIdx = i;
      }
    }
    if (bestIdx > 0) {
      split.push({ start: s.start, end: s.words[bestIdx - 1].end, speaker: s.speaker, words: s.words.slice(0, bestIdx) });
      split.push({ start: s.words[bestIdx].start, end: s.end, speaker: s.speaker, words: s.words.slice(bestIdx) });
    } else {
      split.push(s);
    }
  }

  return split.map((s) => ({
    start: Math.round(s.start * 100) / 100,
    end: Math.round(s.end * 100) / 100,
    speaker: s.speaker != null ? String(s.speaker) : null,
    text: s.words.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim(),
  })).filter((s) => s.text.length > 0);
}

module.exports = { srtTime, assTime, clockTime, buildSrt, buildAss, buildScriptTxt, segmentTranscript };
