// src/session.js — persistent Claude Code session.
// Keeps ONE long-lived `claude -p --input-format stream-json` child alive with an
// open stdin, so the agent stays "awake" between turns: subagents survive, no
// per-turn memory reload. Each incoming message is written as one stream-json user
// message; the matching `result` event resolves that turn. The gateway's serial
// queue guarantees only one turn is in flight at a time.
//
// Resilience: if the child dies (crash, hung-turn kill), it is respawned on the next
// ask with `--resume <sessionId>` so the conversation continues. If persistent mode
// can't even come up, start() rejects and the gateway falls back to per-turn `-p`.
import { spawn } from 'node:child_process';

export function createSession(cfg, onEvent = null, initialSessionId = null) {
  const c = cfg.claude;
  let child = null;
  let sessionId = initialSessionId;  // learned from events; used to --resume after a crash
  let pending = null;                // the single in-flight turn
  let buf = '';

  function handleLine(line) {
    const s = line.trim(); if (!s) return;
    let evt; try { evt = JSON.parse(s); } catch { return; }  // ignore non-JSON noise
    if (evt.session_id) sessionId = evt.session_id;
    if (onEvent) { try { onEvent(evt); } catch {} }
    if (!pending) return;
    if (evt.type === 'assistant' && evt.message?.content) {
      const t = evt.message.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      if (t) pending.lastText = t;
    }
    if (evt.type === 'result') {
      const p = pending; pending = null;
      clearTimeout(p.timer);
      const text = evt.is_error ? `⚠️ ${evt.subtype ?? 'error'}: ${evt.result ?? ''}` : (evt.result ?? p.lastText);
      p.resolve({ text, sessionId: evt.session_id ?? sessionId, cost: evt.total_cost_usd, turns: evt.num_turns });
    }
  }

  function spawnChild() {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--max-turns', String(c.maxTurns ?? 150)];
    if (sessionId) args.push('--resume', sessionId);
    for (const d of c.addDirs) args.push('--add-dir', d);
    if (c.model) args.push('--model', c.model);
    buf = '';
    const ch = spawn(c.bin, args, {
      cwd: c.workspace,
      env: { ...process.env, PATH: `${cfg.binDir}:${process.env.PATH}` },  // bin/ tools visible
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    ch.stdout.on('data', d => {
      buf += d; let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    });
    ch.stderr.on('data', () => {});
    ch.on('error', () => { if (child === ch) child = null; });
    ch.on('close', () => {
      if (child === ch) child = null;
      if (pending) { const p = pending; pending = null; clearTimeout(p.timer); p.reject(new Error('session ended mid-turn')); }
    });
    return ch;
  }

  // Bring the child up. In stream-json input mode claude emits nothing until it gets a
  // message, so "ready" = the process survived a short grace (a bad binary/flags exits
  // immediately -> reject so the gateway falls back to per-turn -p).
  function start() {
    if (!child) child = spawnChild();
    const ch = child;
    return new Promise((resolve, reject) => {
      const onFail = () => { clearTimeout(grace); reject(new Error('session failed to start')); };
      const grace = setTimeout(() => {
        ch.removeListener('error', onFail); ch.removeListener('close', onFail);
        (ch.exitCode === null && !ch.killed) ? resolve() : reject(new Error('session not alive'));
      }, 2500);
      ch.once('error', onFail);
      ch.once('close', onFail);
    });
  }

  function ask(prompt) {
    return new Promise((resolve, reject) => {
      if (pending) return reject(new Error('session busy'));  // serial queue should prevent this
      try { if (!child) child = spawnChild(); } catch (e) { return reject(e); }
      const timer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch {} },  // hung turn -> abort+respawn next ask
        (c.timeoutMin ?? 45) * 60_000);
      pending = { resolve, reject, lastText: '', timer };
      const msg = { type: 'user', message: { role: 'user', content: prompt } };
      try { child.stdin.write(JSON.stringify(msg) + '\n'); }
      catch (e) { pending = null; clearTimeout(timer); reject(e); }
    });
  }

  function reset() {           // /new: drop the conversation, next ask starts fresh
    sessionId = null;
    try { child?.kill('SIGTERM'); } catch {}
    child = null;
  }

  return {
    start, ask, reset,
    getChild: () => child,
    kill: () => { try { child?.kill('SIGTERM'); } catch {} },
    get sessionId() { return sessionId; },
  };
}
