// ttsNormalize.js: German text normalization for TTS (numbers, dates, units, abbreviations, symbols).
// the tts service reads raw text; digits and symbols produce gibberish, so everything is spelled out here.

const ONES = ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn',
  'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'];
const TENS = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];
const MONTHS = ['Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONTH_RE = 'Jänner|Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember';

// "eins" -> "ein" inside compounds (einundzwanzigtausend, hunderteins -> hundertein Millionen)
const pre = w => w.replace(/eins$/, 'ein');

function below100(n) {
  if (n < 20) return ONES[n];
  const o = n % 10;
  return o ? `${o === 1 ? 'ein' : ONES[o]}und${TENS[Math.floor(n / 10)]}` : TENS[Math.floor(n / 10)];
}

function below1000(n) {
  const h = Math.floor(n / 100), r = n % 100;
  return (h ? `${h === 1 ? 'ein' : ONES[h]}hundert` : '') + (r ? below100(r) : '');
}

// Cardinal number in words (0 .. < 1e12).
export function cardinal(n) {
  if (n === 0) return 'null';
  const mrd = Math.floor(n / 1e9), mio = Math.floor(n / 1e6) % 1000, tsd = Math.floor(n / 1000) % 1000, r = n % 1000;
  const out = [];
  if (mrd) out.push(mrd === 1 ? 'eine Milliarde' : `${pre(below1000(mrd))} Milliarden`);
  if (mio) out.push(mio === 1 ? 'eine Million' : `${pre(below1000(mio))} Millionen`);
  const tail = (tsd ? `${pre(below1000(tsd))}tausend` : '') + (r ? below1000(r) : '');
  if (tail) out.push(tail);
  return out.join(' ');
}

// Ordinal stem ending, e.g. 3 -> "dritte", 24 -> "vierundzwanzigste"; caller adds r/n.
export function ordinal(n) {
  const w = cardinal(n), r = n % 100;
  if (r === 0 || r >= 20) return `${w}ste`;
  if (r === 1) return w.replace(/eins$/, 'erste');
  if (r === 3) return w.replace(/drei$/, 'dritte');
  if (r === 7) return w.replace(/sieben$/, 'siebte');
  if (r === 8) return `${w}e`;
  return `${w}te`;
}

const digitwise = s => s.split('').map(d => ONES[d]).join(' ');

// Integer string -> words; long numbers or leading zeros are read digit by digit.
export function readInt(s) {
  s = s.replace(/\./g, '');
  if (s.length > 12 || (s.length > 1 && s[0] === '0')) return digitwise(s);
  return cardinal(Number(s));
}

function year(y) {
  if (y >= 1100 && y < 2000) return `${below100(Math.floor(y / 100))}hundert${y % 100 ? below100(y % 100) : ''}`;
  return cardinal(y);
}

// Ordinal ending from the preceding word: "am 24." -> -ten, "der 3." -> -te, bare -> -ter.
function ordEnding(before) {
  const w = ((before.match(/(\p{L}+)\s*$/u) || [])[1] || '').toLowerCase();
  if (['der', 'die', 'das'].includes(w)) return '';
  if (['am', 'im', 'vom', 'zum', 'beim', 'dem', 'den', 'des', 'bis', 'seit', 'ab', 'ums', 'an', 'zur'].includes(w)) return 'n';
  return 'r';
}

function money(amount, cur) {
  let int = amount, frac = '';
  if (amount.includes(',')) [int, frac] = amount.split(',');
  else if (/\.\d{1,2}$/.test(amount)) { const i = amount.lastIndexOf('.'); int = amount.slice(0, i); frac = amount.slice(i + 1); }
  const cents = /^\d+$/.test(frac) ? Number(frac.padEnd(2, '0').slice(0, 2)) : 0;
  const units = Number(int.replace(/\./g, '') || 0);
  const name = /\$|usd|dollar/i.test(cur) ? 'Dollar' : 'Euro';
  if (!units && cents) return `${cardinal(cents)} Cent`;
  return `${units === 1 ? 'ein' : readInt(int || '0')} ${name}${cents ? ` ${cardinal(cents)}` : ''}`;
}

const UNITS = {
  km: ['Kilometer', 'Kilometer'], kg: ['Kilogramm', 'Kilogramm'], cm: ['Zentimeter', 'Zentimeter'], mm: ['Millimeter', 'Millimeter'],
  kb: ['Kilobyte', 'Kilobyte'], mb: ['Megabyte', 'Megabyte'], gb: ['Gigabyte', 'Gigabyte'], tb: ['Terabyte', 'Terabyte'],
  ms: ['Millisekunde', 'Millisekunden'], s: ['Sekunde', 'Sekunden'], sek: ['Sekunde', 'Sekunden'],
  min: ['Minute', 'Minuten'], h: ['Stunde', 'Stunden'], std: ['Stunde', 'Stunden'],
  kwh: ['Kilowattstunde', 'Kilowattstunden'], kw: ['Kilowatt', 'Kilowatt'], w: ['Watt', 'Watt'],
};

const ABBR = [
  [/\b([zZ])\.\s?B\./g, (_, z) => (z === 'Z' ? 'Zum' : 'zum') + ' Beispiel'],
  [/\bd\.\s?h\./g, 'das heißt'], [/\bu\.\s?a\./g, 'unter anderem'], [/\bu\.\s?U\./g, 'unter Umständen'],
  [/\bo\.\s?ä\./g, 'oder ähnlich'], [/\bi\.\s?d\.\s?R\./g, 'in der Regel'],
  [/\bca\./gi, 'circa'], [/\bbzw\./gi, 'beziehungsweise'], [/\binkl\./gi, 'inklusive'], [/\bexkl\./gi, 'exklusive'],
  [/\bevtl\./gi, 'eventuell'], [/\bggf\./gi, 'gegebenenfalls'], [/\bvgl\./gi, 'vergleiche'], [/\bbspw\./gi, 'beispielsweise'],
  [/\bsog\./gi, 'sogenannt'], [/\bzzgl\./gi, 'zuzüglich'], [/\bmind\./gi, 'mindestens'], [/\bmax\./gi, 'maximal'],
  [/\bNr\./g, 'Nummer'], [/\bvs\./gi, 'gegen'], [/\bStd\./g, 'Stunden'], [/\bMio\./g, 'Millionen'], [/\bMrd\./g, 'Milliarden'],
  [/\bDr\./g, 'Doktor'], [/\bgem\./g, 'gemäß'],
  [/\busw\./gi, 'und so weiter.'], [/\betc\./gi, 'et cetera.'],  // usually sentence-final: keep the stop
];

// Normalize German text for speech. Input is plain text (markup already removed).
export function normalizeDe(input) {
  let t = String(input || '');

  // code-ish tokens: e-mails, absolute/home paths, commit hashes
  t = t.replace(/\S+@\S+\.\w+/g, ' ');
  t = t.replace(/(^|[\s(])~?\/[^\s,;!?)]*/g, '$1 ');
  t = t.replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/gi, ' ');

  for (const [re, rep] of ABBR) t = t.replace(re, rep);
  t = t.replace(/\bvs\b/gi, 'gegen');
  t = t.replace(/\s*(→|->|=>|⇒|➜|➡️?|←|<-)\s*/g, ', ');
  t = t.replace(/\s*(>=|≥)\s*/g, ' mindestens ').replace(/\s*(<=|≤)\s*/g, ' höchstens ');
  t = t.replace(/\s*>\s*(?=[-+]?\d)/g, ' über ').replace(/\s*<\s*(?=[-+]?\d)/g, ' unter ');

  // dates: ISO, dd.mm.(yyyy), "24. November", ordinal after article
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) =>
    (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) ? `${ordinal(+d)}n ${MONTHS[mo - 1]} ${year(+y)}` : m);
  t = t.replace(/(\d\.?)\s?[-–—]\s?(?=[-−]?\d)/g, '$1 bis ');  // ranges 3-4, 08:30–10:00, 24.–26.11.
  t = t.replace(/(?<![\d.,])(\d{1,2})\.\s?(\d{1,2})\.(\d{4})?(?![\d])/g, (m, d, mo, y, off, s) =>
    (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) ? `${ordinal(+d)}${ordEnding(s.slice(0, off))} ${MONTHS[mo - 1]}${y ? ` ${year(+y)}` : ''}` : m);
  t = t.replace(new RegExp(`(?<![\\d.,])(\\d{1,2})\\.\\s+(${MONTH_RE})`, 'g'), (m, d, mon, off, s) =>
    `${ordinal(+d)}${ordEnding(s.slice(0, off))} ${mon}`);
  t = t.replace(/\b(am|im|vom|zum|beim|der|die|das|dem|den|des)\s+(\d{1,3})\.(?=\s+[\p{L}\d])/giu, (m, art, n) =>
    `${art} ${ordinal(+n)}${['der', 'die', 'das'].includes(art.toLowerCase()) ? '' : 'n'}`);

  // times and ratios
  t = t.replace(/(?<![\d:.,])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])(\s*Uhr\b)?/g, (m, h, mm) =>
    `${+h === 1 ? 'ein' : cardinal(+h)} Uhr${+mm ? ` ${cardinal(+mm)}` : ''}`);
  t = t.replace(/(?<![\d:])(\d+):(\d+)(?![\d:])/g, (m, a, b) => `${readInt(a)} zu ${readInt(b)}`);
  t = t.replace(/(?<![\d/])(\d+)\/(\d+)(?![\d/])/g, (m, a, b) => `${readInt(a)} von ${readInt(b)}`);

  // money (prefix and suffix currency)
  t = t.replace(/(€|\bEUR\b|\$|\bUSD\b)\s?(\d[\d.]*(?:,\d+)?)/g, (m, cur, a) => money(a, cur));
  t = t.replace(/(\d[\d.]*(?:,(?:\d+|-+))?)\s?(€|EUR\b|Euro\b|\$|USD\b|Dollar\b)/g, (m, a, cur) => money(a, cur));

  // signs
  t = t.replace(/(^|[\s(\[/])[-−–](?=\d)/g, '$1minus ');
  t = t.replace(/(^|[\s(\[/])\+(?=\d)/g, '$1plus ');
  t = t.replace(/±\s?/g, 'plus minus ');

  // units after numbers
  t = t.replace(/%/g, ' Prozent').replace(/‰/g, ' Promille').replace(/°\s?C\b/g, ' Grad').replace(/°/g, ' Grad');
  t = t.replace(/(\d)\s?[x×](?![\p{L}\d])/gu, '$1 mal').replace(/×/g, ' mal ');
  t = t.replace(/\bkm\/h\b/g, 'Kilometer pro Stunde');
  t = t.replace(/(?<![\w.,])(\d+(?:[.,]\d+)?)\s?(km|kg|cm|mm|KB|MB|GB|TB|ms|sek|min|Min|Std|kWh|kW|W|h|s)\b\.?/g, (m, n, u) => {
    const [one, many] = UNITS[u.toLowerCase()];
    if (n !== '1') return `${n} ${many}`;
    return `${one.endsWith('e') ? 'eine' : 'ein'} ${one}`;
  });

  // remaining numbers: thousands, versions, decimals, integers
  t = t.replace(/(?<![\d.,])\d+(?:\.\d+){2,}(?![\d])/g, m =>
    /^\d{1,3}(\.\d{3})+$/.test(m) ? readInt(m) : m.split('.').map(readInt).join(' Punkt '));
  t = t.replace(/(?<![\d.,])\d{1,3}(?:\.\d{3})+(?![\d.,]\d)/g, m => readInt(m));
  t = t.replace(/(\d+)[,.](\d+)/g, (m, a, b) => `${readInt(a)} Komma ${digitwise(b)}`);
  t = t.replace(/(\p{L})(\d)/gu, '$1 $2').replace(/(\d)(\p{L})/gu, '$1 $2');
  t = t.replace(/(?<![\d,])\b1 (?=\p{Lu}\p{Ll})/gu, 'ein ');  // "1 Fehler" -> "ein Fehler"
  t = t.replace(/\d+/g, m => ` ${readInt(m)} `);

  // symbols and dashes
  t = t.replace(/&/g, ' und ').replace(/\+/g, ' plus ').replace(/=/g, ' gleich ').replace(/[~≈]/g, ' circa ');
  t = t.replace(/\s+[-–—]+\s+/g, ', ').replace(/[–—]/g, ', ');
  t = t.replace(/(\p{L})-(?=\p{L})/gu, '$1 ').replace(/-/g, ' ');
  t = t.replace(/(\p{L})\.(?=\p{L})/gu, '$1 Punkt ');
  t = t.replace(/[()[\]{}]/g, ', ');

  // keep letters, digits and speech punctuation only (drops emojis, bullets, slashes, leftovers)
  t = t.replace(/[^\p{L}\p{N}\s.,;:!?"'„“”…]/gu, ' ');
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\s+([.,;:!?…])/g, '$1');
  t = t.replace(/([,;:])(?:\s*[,;:])+/g, '$1');
  t = t.replace(/[,;:]\s*([.!?])/g, '$1').replace(/([.!?])\s*[,;:]/g, '$1');
  t = t.replace(/(^|\n)\s*[,;:.]+\s*/g, '$1');
  t = t.replace(/\.{2,}/g, '.');
  return t.replace(/[ \t]+/g, ' ').trim();
}
