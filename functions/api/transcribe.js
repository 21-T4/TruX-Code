'use strict';

// Speech to text for the composer's microphone button. The browser records a short clip and sends it
// here; a Gemini model on Vertex AI listens to it and returns the transcript as plain text.

const { verifyRequestUser } = require('../firebase-auth');
const { getVertexClient, isNetworkError, statusFor } = require('./chat');

// Uses the same fast, known-accessible model as the welcome headline. Override with TRANSCRIBE_MODEL
// to move to a newer Gemini model without a code change.
const TRANSCRIBE_MODEL = String(process.env.TRANSCRIBE_MODEL || 'gemini-3.8-flash').trim();

// Browser recorders produce webm (Chrome, Android, Firefox) or mp4 (Safari). Map each to a type Vertex accepts.
const AUDIO_TYPES = Object.freeze({
  'audio/webm': 'audio/webm',
  'audio/mp4': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/ogg': 'audio/opus',
  'audio/opus': 'audio/opus',
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/aac': 'audio/x-aac'
});

const MAX_AUDIO_CHARS = 5600000; // about 4 MB of audio once base64 encoded

const PROMPT = [
  'Transcribe the speech in this audio exactly as spoken, in the language spoken.',
  'Output only the transcript as plain text, with normal punctuation.',
  'No quotes, labels, timestamps, speaker names or commentary.',
  'If there is no intelligible speech, output nothing.'
].join(' ');

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_REQUEST';
  return error;
}

function readAudio(body) {
  const audio = body && body.audio;
  if (!audio || typeof audio.mimeType !== 'string' || typeof audio.data !== 'string') {
    throw invalid('Send a recorded audio clip to transcribe.');
  }
  const mimeType = AUDIO_TYPES[audio.mimeType.split(';')[0].trim().toLowerCase()];
  if (!mimeType) throw invalid('This browser recorded an audio format that cannot be transcribed.');
  const data = audio.data;
  if (!data || data.length > MAX_AUDIO_CHARS || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw invalid('The recording is invalid or too long. Record a shorter clip and retry.');
  }
  return { mimeType, data };
}

async function generate(client, params) {
  try {
    return await client.models.generateContent(params);
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return client.models.generateContent(params);
  }
}

async function transcribeHandler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    await verifyRequestUser(req);
    const { mimeType, data } = readAudio(req.body || {});

    const response = await generate(getVertexClient(), {
      model: TRANSCRIBE_MODEL,
      contents: [{ role: 'user', parts: [{ text: PROMPT }, { inlineData: { mimeType, data } }] }],
      config: {
        temperature: 0,
        maxOutputTokens: 4096,
        thinkingConfig: { thinkingLevel: 'LOW' }
      }
    });

    const candidate = response && Array.isArray(response.candidates) ? response.candidates[0] : null;
    const parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
    const text = parts
      .map((part) => part && typeof part.text === 'string' && !part.thought ? part.text : '')
      .join('')
      .trim();

    res.setHeader('Cache-Control', 'no-store');
    return res.json({ text });
  } catch (error) {
    const status = statusFor(error);
    console.error('TruX Code transcription failed:', error && (error.code || error.name), error && error.message);
    const message = status === 400
      ? error.message
      : status === 401
        ? 'Your sign-in expired. Sign in again and retry.'
        : status === 503
          ? 'Server configuration is incomplete. Check the private runtime configuration file.'
          : isNetworkError(error)
            ? 'Could not reach Vertex AI (network error). Retry in a moment.'
            : 'Transcription failed. Try again, or type your message instead.';
    return res.status(status).json({ error: message });
  }
}

module.exports = { transcribeHandler };
