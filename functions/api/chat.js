'use strict';

const { GoogleGenAI } = require('@google/genai');
const admin = require('firebase-admin');
const runtimeConfig = require('../../config/runtime-config.json');

const MODELS = Object.freeze({
  'gemini-4-argon': 'gemini-4-argon',
  'gemini-3.1-pro-preview': 'gemini-3.1-pro-preview',
  'gemini-3.8-flash': 'gemini-3.8-flash'
});

const THINKING_LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH']);
let vertexClient;

function getFirebaseAuth() {
  const projectId = runtimeConfig.firebase.projectId;
  if (!projectId) {
    const error = new Error('Firebase project is not configured.');
    error.code = 'CONFIG_MISSING';
    throw error;
  }

  if (admin.apps.length === 0) {
    // On Cloud Run, Firebase Admin uses Application Default Credentials.
    // No service-account JSON key is required.
    admin.initializeApp({ projectId });
  }

  return admin.auth();
}

function getVertexClient() {
  const project = runtimeConfig.googleCloud.projectId;
  if (!project) {
    const error = new Error('GOOGLE_CLOUD_PROJECT is not configured.');
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

async function requireSignedInUser(req) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const error = new Error('Sign in to use TruX Code.');
    error.code = 'auth/missing-token';
    throw error;
  }

  return getFirebaseAuth().verifyIdToken(match[1]);
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

  try {
    await requireSignedInUser(req);

    const body = req.body || {};
    const isGreeting = body.kind === 'greeting';
    const selectedModel = isGreeting ? 'gemini-3.5-flash-lite' : body.model;
    const model = isGreeting ? selectedModel : MODELS[selectedModel];

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

    for await (const chunk of stream) {
      if (res.destroyed) break;
      const text = typeof chunk.text === 'string' ? chunk.text : '';
      if (text) sendNdjson(res, { type: 'delta', text });
    }

    if (!res.destroyed) {
      sendNdjson(res, { type: 'done' });
      res.end();
    }
  } catch (error) {
    const status = statusFor(error);
    console.error('TruX Code request failed:', error && (error.code || error.name), error && error.message);

    if (streamStarted && !res.destroyed) {
      sendNdjson(res, {
        type: 'error',
        error: status === 401
          ? 'Your sign-in expired. Sign in again and retry.'
          : status === 503
            ? 'Server configuration is incomplete. Check config/runtime-config.json.'
            : 'The model request failed. Check Vertex AI access, billing, and model availability.'
      });
      res.end();
      return;
    }

    if (!res.headersSent) {
      const message = status === 401
        ? 'Sign in to use TruX Code.'
        : status === 503
          ? 'Server configuration is incomplete. Check config/runtime-config.json.'
          : status === 400
            ? error.message
            : 'The model request failed. Check Vertex AI access, billing, and model availability.';
      return res.status(status).json({ error: message });
    }
  }
}

module.exports = { chatHandler };
