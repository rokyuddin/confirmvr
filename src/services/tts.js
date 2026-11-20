'use strict';
/**
 * Bangla TTS via Azure Speech (bn-BD-NabanitaNeural / bn-BD-PradeepNeural).
 * Free tier: 0.5M characters per month.
 *
 * Every synthesized clip is cached in the DB by hash(voice + format + text) and served at
 * GET /tts/:hash, so the same text (static menu lines, a product+price that repeats)
 * is synthesized only once, ever. Works on Vercel (no local disk needed).
 *
 * resolveScript() turns {type:'tts'} prompts into {type:'audio', url} prompts. If Azure
 * is not configured or fails, prompts stay as text and the voice provider synthesizes them.
 */
const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');

const enabled = () => Boolean(config.azureSpeechKey && config.azureSpeechRegion);
const mimeFor = (fmt) => (/mp3/.test(fmt) ? 'audio/mpeg' : /riff|wav/.test(fmt) ? 'audio/wav' : 'application/octet-stream');
const extFor = (fmt) => (/mp3/.test(fmt) ? 'mp3' : /riff|wav/.test(fmt) ? 'wav' : 'bin');

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

function ssml(text, voice = config.ttsVoice) {
  return `<speak version="1.0" xml:lang="bn-BD"><voice name="${xmlEscape(voice)}"><prosody rate="-5%">${xmlEscape(text)}</prosody></voice></speak>`;
}

function hashFor(text, voice = config.ttsVoice, fmt = config.ttsFormat) {
  return crypto.createHash('sha256').update(`${voice}|${fmt}|${text}`).digest('hex').slice(0, 32);
}

async function azureSynthesize(text, fetchImpl = fetch) {
  const res = await fetchImpl(`https://${config.azureSpeechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': config.azureSpeechKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': config.ttsFormat,
      'User-Agent': 'confirm-call',
    },
    body: ssml(text),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Azure TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Returns the public URL of the clip for `text`, synthesizing + caching on first use. */
async function audioUrlFor(text, { fetchImpl } = {}) {
  const hash = hashFor(text);
  const url = `${config.baseUrl}/tts/${hash}.${extFor(config.ttsFormat)}`;
  if (await db.one('SELECT 1 AS x FROM tts_cache WHERE hash=?', [hash])) return url;
  const audio = await azureSynthesize(text, fetchImpl);
  await db.run('INSERT INTO tts_cache (hash, mime, audio_b64, text, created_at) VALUES (?,?,?,?,?)',
    [hash, mimeFor(config.ttsFormat), audio.toString('base64'), text.slice(0, 500), db.now()])
    .catch((e) => { if (!/unique|duplicate|constraint/i.test(e.message)) throw e; }); // concurrent first use
  return url;
}

async function resolvePrompt(p, opts) {
  if (!p || p.type !== 'tts') return p;
  try {
    return { type: 'audio', url: await audioUrlFor(p.text, opts), text: p.text };
  } catch (e) {
    console.error('[tts]', e.message);
    return p; // provider-side TTS fallback
  }
}

/** Replace text prompts in an IVR script with cached Azure audio. No-op when disabled. */
async function resolveScript(script, opts) {
  if (!enabled()) return script;
  const prompts = [];
  for (const p of script.prompts) prompts.push(await resolvePrompt(p, opts));
  const onDigit = {};
  for (const [k, v] of Object.entries(script.onDigit || {})) onDigit[k] = { ...v, prompt: await resolvePrompt(v.prompt, opts) };
  return { ...script, prompts, onDigit };
}

async function getClip(hash) {
  const row = await db.one('SELECT mime, audio_b64 FROM tts_cache WHERE hash=?', [hash]);
  return row ? { mime: row.mime, audio: Buffer.from(row.audio_b64, 'base64') } : null;
}

module.exports = { enabled, resolveScript, audioUrlFor, getClip, hashFor, ssml };
