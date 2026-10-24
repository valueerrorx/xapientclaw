// runs claude code headless (-p) with session resume, prompt via stdin.
// Uses stream-json output so the gateway can watch live activity (tools, subagents)
// via the optional onEvent callback. Falls back gracefully if the result event is missing.
import { spawn } from 'node:child_process';

export function runClaude(cfg, prompt, sessionId, extraEnv = {}, onEvent = null) {
  const c = cfg.claude;
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--max-turns', String(c.maxTurns ?? 150)];
  if (sessionId) args.push('--resume', sessionId);
  for (const d of c.addDirs) args.push('--add-dir', d);
  if (c.model) args.push('--model', c.model);

  const child = spawn(c.bin, args, {
    cwd: c.workspace,
    env: { ...process.env, PATH: `${cfg.binDir}:${process.env.PATH}`, ...extraEnv },  // bin/ tools visible to agent
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const done = new Promise((resolve, reject) => {
    let buf = '', err = '', resultEvt = null, sid = sessionId, lastText = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), (c.timeoutMin ?? 45) * 60_000);

    const handleLine = (line) => {
      const s = line.trim();
      if (!s) return;
      let evt;
      try { evt = JSON.parse(s); } catch { return; }  // ignore any non-JSON noise
      if (evt.session_id) sid = evt.session_id;
      if (evt.type === 'result') resultEvt = evt;
      if (evt.type === 'assistant' && evt.message?.content) {  // keep last assistant text as a fallback result
        const t = evt.message.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
        if (t) lastText = t;
      }
      if (onEvent) { try { onEvent(evt); } catch {} }
    };

    child.stdout.on('data', d => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (buf.trim()) handleLine(buf);  // flush trailing partial line
      if (resultEvt) {
        const j = resultEvt;
        const text = j.is_error ? `⚠️ ${j.subtype ?? 'error'}: ${j.result ?? ''}` : (j.result ?? lastText);
        return resolve({ text, sessionId: j.session_id ?? sid, cost: j.total_cost_usd, turns: j.num_turns });
      }
      if (lastText && !sig) return resolve({ text: lastText, sessionId: sid, cost: null, turns: null });  // fallback
      reject(new Error(sig ? `abgebrochen (${sig})` : `claude exit ${code}: ${(err || '').trim().slice(-500)}`));
    });
    child.stdin.end(prompt);
  });

  return { child, done };
}
