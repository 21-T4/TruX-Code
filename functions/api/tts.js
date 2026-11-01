'use strict';

// Read aloud for the message action bar. The browser sends a short piece of reply text; a Gemini
// text-to-speech model on Vertex AI turns it into speech, which goes back as a WAV file.

const { verifyRequestUser } = require('../firebase-auth');
const { getVertexClient, isNetworkError, statusFor } = require('./chat');

// Newest Gemini TTS model first. If the project has no access to it, the next one is tried.
// Set TTS_MODEL to pin a model; set TTS_VOICE to change the default voice.
const MODEL_CHAIN = Array.from(new Set([
  String(process.env.TTS_MODEL || 'gemini-3.8-flash-tts').trim(),
  'gemini-3.8-flash-lite-tts',
  'gemini-3.1-flash-tts-preview'
].filter(Boolean)));

const VOICES = new Set([
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'
]);
const DEFAULT_VOICE = VOICES.has(process.env.TTS_VOICE) ? process.env.TTS_VOICE : 'Kore';
const MAX_CHARS = 4000;

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_REQUEST';
  return error;
}

// Gemini returns raw 16-bit mono PCM (usually 24 kHz). Browsers cannot play that directly, so add a WAV header.
function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function audioFrom(response) {
  const candidate = response && Array.isArray(response.candidates) ? response.candidates[0] : null;
  const parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  const part = parts.find((item) => item && item.inlineData && item.inlineData.data);
  if (!part) return null;

  const mimeType = String(part.inlineData.mimeType || 'audio/L16;codec=pcm;rate=24000');
  const bytes = Buffer.from(part.inlineData.data, 'base64');
  if (/^audio\/(wav|x-wav|mpeg|mp3|ogg|webm)/i.test(mimeType)) {
    return { bytes, type: mimeType.split(';')[0].toLowerCase() };
  }
  const rate = Number((/rate=(\d+)/i.exec(mimeType) || [])[1]) || 24000;
  return { bytes: pcmToWav(bytes, rate), type: 'audio/wav' };
}

function modelUnavailable(error) {
  return /404|not found|unknown model|publisher model|permission_denied|403/i.test(
    String(error && error.code || '') + ' ' + String(error && error.message || '')
  );
}

async function synthesize(client, text, voice) {
  let lastError;
  for (const model of MODEL_CHAIN) {
    const params = {
      model,
      contents: [{ role: 'user', parts: [{ text }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
      }
    };
    try {
      let response;
      try {
        response = await client.models.generateContent(params);
      } catch (error) {
        if (!isNetworkError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 400));
        response = await client.models.generateContent(params);
      }
      const audio = audioFrom(response);
      if (audio) return audio;
      lastError = new Error('The speech model returned no audio.');
    } catch (error) {
      lastError = error;
      if (!modelUnavailable(error)) throw error;
      console.warn('TTS model unavailable, trying the next one:', model);
    }
  }
  throw lastError || new Error('No speech model is available.');
}

async function ttsHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  try {
    await verifyRequestUser(req);
    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw invalid('There is no text to read aloud.');
    if (text.length > MAX_CHARS) throw invalid('That passage is too long to read in one piece.');
    const voice = VOICES.has(body.voice) ? body.voice : DEFAULT_VOICE;

    const audio = await synthesize(getVertexClient(), text, voice);
    res.setHeader('Cache-Control', 'no-store');
    res.type(audio.type);
    return res.send(audio.bytes);
  } catch (error) {
    const status = statusFor(error);
    console.error('TruX Code read-aloud failed:', error && (error.code || error.name), error && error.message);
    const detail = String(error && (error.code || '') + ' ' + (error && error.message || ''));
    const message = status === 400
      ? error.message
      : status === 401
        ? 'Your sign-in expired. Sign in again and retry.'
        : status === 503
          ? 'Server configuration is incomplete. Check the private runtime configuration file.'
          : /429|resource_exhausted|quota/i.test(detail)
            ? 'The speech model is rate limited right now. Try again in a moment.'
            : isNetworkError(error)
              ? 'Could not reach Vertex AI (network error). Retry in a moment.'
              : 'Read aloud failed. Check that the Gemini TTS model is available to this project.';
    return res.status(status).json({ error: message });
  }
}

module.exports = { ttsHandler, pcmToWav };
