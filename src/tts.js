// tts.js: talk to the local pocket-tts voice service and prepare text for speech.
// The gateway sends the full text as a normal message either way; this only produces
// the spoken version. Errors are the caller's to swallow (voice must never block a reply).

import { normalizeDe } from './ttsNormalize.js';

// Turn a Telegram/HTML/markdown reply into something that reads well aloud.
export function speakify(raw) {
  let t = String(raw || '');
  t = t.replace(/<pre[\s\S]*?<\/pre>/gi, '\nCode steht im Text.\n');  // code blocks -> hint
  t = t.replace(/```[\s\S]*?```/g, '\nCode steht im Text.\n');
  t = t.replace(/<code>([\s\S]*?)<\/code>/gi, '$1');                 // inline code -> its text
  t = t.replace(/`([^`]*)`/g, '$1');
  t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');       // remaining HTML tags
  t = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
  t = t.replace(/https?:\/\/\S+/g, ' Link ');                        // URLs -> "Link"
  t = t.replace(/^\s*(?:[>#]+|[-*•·]\s)\s*/gm, '');                  // md headings/quotes/list bullets
  t = t.replace(/[•*_#|`]/g, ' ');                                   // stray markers
  // each line is its own sentence (lists/headings would otherwise run together)
  t = t.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => (/[.!?:;,…]["'“”)]*$/.test(l) ? l : `${l}.`)).join('\n');
  t = normalizeDe(t);                                                // numbers, units, abbreviations, symbols
  return t.replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
}

// Keep the spoken part reasonable: cut at a sentence boundary near maxChars.
function clip(text, maxChars) {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  const spoken = cut > maxChars * 0.4 ? head.slice(0, cut + 1) : head;
  return `${spoken.trim()} … den Rest liest du im Text.`;
}

export function createTts(cfg, log) {
  const { url, enabled, timeoutMs, maxChars } = cfg.tts;

  async function health() {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch { return false; }
  }

  // Text -> OGG/Opus Buffer (or null if nothing speakable). Throws on service/timeout error.
  async function synth(rawText, voice) {
    const clean = speakify(rawText);
    if (!clean) return null;
    const text = clip(clean, maxChars);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${url}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(voice ? { text, voice } : { text }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`tts /speak ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } finally { clearTimeout(timer); }
  }

  return { enabled, synth, health, speakify, url };
}
