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

  // Send an OGG/Opus buffer as a voice note (multipart upload).
  async function sendVoice(to, oggBuffer, caption) {
    const fd = new FormData();
    fd.append('chat_id', String(to));
    if (caption) fd.append('caption', caption);
    fd.append('voice', new Blob([oggBuffer], { type: 'audio/ogg' }), 'voice.ogg');
    const res = await fetch(`${api}/sendVoice`, { method: 'POST', body: fd });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`telegram sendVoice: ${json.description ?? res.status}`);
    return json.result;
  }

  // Multipart call; caption goes as HTML first, plain on failure (like send()).
  async function upload(method, fields, files) {
    const post = async html => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        const val = typeof v === 'function' ? v(html) : v;
        fd.append(k, typeof val === 'string' ? val : JSON.stringify(val));
      }
      if (html && fields.caption) fd.append('parse_mode', 'HTML');
      for (const f of files) fd.append(f.field, new Blob([fs.readFileSync(f.path)]), path.basename(f.path));
      const res = await fetch(`${api}/${method}`, { method: 'POST', body: fd });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
      return json.result;
    };
    const hasCaption = fields.caption || fields.media?.(true)?.some(m => m.caption);
    if (!hasCaption) return post(false);
    try { return await post(true); } catch { return post(false); }
  }

  // Photo if telegram accepts it (<=10 MB, w+h<=10000, ratio<=20), else document.
  function photoOk(file) {
    if (fs.statSync(file).size > 10 * 1024 * 1024) return false;
    const d = imageSize(file);
    if (!d) return /\.(jpe?g|png|webp)$/i.test(file);  // unknown dims: let telegram decide
    return d.w + d.h <= 10000 && Math.max(d.w, d.h) / Math.min(d.w, d.h) <= 20;
  }

  // One group = 1 file (sendPhoto/sendDocument) or 2..10 (sendMediaGroup).
  async function sendGroup(to, type, group, caption) {
    if (group.length === 1) {
      const method = type === 'photo' ? 'sendPhoto' : 'sendDocument';
      return upload(method, { chat_id: String(to), caption }, [{ field: type, path: group[0] }]);
    }
    const media = html => group.map((p, i) => ({
      type, media: `attach://f${i}`,
      ...(i === 0 && caption ? { caption, ...(html ? { parse_mode: 'HTML' } : {}) } : {}),
    }));
    return upload('sendMediaGroup', { chat_id: String(to), media }, group.map((p, i) => ({ field: `f${i}`, path: p })));
  }

  // Send images: photos as albums of 10, oversize ones as documents; caption on the first message.
  async function sendPhotos(to, paths, caption) {
    if (caption && caption.length > 1024) { await send(to, caption); caption = undefined; }  // caption limit
    const photos = paths.filter(photoOk);
    const docs = paths.filter(p => !photos.includes(p));
    const groups = [];
    for (const [type, list] of [['photo', photos], ['document', docs]])
      for (let i = 0; i < list.length; i += 10) groups.push([type, list.slice(i, i + 10)]);
    for (const [type, group] of groups) {
      try { await sendGroup(to, type, group, caption); }
      catch (e) {
        if (type !== 'photo') throw e;
        log('telegram: photo rejected, sending as document:', e.message);
        await sendGroup(to, 'document', group, caption);
      }
      caption = undefined;
    }
  }

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

  return { name: 'telegram', send, sendVoice, sendPhotos, typing, typingEveryMs: 4000, listen };
}

// Width/height from PNG or JPEG header, null if unknown.
function imageSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    if (n >= 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
      for (let i = 2; i + 9 < n;) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
    return null;
  } finally { fs.closeSync(fd); }
}
