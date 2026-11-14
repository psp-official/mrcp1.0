// Mock providers for local testing (RECAP_MOCK=1).
// Lets the whole pipeline run end-to-end without real API keys.
// The mock transcript/script is clearly labelled fake and is never used
// in production — it exists only so the ffmpeg/subtitle/queue code can be
// verified locally.
function mockTranscript(duration) {
  const phrases = [
    'ဒီနေ့ နတ်ဘုရားမလေး နိုးထလာတယ်',
    'သူ့ရဲ့ မျက်လုံးတွေက ကြယ်တွေလို တောက်ပနေတယ်',
    'မင်းသားလေးက သူမကို တွေ့ပြီး ရင်ခုန်သွားတယ်',
    'ဒါပေမယ့် ကံကြမ္မာက သူတို့ကို စမ်းသပ်နေတယ်',
    'သူတို့နှစ်ယောက် အတူတူ တိုက်ပွဲဝင်ကြတယ်',
    'အချစ်က အရာအားလုံးကို အောင်နိုင်တယ်',
  ];
  const words = [];
  let t = 0.4;
  let i = 0;
  while (t < duration - 0.5) {
    const phrase = phrases[i % phrases.length];
    for (const w of phrase.split(' ')) {
      const dur = 0.28 + Math.random() * 0.15;
      words.push({ text: w, start: t, end: t + dur, speaker: i % 2 === 0 ? '0' : '1', confidence: 0.99 });
      t += dur + 0.05;
    }
    t += 0.8; // pause between phrases
    i++;
  }
  return { words, utterances: [], language: 'my' };
}

function mockRecap(scenes, duration) {
  const lines = [
    { text: 'ဒီအခန်းလေးမှာ နတ်ဘုရားမလေး နိုးထလာပြီ… သူ့မျက်လုံးတွေက ကြယ်တွေလို တောက်ပနေတယ်။', speaker: 'Narrator' },
    { text: '"မင်းက ဘယ်သူလဲ… ငါ့ရင်ထဲကို ဝင်လာတာ ဘာကြောင့်လဲ?"', speaker: 'မင်းသား' },
    { text: '"ငါက မင်းရဲ့ ကံကြမ္မာပါ… မင်းနဲ့ အတူတူ ရှိချင်တယ်။"', speaker: 'နတ်ဘုရားမလေး' },
    { text: 'ဒါပေမယ့် ကံကြမ္မာက သူတို့ကို လွယ်လွယ်နဲ့ ပေးမထားဘူး… တိုက်ပွဲက စတော့မယ်။', speaker: 'Narrator' },
    { text: 'သူတို့နှစ်ယောက် အတူတူ တိုက်ပွဲဝင်ရင်း အချစ်က အရာအားလုံးကို အောင်နိုင်သွားတယ်။', speaker: 'Narrator' },
  ];
  const n = lines.length;
  return lines.map((l, i) => ({
    start: Math.round(((duration * i) / n + 0.1) * 100) / 100,
    end: Math.round(((duration * (i + 1)) / n - 0.1) * 100) / 100,
    speaker: l.speaker,
    text: l.text,
  }));
}

module.exports = { mockTranscript, mockRecap };
