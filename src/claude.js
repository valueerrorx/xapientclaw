// runs claude code headless (-p) with session resume, prompt via stdin
import { spawn } from 'node:child_process';

export function runClaude(cfg, prompt, sessionId, extraEnv = {}) {
  const c = cfg.claude;
  const args = ['-p', '--output-format', 'json', '--max-turns', String(c.maxTurns ?? 150)];
  if (sessionId) args.push('--resume', sessionId);
  for (const d of c.addDirs) args.push('--add-dir', d);
  if (c.model) args.push('--model', c.model);

  const child = spawn(c.bin, args, {
    cwd: c.workspace,
    env: { ...process.env, PATH: `${cfg.binDir}:${process.env.PATH}`, ...extraEnv },  // bin/ tools visible to agent
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const done = new Promise((resolve, reject) => {
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), (c.timeoutMin ?? 45) * 60_000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      let json;
      try { json = JSON.parse(out.trim().split('\n').pop()); } catch {
        return reject(new Error(sig ? `abgebrochen (${sig})` : `claude exit ${code}: ${(err || out).trim().slice(-500)}`));
      }
      const text = json.is_error ? `⚠️ ${json.subtype ?? 'error'}: ${json.result ?? ''}` : (json.result ?? '');
      resolve({ text, sessionId: json.session_id, cost: json.total_cost_usd, turns: json.num_turns });
    });
    child.stdin.end(prompt);
  });

  return { child, done };
}
