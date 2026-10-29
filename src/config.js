// config loader, resolves ~ and relative paths against project root
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const expand = p => path.resolve(ROOT, p.replace(/^~(?=$|\/)/, os.homedir()));  // ~ and relative -> absolute

export function loadConfig() {
  const file = process.env.XAPIENT_CONFIG ?? path.join(ROOT, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.claude.workspace = expand(cfg.claude.workspace ?? 'workspace');
  cfg.claude.addDirs = (cfg.claude.addDirs ?? []).map(expand);
  cfg.channel ??= 'telegram';
  if (cfg.signal) cfg.signal.attachmentsDir = expand(cfg.signal.attachmentsDir ?? '~/.local/share/signal-cli/attachments');
  if (cfg.telegram) cfg.telegram.inboxDir = expand(cfg.telegram.inboxDir ?? path.join(cfg.claude.workspace, 'inbox'));
  cfg.stateFile = expand(cfg.stateFile ?? 'state.json');
  cfg.tts = {  // local pocket-tts voice service (see ~/tts/server.py); defaults work without config.json entry
    url: cfg.tts?.url ?? 'http://127.0.0.1:8765',
    enabled: cfg.tts?.enabled ?? true,
    timeoutMs: cfg.tts?.timeoutMs ?? 90000,
    maxChars: cfg.tts?.maxChars ?? 600,  // longer replies: speak a lead-in, full text still goes as message
  };
  if (cfg.transcription) {
    if (cfg.transcription.whisperCli) cfg.transcription.whisperCli = expand(cfg.transcription.whisperCli);
    if (cfg.transcription.model) cfg.transcription.model = expand(cfg.transcription.model);
  }
  cfg.binDir = path.join(ROOT, 'bin');
  return cfg;
}
