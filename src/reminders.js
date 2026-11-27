// reminders: workspace/private/reminders.json [{id, text, at|date, created, sent}], times in Europe/Vienna
import fs from 'node:fs';
import path from 'node:path';

export const TZ = 'Europe/Vienna';
const LATE_MS = 5 * 60_000;  // later than this -> note original time

export const remindersFile = workspace => path.join(workspace, 'private', 'reminders.json');

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// wall-clock parts of an instant in Vienna
export function viennaParts(d) {
  const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

const pad = n => String(n).padStart(2, '0');
export const viennaDate = d => { const p = viennaParts(d); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };
const offsetMin = d => { const p = viennaParts(d); return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(d / 1000) * 1000) / 60_000); };

// Vienna wall time -> Date (DST-safe: re-check offset at the result)
export function fromVienna(y, mo, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetMin(new Date(guess)) * 60_000;
  t = guess - offsetMin(new Date(t)) * 60_000;
  return new Date(t);
}

// ISO string with Vienna offset, e.g. 2026-11-27T13:25:00+01:00
export function isoVienna(d) {
  const p = viennaParts(d), o = offsetMin(d), a = Math.abs(o);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${o < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export const showAt = d => { const p = viennaParts(d); return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`; };

const validDate = (y, mo, d) => { const t = new Date(Date.UTC(y, mo - 1, d)); return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d; };

// "2027-09-27" | "2026-11-27 13:25" | "13:25" | "+2h"/"+30m"/"+1d" -> {date} or {at: Date}
export function parseWhen(s, now = new Date()) {
  s = String(s ?? '').trim();
  let m;
  if ((m = s.match(/^\+(\d+)([mhd])$/))) return { at: new Date(now.getTime() + +m[1] * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]]) };
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    if (!validDate(+m[1], +m[2], +m[3])) throw new Error(`ungültiges Datum: ${s}`);
    if (s < viennaDate(now)) throw new Error(`Datum liegt in der Vergangenheit: ${s}`);
    return { date: s };
  }
  if ((m = s.match(/^(?:(\d{4})-(\d{2})-(\d{2})[ T])?(\d{1,2}):(\d{2})$/))) {
    const h = +m[4], mi = +m[5];
    if (h > 23 || mi > 59) throw new Error(`ungültige Uhrzeit: ${s}`);
    if (m[1]) {
      if (!validDate(+m[1], +m[2], +m[3])) throw new Error(`ungültiges Datum: ${s}`);
      const at = fromVienna(+m[1], +m[2], +m[3], h, mi);
      if (at <= now) throw new Error(`Zeitpunkt liegt in der Vergangenheit: ${s}`);
      return { at };
    }
    const p = viennaParts(now);
    let at = fromVienna(p.y, p.mo, p.d, h, mi);
    if (at <= now) { const t = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1)); at = fromVienna(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), h, mi); }  // past -> tomorrow
    return { at };
  }
  throw new Error(`unbekanntes Format: ${s} (YYYY-MM-DD | YYYY-MM-DD HH:MM | HH:MM | +2h/+30m/+1d)`);
}

// sort key: at-instant or start of date in Vienna
export const sortKey = r => r.at ? new Date(r.at).getTime() : fromVienna(...r.date.split('-').map(Number)).getTime();

// at-reminders to send now
export const dueAt = (list, now = new Date()) => list.filter(r => r.at && !r.sent && new Date(r.at) <= now);

// morning brief: date-reminders due (today or overdue) + today's open at-reminders
export function todayItems(list, now = new Date()) {
  const today = viennaDate(now);
  const dates = list.filter(r => r.date && !r.sent && r.date <= today);
  const times = list.filter(r => r.at && !r.sent && viennaDate(new Date(r.at)) === today);
  return { dates: dates.sort((a, b) => sortKey(a) - sortKey(b)), times: times.sort((a, b) => sortKey(a) - sortKey(b)) };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function reminderMessage(r, now = new Date()) {
  const at = new Date(r.at);
  const late = now - at > LATE_MS ? `\n<i>(war fällig ${showAt(at)}, nachgeholt)</i>` : '';
  return `⏰ ${esc(r.text)}${late}`;
}

export function readReminders(workspace) {
  let raw;
  try { raw = fs.readFileSync(remindersFile(workspace), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) throw new Error('reminders.json: kein Array');
  return list;
}

// read fresh, modify, write atomically (tmp+rename); keeps the tool/gateway race window tiny
export function updateReminders(workspace, fn) {
  const list = readReminders(workspace);
  const out = fn(list) ?? list;
  const file = remindersFile(workspace), tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return out;
}

// gateway tick: send due at-reminders, then mark them sent (failed sends retry next tick)
export async function fireReminders(workspace, send, log, now = new Date()) {
  for (const r of dueAt(readReminders(workspace), now)) {
    try {
      await send(reminderMessage(r, now));
      updateReminders(workspace, list => { const x = list.find(e => e.id === r.id); if (x) x.sent = isoVienna(new Date()); });
      log('reminder sent', r.id);
    } catch (e) { log(`reminder ${r.id}:`, e.message); }
  }
}
