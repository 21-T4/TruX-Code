'use strict';

const { GoogleGenAI } = require('@google/genai');
const runtimeConfig = require('../../config/runtime-config.json');
const { verifyRequestUser } = require('../firebase-auth');

const MODELS = Object.freeze({
  'gemini-4-argon': 'gemini-4-argon',
  'gemini-3.1-pro-preview': 'gemini-3.1-pro-preview',
  'gemini-3.8-flash': 'gemini-3.8-flash'
});

const THINKING_LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH']);
let vertexClient;

function getVertexClient() {
  const project = runtimeConfig.googleCloud.projectId;
  if (!project) {
    const error = new Error('Google Cloud project ID is missing from config/runtime-config.json.');
    error.code = 'CONFIG_MISSING';
    throw error;
  }

  if (!vertexClient) {
    vertexClient = new GoogleGenAI({
      vertexai: true,
      project,
      location: runtimeConfig.googleCloud.location
    });
  }

  return vertexClient;
}

function normalizeMessages(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 40) {
    throw new Error('Send between 1 and 40 messages.');
  }

  const messages = input.map((message) => {
    if (!message || !['user', 'assistant'].includes(message.role)) {
      throw new Error('The conversation contains an invalid message.');
    }

    if (typeof message.content !== 'string') {
      throw new Error('Message content must be text.');
    }

    const content = message.content.trim();
    if (!content || content.length > 40000) {
      throw new Error('Each message must contain 1 to 40,000 characters.');
    }

    return {
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: content }]
    };
  });

  if (messages[messages.length - 1].role !== 'user') {
    throw new Error('The latest message must be from the user.');
  }

  return messages;
}

function extractChunkText(chunk) {
  try {
    if (chunk && typeof chunk.text === 'string' && chunk.text.length) return chunk.text;
  } catch {
    // Some non-text candidate shapes do not expose a text convenience accessor.
  }

  const candidates = chunk && Array.isArray(chunk.candidates) ? chunk.candidates : [];
  return candidates
    .flatMap((candidate) => candidate && candidate.content && Array.isArray(candidate.content.parts)
      ? candidate.content.parts
      : [])
    .map((part) => part && typeof part.text === 'string' ? part.text : '')
    .join('');
}

function publicFailureMessage(error, status, model) {
  if (status === 401) return 'Your sign-in expired. Sign in again and retry.';
  if (status === 503) return 'Server configuration is incomplete. Check the private runtime configuration file.';

  const code = String(error && error.code || '').toLowerCase();
  const detail = String(error && error.message || '').toLowerCase();
  const combined = code + ' ' + detail;

  if (/429|resource_exhausted|quota|rate.?limit/.test(combined)) {
    return 'Vertex AI quota or rate limit was reached. Check project billing and model quota, then retry.';
  }
  if (/403|permission_denied|permission denied|forbidden|iam/.test(combined)) {
    return 'Cloud Run is not authorized to use this Vertex AI model. Check the service identity permissions and model access.';
  }
  if (/404|not found|unknown model|model not found|publisher model/.test(combined)) {
    return 'The selected model (' + model + ') is not available to this project or location. Verify Vertex AI model access and location.';
  }
  if (/deadline|timed out|timeout|unavailable|503/.test(combined)) {
    return 'Vertex AI did not finish the request. Check service availability and retry.';
  }
  if (/invalid argument|invalid_argument|thinking.?level|thinkingconfig|unsupported parameter/.test(combined)) {
    return 'Vertex AI rejected the request configuration. Check the selected model and thinking level.';
  }

  return 'Vertex AI request failed (' + String(error && (error.code || error.name) || 'unknown error') +
    ') for model ' + model + '. Check the Cloud Run logs for the underlying error.';
}

function sendNdjson(res, data) {
  if (!res.destroyed) {
    res.write(JSON.stringify(data) + '\n');
  }
}

function statusFor(error) {
  if (error && typeof error.code === 'string' && error.code.startsWith('auth/')) {
    return 401;
  }
  if (error && error.code === 'CONFIG_MISSING') {
    return 503;
  }
  if (error instanceof SyntaxError) {
    return 400;
  }
  return 500;
}

async function chatHandler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  let streamStarted = false;
  let requestedModel = 'unknown';

  try {
    await verifyRequestUser(req);

    const body = req.body || {};
    const isGreeting = body.kind === 'greeting';
    const selectedModel = isGreeting ? 'gemini-3.5-flash-lite' : body.model;
    const model = isGreeting ? selectedModel : MODELS[selectedModel];
    requestedModel = model || selectedModel || 'unknown';

    if (!model) {
      return res.status(400).json({ error: 'Choose a supported model.' });
    }

    const thinkingLevel = isGreeting
      ? 'LOW'
      : String(body.thinkingLevel || 'MEDIUM').toUpperCase();

    if (!THINKING_LEVELS.has(thinkingLevel)) {
      return res.status(400).json({ error: 'Thinking level must be Low, Medium, or High.' });
    }

    const contents = isGreeting
      ? [{
          role: 'user',
          parts: [{
            text: 'Write one brief, friendly, original welcome sentence for a clean coding workspace. Address the user naturally. No markdown, quotes, lists, or extra explanation. Keep it under 14 words.'
          }]
        }]
      : normalizeMessages(body.messages);

    const client = getVertexClient();
    const stream = await client.models.generateContentStream({
      model,
      contents,
      config: {
        systemInstruction: [
          'You are TruX Code, a clear and capable software engineering assistant.',
          'Help users understand, design, write, debug, and improve software.',
          'Prefer correct, practical answers. State assumptions when needed.',
          'When sharing code, include complete, usable snippets and explain important risks.',
          'Do not claim to have changed a repository, run commands, or deployed software unless a tool actually did that.',
          'Never reveal private internal reasoning; provide concise explanations and useful conclusions.'
        ].join(' '),
        thinkingConfig: { thinkingLevel },
        maxOutputTokens: isGreeting ? 100 : 8192
      }
    });

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    streamStarted = true;

    let outputCharacters = 0;
    for await (const chunk of stream) {
      if (res.destroyed) break;
      const text = extractChunkText(chunk);
      if (text) {
        outputCharacters += text.length;
        sendNdjson(res, { type: 'delta', text });
      }
    }

    if (!res.destroyed) {
      if (outputCharacters === 0) {
        sendNdjson(res, {
          type: 'error',
          error: 'Vertex AI completed the request but returned no text for model ' + model +
            '. Verify model access and check the Cloud Run logs.'
        });
      } else {
        sendNdjson(res, { type: 'done' });
      }
      res.end();
    }
  } catch (error) {
    const status = statusFor(error);
    console.error('TruX Code request failed:', error && (error.code || error.name), error && error.message);

    const message = publicFailureMessage(error, status, requestedModel);

    if (streamStarted && !res.destroyed) {
      sendNdjson(res, { type: 'error', error: message });
      res.end();
      return;
    }

    if (!res.headersSent) {
      const responseMessage = status === 400
        ? (error && error.message ? error.message : 'The request body is invalid.')
        : message;
      return res.status(status).json({ error: responseMessage });
    }
  }
}

module.exports = { chatHandler };
