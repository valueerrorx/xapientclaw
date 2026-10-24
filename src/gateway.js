#!/usr/bin/env node
// xapient gateway: chat channel (telegram|signal) <-> claude code master agent, plus local http for cron/agent
import fs from 'node:fs';
import http from 'node:http';
import { loadConfig } from './config.js';
import { createSignal } from './signal.js';
import { createTelegram } from './telegram.js';
import { runClaude } from './claude.js';
import { startScheduler } from './scheduler.js';
import { createTranscriber } from './transcribe.js';

const cfg = loadConfig();
const log = (...a) => console.log(new Date().toISOString(), ...a);
const channel = cfg.channel === 'signal' ? createSignal(cfg.signal, log) : createTelegram(cfg.telegram, log);
const transcriber = createTranscriber(cfg.transcription, log);
const owners = cfg.owners.map(String);
const owner = owners[0];  // primary recipient for agent/cron messages

// --- state (current session) ---
let state = { sessionId: null };
try { state = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')); } catch {}
const saveState = () => fs.writeFileSync(cfg.stateFile, JSON.stringify(state, null, 2));

// --- serial job queue, one claude process at a time ---
const queue = [];
let busy = false;
let current = null;  // { origin, child, started }

function enqueue(job) { queue.push(job); pump(); }

let restartPending = false;  // set via /restart, exit once idle so systemd restarts with new code

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    try { await queue.shift()(); } catch (e) { log('job error', e.message); }
  }
  busy = false;
  if (restartPending) { log('restart'); process.exit(0); }
}

const stamp = () => new Date().toLocaleString('de-AT', { timeZone: process.env.TZ || 'Europe/Vienna' });
const HEARTBEAT_MS = (cfg.heartbeatSec ?? 60) * 1000;  // periodic status ping while a job runs (0 = off)
const STATUS_FILE = `${cfg.claude.workspace}/.heartbeat-status`;  // agent may write a short "what I'm doing" line here; shown in the heartbeat
const readStatus = () => { try { return fs.readFileSync(STATUS_FILE, 'utf8').trim().slice(0, 300); } catch { return ''; } };

let activity = null;  // live view of what the running claude process is doing (from stream-json events)

function liveStatus() {
  if (!activity) return '';
  const bits = [];
  if (activity.lastTool) bits.push(`grad: ${activity.lastTool}`);
  if (activity.subagents) bits.push(`${activity.subagents} subagent${activity.subagents > 1 ? 's' : ''}`);
  if (activity.tools) bits.push(`${activity.tools} tool-calls`);
  return bits.join(' · ');
}

function onEvent(evt) {
  if (!activity) return;
  if (evt.type === 'assistant' && evt.message?.content) {
    for (const b of evt.message.content) {
      if (b.type !== 'tool_use') continue;
      activity.tools++;
      activity.lastTool = b.name;
      if (/^(task|agent)$/i.test(b.name)) activity.subagents++;  // subagents launched (cumulative)
    }
  }
}

async function run(prompt, sessionId, origin) {
  activity = { tools: 0, subagents: 0, lastTool: null };
  const { child, done } = runClaude(cfg, prompt, sessionId, { XAPIENT_ORIGIN: origin }, onEvent);
  current = { origin, child, started: Date.now() };
  try { return await done; } finally { current = null; activity = null; }
}

async function ask(prompt, origin, to = owner) {
  const interactive = !origin.startsWith('cron');  // cron replies are NOOP-silent -> no heartbeat
  const started = Date.now();
  try { fs.unlinkSync(STATUS_FILE); } catch {}  // drop stale status from a previous job
  const typing = setInterval(() => channel.typing(to).catch(() => {}), channel.typingEveryMs);  // typing indicator expires
  channel.typing(to).catch(() => {});
  const heartbeat = interactive && HEARTBEAT_MS
    ? setInterval(() => {  // first ping after HEARTBEAT_MS; quick jobs stay quiet
        const mins = Math.round((Date.now() - started) / 60000);
        const extra = [liveStatus(), readStatus()].filter(Boolean).join('\n');  // live events + optional agent note
        channel.send(to, `⏳ dran seit ${mins} min${extra ? `\n${extra}` : ''}`).catch(() => {});
      }, HEARTBEAT_MS)
    : null;
  try {
    let res;
    try { res = await run(prompt, state.sessionId, origin); } catch (e) {
      if (!state.sessionId || !/no conversation found/i.test(e.message)) throw e;
      log('session lost, starting new one');  // resume target gone -> fresh session
      res = await run(prompt, null, origin);
    }
    if (res.sessionId) { state.sessionId = res.sessionId; saveState(); }
    log(`done [${origin}] turns=${res.turns} cost=${res.cost ?? '-'}`);
    const text = res.text.trim();
    if (text && text !== 'NOOP') await channel.send(to, text);  // NOOP = agent stays silent
  } catch (e) {
    log('ask failed', e.message);
    await channel.send(to, `⚠️ ${e.message}`.slice(0, 1500)).catch(() => {});
  } finally {
    clearInterval(typing);
    if (heartbeat) clearInterval(heartbeat);
    try { fs.unlinkSync(STATUS_FILE); } catch {}  // status only lives for the duration of a job
    channel.typing(to, true).catch(() => {});
  }
}

// --- chat commands ---
const commands = {
  '/start': () => 'xapient bereit. /help für Befehle.',
  '/help': () => '/new – neue Session\n/stop – laufenden Job abbrechen + Queue leeren\n/status – Status',
  '/new': () => { state.sessionId = null; saveState(); return '🆕 Neue Session beim nächsten Auftrag.'; },
  '/stop': () => {
    queue.length = 0;
    if (!current) return 'Nichts läuft.';
    current.child.kill('SIGTERM');
    return `🛑 Abgebrochen (${current.origin}).`;
  },
  '/status': () => [
    `Session: ${state.sessionId ?? '–'}`,
    `Läuft: ${current ? `${current.origin} seit ${Math.round((Date.now() - current.started) / 1000)}s` : 'nein'}`,
    `Queue: ${queue.length}`,
  ].join('\n'),
};

function attachmentLines(atts = []) {
  return atts.map(a => `[Anhang: ${a.path} (${a.contentType ?? '?'}${a.filename ? `, ${a.filename}` : ''})]`);
}

async function onMessage(msg) {
  const text = msg.text.trim();
  const cmd = commands[text.split(/\s/)[0].toLowerCase().replace(/@\w+$/, '')];  // strip telegram /cmd@botname
  if (cmd) return channel.send(msg.from, cmd());
  const { transcripts, rest } = await transcriber.process(msg.attachments);  // voice/audio -> text, rest passed as attachment
  const body = [text, ...transcripts, ...attachmentLines(rest)].filter(Boolean).join('\n');
  if (!body) return;
  log(`${channel.name} message`, body.slice(0, 80));
  const ack = busy ? `message received! in queue (#${queue.length + 1})` : 'message received! working...';
  channel.send(msg.from, ack).catch(() => {});  // immediate receipt confirmation
  enqueue(() => ask(`[${channel.name} ${stamp()}] ${body}`, channel.name, msg.from));
}

// --- local http api: /send (agent -> you), /inject (cron -> agent) ---
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', d => { raw += d; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(e); } });
  });
}

function inject(name, prompt) {
  log('inject', name);
  enqueue(() => ask(`[cron:${name} ${stamp()}] ${prompt}`, `cron:${name}`));
}

const server = http.createServer(async (req, res) => {
  const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.headers['x-xapient-token'] !== cfg.http.token) return reply(401, { error: 'unauthorized' });
  try {
    const body = await readJson(req);
    if (req.method === 'POST' && req.url === '/send') {
      if (!body.text) return reply(400, { error: 'text missing' });
      await channel.send(owner, String(body.text));
      return reply(200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/inject') {
      if (!body.prompt) return reply(400, { error: 'prompt missing' });
      const name = String(body.name ?? 'manual').replace(/[^\w-]/g, '');
      inject(name, body.prompt);
      return reply(202, { queued: true, position: queue.length });
    }
    if (req.method === 'POST' && req.url === '/restart') {
      restartPending = true;
      if (!busy) setTimeout(() => { log('restart'); process.exit(0); }, 500);  // let the reply go out
      return reply(202, { restart: busy ? 'after current job' : 'now' });
    }
    reply(404, { error: 'not found' });
  } catch (e) { reply(500, { error: e.message }); }
});

server.listen(cfg.http.port, cfg.http.host, () => log(`http on ${cfg.http.host}:${cfg.http.port}`));
channel.listen(onMessage, id => owners.includes(String(id)));
startScheduler(cfg.claude.workspace, inject, log);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { current?.child.kill('SIGTERM'); process.exit(0); });
