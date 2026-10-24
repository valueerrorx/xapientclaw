// minimal cron scheduler: workspace/cron/schedule.json {name: "m h dom mon dow"}, re-read every minute
import fs from 'node:fs';
import path from 'node:path';

const MACROS = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *' };
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function field(expr, [min, max]) {
  const set = new Set();
  for (const part of expr.split(',')) {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`ungültig: ${part}`);
    const lo = m[1] === '*' ? min : +m[2];
    const hi = m[1] === '*' ? max : m[3] !== undefined ? +m[3] : m[4] ? max : lo;  // "5/15" = from 5 to max
    const step = m[4] ? +m[4] : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`außerhalb ${min}-${max}: ${part}`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

export function parse(expr) {
  const f = (MACROS[expr.trim()] ?? expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error('5 Felder oder @hourly/@daily/@weekly/@monthly/@yearly');
  const [min, hour, dom, mon, dow] = f.map((e, i) => field(e, RANGES[i]));
  if (dow.has(7)) dow.add(0);  // 7 = sunday
  return { min, hour, dom, mon, dow, domAny: f[2] === '*', dowAny: f[4] === '*' };
}

export function matches(c, d) {
  const domOk = c.dom.has(d.getDate()), dowOk = c.dow.has(d.getDay());
  const day = c.domAny || c.dowAny ? domOk && dowOk : domOk || dowOk;  // classic cron: both restricted -> OR
  return day && c.min.has(d.getMinutes()) && c.hour.has(d.getHours()) && c.mon.has(d.getMonth() + 1);
}

export const scheduleFile = workspace => path.join(workspace, 'cron', 'schedule.json');

export function readSchedule(workspace) {
  try { return JSON.parse(fs.readFileSync(scheduleFile(workspace), 'utf8')); } catch { return {}; }
}

export function startScheduler(workspace, fire, log) {
  const tick = () => {
    const now = new Date();
    for (const [name, expr] of Object.entries(readSchedule(workspace))) {
      try {
        if (!matches(parse(expr), now)) continue;
        const prompt = fs.readFileSync(path.join(workspace, 'cron', `${name}.md`), 'utf8').trim();
        fire(name, prompt);
      } catch (e) { log(`cron ${name}:`, e.message); }
    }
    setTimeout(tick, 60_000 - (Date.now() % 60_000) + 500);  // next minute boundary
  };
  setTimeout(tick, 60_000 - (Date.now() % 60_000) + 500);
}
