// telegram bot api client: long polling, send, typing, file download
import fs from 'node:fs';
import path from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_CHUNK = 4000;  // telegram limit is 4096

export function createTelegram({ token, inboxDir, apiUrl = 'https://api.telegram.org' }, log) {
  const api = `${apiUrl}/bot${token}`;

  async function call(method, params = {}) {
    const res = await fetch(`${api}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
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
    for (const part of chunks(text)) {
      try {
        await call('sendMessage', { chat_id: to, text: part, parse_mode: 'HTML' });  // <b>, <code>, <pre> tables
      } catch {
        await call('sendMessage', { chat_id: to, text: part });  // fallback: plain text so delivery never fails
      }
    }
  }

  const typing = (to, stop = false) => stop ? Promise.resolve() : call('sendChatAction', { chat_id: to, action: 'typing' });

  async function download(fileId, name) {
    const f = await call('getFile', { file_id: fileId });
    const res = await fetch(`${apiUrl}/file/bot${token}/${f.file_path}`);
    if (!res.ok) throw new Error(`download ${res.status}`);
    fs.mkdirSync(inboxDir, { recursive: true });
    const file = path.join(inboxDir, `${Date.now()}-${(name ?? path.basename(f.file_path)).replace(/[^\w.-]/g, '_')}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return file;
  }

  async function attachments(m) {
    const list = [];
    if (m.document) list.push({ id: m.document.file_id, name: m.document.file_name, type: m.document.mime_type });
    if (m.photo) list.push({ id: m.photo.at(-1).file_id, name: 'photo.jpg', type: 'image/jpeg' });  // largest size
    if (m.voice) list.push({ id: m.voice.file_id, name: 'voice.ogg', type: m.voice.mime_type });
    if (m.audio) list.push({ id: m.audio.file_id, name: m.audio.file_name, type: m.audio.mime_type });
    if (m.video) list.push({ id: m.video.file_id, name: m.video.file_name ?? 'video.mp4', type: m.video.mime_type });
    const out = [];
    for (const a of list) {
      try { out.push({ path: await download(a.id, a.name), contentType: a.type, filename: a.name }); }
      catch (e) { log('telegram: attachment failed', e.message); }
    }
    return out;
  }

  async function listen(onMessage, allow) {
    let offset = 0;
    for (;;) {  // long polling loop
      try {
        const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
        for (const u of updates) {
          offset = u.update_id + 1;
          const m = u.message;
          if (!m || m.chat.type !== 'private') continue;  // direct chats only
          if (!allow(String(m.from.id))) { log('ignored message from', m.from.id, m.from.username ?? ''); continue; }  // before any download
          await onMessage({
            from: String(m.from.id),
            name: m.from.username ?? m.from.first_name,
            text: m.text ?? m.caption ?? '',
            attachments: await attachments(m),
          });
        }
      } catch (e) { log('telegram:', e.message); await sleep(3000); }
    }
  }

  return { name: 'telegram', send, typing, typingEveryMs: 4000, listen };
}
