// Tests for German TTS text normalization (run: npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardinal, ordinal, normalizeDe } from '../src/ttsNormalize.js';
import { speakify } from '../src/tts.js';

test('cardinal numbers', () => {
  assert.equal(cardinal(0), 'null');
  assert.equal(cardinal(1), 'eins');
  assert.equal(cardinal(21), 'einundzwanzig');
  assert.equal(cardinal(101), 'einhunderteins');
  assert.equal(cardinal(2026), 'zweitausendsechsundzwanzig');
  assert.equal(cardinal(21000), 'einundzwanzigtausend');
  assert.equal(cardinal(1000000), 'eine Million');
  assert.equal(cardinal(2500000), 'zwei Millionen fünfhunderttausend');
});

test('ordinals', () => {
  assert.equal(ordinal(1), 'erste');
  assert.equal(ordinal(3), 'dritte');
  assert.equal(ordinal(7), 'siebte');
  assert.equal(ordinal(8), 'achte');
  assert.equal(ordinal(12), 'zwölfte');
  assert.equal(ordinal(24), 'vierundzwanzigste');
});

const cases = [
  ['Das kostet 45,93 € und dauert 3–4 Tage.', 'Das kostet fünfundvierzig Euro dreiundneunzig und dauert drei bis vier Tage.'],
  ['Nur 0,50 € bzw. 2.200 €.', 'Nur fünfzig Cent beziehungsweise zweitausendzweihundert Euro.'],
  ['Morgen -1 bis 3 °C.', 'Morgen minus eins bis drei Grad.'],
  ['Treffen um 08:30 Uhr, um 14:00 und um 1:05.', 'Treffen um acht Uhr dreißig, um vierzehn Uhr und um ein Uhr fünf.'],
  ['Spiel 2:1, Tests 46/46 grün.', 'Spiel zwei zu eins, Tests sechsundvierzig von sechsundvierzig grün.'],
  ['Build V23, z. B. der CameraX-Build.', 'Build V dreiundzwanzig, zum Beispiel der CameraX Build.'],
  ['Das ist ca. 12 % schneller – inkl. Cache.', 'Das ist circa zwölf Prozent schneller, inklusive Cache.'],
  ['Am 24.11. um 9:00 Termin.', 'Am vierundzwanzigsten November um neun Uhr Termin.'],
  ['Stand 24.11.2026 fertig.', 'Stand vierundzwanzigster November zweitausendsechsundzwanzig fertig.'],
  ['Der 3. Platz am 1. Dezember.', 'Der dritte Platz am ersten Dezember.'],
  ['ETH +96.9 vs 90.7', 'ETH plus sechsundneunzig Komma neun gegen neunzig Komma sieben'],
  ['Version 0.3.0 ist da.', 'Version null Punkt drei Punkt null ist da.'],
  ['Timeout 600 s, 1 min Pause, 4x schneller.', 'Timeout sechshundert Sekunden, eine Minute Pause, vier mal schneller.'],
  ['RAM >= 2000 MB, 1 Fehler.', 'RAM mindestens zweitausend Megabyte, ein Fehler.'],
  ['Commit 22f7c13 gepusht.', 'Commit gepusht.'],
  ['Log in /home/xapient/jobs/x.log, ggf. neu starten.', 'Log in, gegebenenfalls neu starten.'],
  ['Erledigt → nächster Schritt, d. h. warten usw.', 'Erledigt, nächster Schritt, das heißt warten und so weiter.'],
];

for (const [input, want] of cases) {
  test(`normalizeDe: ${input}`, () => assert.equal(normalizeDe(input), want));
}

test('speakify: HTML, bullets, emojis, entities, lines become sentences', () => {
  const raw = '<b>Fertig</b> ✅\n• Tests 101/101\n• Preis &lt; 5 € &amp; ok\nSiehe https://example.com';
  assert.equal(speakify(raw), 'Fertig. Tests einhunderteins von einhunderteins. Preis unter fünf Euro und ok. Siehe Link.');
});

test('speakify: code blocks become a hint', () => {
  assert.equal(speakify('Ergebnis:\n<pre>a | 1\nb | 2</pre>'), 'Ergebnis: Code steht im Text.');
});

test('speakify: no digits or special symbols survive', () => {
  const raw = 'Morgen 07:00 🌤 -2–4 °C, 3× Regen → 45,93 € (≈ 5 %) #715 – V2-Build ~/x.sh';
  const out = speakify(raw);
  assert.doesNotMatch(out, /[\d€%°→–#~×≈]/u, out);
});
