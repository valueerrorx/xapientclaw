// local speech-to-text for voice/audio attachments: ffmpeg -> 16 kHz mono wav -> whisper-cli
// self-disabling: if whisper-cli or the model is missing, attachments pass through untouched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const AUDIO_TYPE = /^audio\//i;
const AUDIO_EXT = /\.(ogg|oga|opus|mp3|m4a|aac|wav|flac|amr|webm|wma)$/i;

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(bin)} exit ${code}: ${err.trim().slice(-300)}`));
    });
  });
}

export function createTranscriber(cfg = {}, log = () => {}) {
  const enabled = cfg.enabled !== false;
  const whisper = cfg.whisperCli;
  const model = cfg.model;
  const ffmpeg = cfg.ffmpeg ?? 'ffmpeg';
  const language = cfg.language ?? 'de';
  const threads = cfg.threads ?? 4;
  const timeoutMs = (cfg.timeoutSec ?? 180) * 1000;
  const ready = enabled && !!whisper && !!model && fs.existsSync(whisper) && fs.existsSync(model);
  if (enabled && !ready) log('transcribe: disabled (whisper-cli or model not found) – audio passed through');
  else if (ready) log(`transcribe: ready (${path.basename(model)}, lang=${language})`);

  const isAudio = att =>
    AUDIO_TYPE.test(att.contentType ?? '') || AUDIO_EXT.test(att.filename ?? '') || AUDIO_EXT.test(att.path ?? '');

  async function transcribe(att) {
    const base = path.join(os.tmpdir(), `xapient-stt-${process.pid}-${Date.now()}`);
    const wav = `${base}.wav`;
    const txt = `${base}.txt`;
    try {
      await run(ffmpeg, ['-y', '-nostdin', '-i', att.path, '-ar', '16000', '-ac', '1', '-f', 'wav', wav], timeoutMs);
      const stdout = await run(
        whisper,
        ['-m', model, '-f', wav, '-l', language, '-t', String(threads), '-nt', '-np', '-otxt', '-of', base],
        timeoutMs,
      );
      let text = '';
      try { text = fs.readFileSync(txt, 'utf8'); } catch { text = stdout; }  // -otxt file, else stdout
      return text.replace(/\s+/g, ' ').trim();
    } finally {
      for (const f of [wav, txt]) { try { fs.unlinkSync(f); } catch {} }
    }
  }

  // -> { transcripts: string[], rest: attachment[] }  (rest = non-audio + anything that failed)
  async function process(attachments = []) {
    const transcripts = [], rest = [];
    for (const att of attachments) {
      if (ready && isAudio(att)) {
        try {
          const t = await transcribe(att);
          if (t) { log('transcribe: ok', JSON.stringify(t.slice(0, 60))); transcripts.push(t); continue; }
          log('transcribe: empty result, passing original');
        } catch (e) { log('transcribe: failed, passing original –', e.message); }
      }
      rest.push(att);
    }
    return { transcripts, rest };
  }

  return { ready, isAudio, transcribe, process };
}
