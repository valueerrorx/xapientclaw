// Tests for reminder parsing and due logic (run: npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWhen, fromVienna, isoVienna, dueAt, todayItems, reminderMessage, fireReminders, readReminders, updateReminders } from '../src/reminders.js';

const now = new Date('2026-11-27T12:00:00Z');  // 13:00 Vienna (CET)

test('parse date only', () => {
  assert.deepEqual(parseWhen('2027-09-27', now), { date: '2027-09-27' });
  assert.deepEqual(parseWhen('2026-11-27', now), { date: '2026-11-27' });  // today ok
  assert.throws(() => parseWhen('2026-11-26', now), /Vergangenheit/);
  assert.throws(() => parseWhen('2027-02-30', now), /ungültig/);
});

test('parse date + time in Vienna, DST-aware', () => {
  assert.equal(parseWhen('2026-11-27 13:25', now).at.toISOString(), '2026-11-27T12:25:00.000Z');
  assert.equal(parseWhen('2027-07-01 09:00', now).at.toISOString(), '2027-07-01T07:00:00.000Z');  // CEST
  assert.equal(parseWhen('2027-03-28T03:30', now).at.toISOString(), '2027-03-28T01:30:00.000Z');  // after spring switch
  assert.throws(() => parseWhen('2026-11-27 12:59', now), /Vergangenheit/);
  assert.throws(() => parseWhen('2026-11-27 24:00', now), /ungültig/);
});

test('parse time only: today or tomorrow', () => {
  assert.equal(parseWhen('13:25', now).at.toISOString(), '2026-11-27T12:25:00.000Z');
  assert.equal(parseWhen('9:00', now).at.toISOString(), '2026-11-28T08:00:00.000Z');
  assert.equal(parseWhen('13:00', now).at.toISOString(), '2026-11-28T12:00:00.000Z');  // exactly now -> tomorrow
  const eom = new Date('2026-11-30T22:30:00Z');  // 23:30 Vienna, month end
  assert.equal(parseWhen('08:00', eom).at.toISOString(), '2026-12-01T07:00:00.000Z');
});

test('parse relative', () => {
  assert.equal(parseWhen('+30m', now).at.toISOString(), '2026-11-27T12:30:00.000Z');
  assert.equal(parseWhen('+2h', now).at.toISOString(), '2026-11-27T14:00:00.000Z');
  assert.equal(parseWhen('+1d', now).at.toISOString(), '2026-11-28T12:00:00.000Z');
  assert.throws(() => parseWhen('morgen', now), /Format/);
  assert.throws(() => parseWhen('', now), /Format/);
});

test('iso with Vienna offset round-trips', () => {
  assert.equal(isoVienna(fromVienna(2026, 11, 27, 13, 25)), '2026-11-27T13:25:00+01:00');
  assert.equal(isoVienna(fromVienna(2027, 7, 1, 9, 0)), '2027-07-01T09:00:00+02:00');
  assert.equal(new Date(isoVienna(now)).getTime(), now.getTime());
});

const list = [
  { id: '1', text: 'a', at: '2026-11-27T12:59:00+01:00', sent: null },
  { id: '2', text: 'b', at: '2026-11-27T13:00:00+01:00', sent: null },
  { id: '3', text: 'c', at: '2026-11-27T13:01:00+01:00', sent: null },
  { id: '4', text: 'd', at: '2026-11-27T10:00:00+01:00', sent: '2026-11-27T10:00:30+01:00' },
  { id: '5', text: 'e', date: '2026-11-27', sent: null },
  { id: '6', text: 'f', date: '2026-11-20', sent: null },
  { id: '7', text: 'g', date: '2026-11-28', sent: null },
  { id: '8', text: 'h', date: '2026-11-25', sent: '2026-11-25T07:00:00+01:00' },
  { id: '9', text: 'i', at: '2026-11-28T08:00:00+01:00', sent: null },
];

test('dueAt: at <= now and not sent, date entries ignored', () => {
  assert.deepEqual(dueAt(list, now).map(r => r.id), ['1', '2']);
});

test('todayItems: due/overdue dates + today\'s open times', () => {
  const { dates, times } = todayItems(list, now);
  assert.deepEqual(dates.map(r => r.id), ['6', '5']);
  assert.deepEqual(times.map(r => r.id), ['1', '2', '3']);
});

test('message: late note only beyond 5 min, HTML escaped', () => {
  const r = { text: 'a<b> & c', at: '2026-11-27T12:56:00+01:00' };
  assert.equal(reminderMessage(r, now), '⏰ a&lt;b&gt; &amp; c');
  assert.match(reminderMessage({ ...r, at: '2026-11-27T12:54:00+01:00' }, now), /war fällig 2026-11-27 12:54, nachgeholt/);
});

test('fireReminders: sends, marks sent, broken file does not throw', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
  updateReminders(ws, () => list.map(r => ({ ...r })));
  const sent = [], logs = [];
  await fireReminders(ws, async t => { sent.push(t); }, (...a) => logs.push(a.join(' ')), now);
  assert.deepEqual(sent, ['⏰ a', '⏰ b']);
  assert.deepEqual(readReminders(ws).filter(r => r.at && !r.sent).map(r => r.id), ['3', '9']);
  // failing send -> stays unsent for retry
  updateReminders(ws, l => { l.find(r => r.id === '3').at = '2026-11-27T12:00:00+01:00'; });
  await fireReminders(ws, async () => { throw new Error('offline'); }, (...a) => logs.push(a.join(' ')), now);
  assert.equal(readReminders(ws).find(r => r.id === '3').sent, null);
  assert.ok(logs.some(l => l.includes('offline')));
  // broken / missing file
  fs.writeFileSync(path.join(ws, 'private', 'reminders.json'), '{kaputt');
  await assert.rejects(fireReminders(ws, async () => {}, () => {}, now));  // scheduler catches + logs
  fs.rmSync(ws, { recursive: true });
  assert.deepEqual(readReminders(ws), []);
});
