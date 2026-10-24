// signal-cli JSON-RPC (http daemon) client: send, typing, SSE event stream
import path from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_CHUNK = 3500;  // keep messages readable on phone

export function createSignal({ rpcUrl, account, attachmentsDir }, log) {
  let id = 0;

  async function rpc(method, params = {}) {
    const res = await fetch(`${rpcUrl}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: { account, ...params } }),
    });
    const json = await res.json().catch(() => ({}));
    if (json.error) throw new Error(`signal ${method}: ${json.error.message}`);
    return json.result;
  }

  function chunks(text) {
    const out = [];
    let rest = text;
    while (rest.length > MAX_CHUNK) {
      let cut = rest.lastIndexOf('\n', MAX_CHUNK);  // prefer line break
      if (cut < MAX_CHUNK / 2) cut = MAX_CHUNK;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n/, '');
    }
    if (rest) out.push(rest);
    return out;
  }

  async function send(to, text) {
    for (const part of chunks(text)) await rpc('send', { recipient: [to], message: part });
  }

  const typing = (to, stop = false) => rpc('sendTyping', { recipient: [to], stop });

  function normalize(env) {
    const m = env.dataMessage;
    if (!m || m.groupInfo || m.groupV2) return null;  // direct messages only
    return {
      from: env.sourceNumber ?? env.sourceUuid ?? env.source,
      name: env.sourceName,
      text: m.message ?? '',
      attachments: (m.attachments ?? []).map(a => ({ path: path.join(attachmentsDir, a.id), contentType: a.contentType, filename: a.filename })),
      alt: env.sourceUuid,
    };
  }

  async function listen(onMessage, allow) {
    for (;;) {  // reconnect loop
      try {
        const res = await fetch(`${rpcUrl}/api/v1/events`, { headers: { Accept: 'text/event-stream' } });
        if (!res.ok) throw new Error(`events http ${res.status}`);
        log('signal: connected to event stream');
        const dec = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true }).replace(/\r/g, '');
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
            if (!data) continue;
            try {
              const ev = JSON.parse(data);
              const p = ev.params ?? ev;  // plain event or jsonrpc notification
              if (!p.envelope || (p.account && p.account !== account)) continue;
              const msg = normalize(p.envelope);
              if (!msg) continue;
              if (!allow(msg.from) && !allow(msg.alt)) { log('ignored message from', msg.from); continue; }
              await onMessage(msg);
            } catch (e) { log('signal: bad event', e.message); }
          }
        }
        log('signal: event stream closed');
      } catch (e) { log('signal:', e.message); }
      await sleep(3000);
    }
  }

  return { name: 'signal', rpc, send, typing, typingEveryMs: 10_000, listen };
}
