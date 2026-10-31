'use strict';

const { GoogleGenAI } = require('@google/genai');
const { verifyRequestUser } = require('../firebase-auth');
const plugins = require('../composio');

const MODELS = Object.freeze({
  'gemini-4-argon': 'gemini-4-argon',
  'gemini-3.1-pro-preview': 'gemini-3.1-pro-preview',
  'gemini-3.8-flash': 'gemini-3.8-flash'
});

const THINKING_LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH']);
// Upper bound on model -> plugin tool -> model round trips within one reply.
const MAX_TOOL_ROUNDS = 8;
let vertexClient;

function getVertexClient() {
  const project = String(process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || '').trim();
  const location = String(process.env.VERTEX_AI_LOCATION || 'global').trim();
  if (!project) {
    const error = new Error('Google Cloud project ID is missing from the TruX Code environment file.');
    error.code = 'CONFIG_MISSING';
    throw error;
  }

  if (!vertexClient) {
    vertexClient = new GoogleGenAI({
      vertexai: true,
      project,
      location
    });
  }

  return vertexClient;
}

function invalidRequest(message) {
  const error = new Error(message);
  error.code = 'INVALID_REQUEST';
  return error;
}

function normalizeMessages(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 40) {
    throw invalidRequest('Send between 1 and 40 messages.');
  }

  let totalAttachmentChars = 0;
  const messages = input.map((message) => {
    if (!message || !['user', 'assistant'].includes(message.role)) {
      throw invalidRequest('The conversation contains an invalid message.');
    }
    if (typeof message.content !== 'string') {
      throw invalidRequest('Message content must be text.');
    }

    const content = message.content.trim();
    const attachments = message.attachments === undefined ? [] : message.attachments;
    if (!Array.isArray(attachments) || attachments.length > 4) {
      throw invalidRequest('Attach no more than four images or PDFs to a message.');
    }
    if (attachments.length && message.role !== 'user') {
      throw invalidRequest('Attachments can only be included with user messages.');
    }

    if ((!content && attachments.length === 0) || content.length > 40000) {
      throw invalidRequest('Each message must contain text or an attachment and stay under 40,000 characters.');
    }

    const parts = [];
    if (content) parts.push({ text: content });

    for (const attachment of attachments) {
      if (!attachment || typeof attachment.mimeType !== 'string' || typeof attachment.data !== 'string') {
        throw invalidRequest('An attachment is missing its media type or content.');
      }
      const mimeType = attachment.mimeType.toLowerCase();
      if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(mimeType)) {
        throw invalidRequest('Unsupported attachment type. Use a JPG, PNG, WebP image, or PDF.');
      }
      const data = attachment.data;
      if (!data || data.length > 5600000 || data.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
        throw invalidRequest('An attachment is invalid or too large. Choose a smaller file and retry.');
      }
      totalAttachmentChars += data.length;
      if (totalAttachmentChars > 8000000) {
        throw invalidRequest('The combined attachments are too large. Attach fewer or smaller files.');
      }
      parts.push({ inlineData: { mimeType, data } });
    }

    return {
      role: message.role === 'assistant' ? 'model' : 'user',
      parts
    };
  });

  if (messages[messages.length - 1].role !== 'user') {
    throw invalidRequest('The latest message must be from the user.');
  }

  return messages;
}

function partsOf(chunk) {
  const candidates = chunk && Array.isArray(chunk.candidates) ? chunk.candidates : [];
  const content = candidates[0] && candidates[0].content;
  return content && Array.isArray(content.parts) ? content.parts : [];
}

// Reads text from the parts directly. The chunk.text accessor logs a warning whenever a chunk
// also carries a function call, which is normal when plugins are enabled.
function textOf(parts) {
  return parts
    .map((part) => part && typeof part.text === 'string' && !part.thought ? part.text : '')
    .join('');
}

// Joins adjacent plain-text parts. Parts that carry a thought signature or a function call are kept
// exactly as received, because the model needs them back unchanged on the next round.
function mergeParts(parts) {
  const merged = [];
  let lastWasPlain = false;
  for (const part of parts) {
    const plain = Boolean(part) && typeof part.text === 'string' && !part.thought &&
      !part.thoughtSignature && !part.functionCall;
    if (plain && lastWasPlain) {
      merged[merged.length - 1] = { text: merged[merged.length - 1].text + part.text };
    } else {
      merged.push(plain ? { text: part.text } : part);
    }
    lastWasPlain = plain;
  }
  return merged;
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
  if (error && error.code === 'INVALID_REQUEST') {
    return 400;
  }
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
    const user = await verifyRequestUser(req);

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

    // Plugins (Composio). Failures here never block the chat; the reply continues without tools.
    let toolset = null;
    let pluginNotice = null;
    const requestedPlugins = isGreeting ? [] : plugins.normalizeSlugList(body.plugins);
    if (requestedPlugins.length) {
      if (!plugins.isConfigured()) {
        pluginNotice = {
          id: 'plugins-unavailable',
          title: 'Plugins unavailable',
          detail: 'Plugins are not configured on this server, so this reply was written without them.',
          status: 'complete'
        };
      } else {
        try {
          toolset = await plugins.createChatToolset(user.uid, requestedPlugins);
        } catch (pluginError) {
          console.error('Plugin tools could not be prepared:', pluginError && (pluginError.code || pluginError.name), pluginError && pluginError.message);
        }
        if (!toolset) {
          pluginNotice = {
            id: 'plugins-unavailable',
            title: 'Plugins could not be loaded',
            detail: 'Your plugins did not respond, so this reply was written without them. Try again in a moment.',
            status: 'complete'
          };
        }
      }
    }

    const systemInstruction = [
      'You are TruX Code, a clear and capable software engineering assistant.',
      'Help users understand, design, write, debug, and improve software.',
      'Prefer correct, practical answers. State assumptions when needed.',
      'When sharing code, include complete, usable snippets and explain important risks.',
      'Do not claim to have changed a repository, run commands, or deployed software unless a tool actually did that.',
      'Never reveal private internal reasoning; provide concise explanations and useful conclusions.'
    ];
    if (toolset) {
      systemInstruction.push(
        'The user has connected apps as plugins: ' + toolset.plugins.join(', ') + '.',
        'To act in those apps, first find the right tool with COMPOSIO_SEARCH_TOOLS, then run it with COMPOSIO_MULTI_EXECUTE_TOOL.',
        'If an app is not connected, tell the user to connect it from the Plugins page; do not invent results.',
        'Ask for confirmation before any action that is hard to undo or visible to other people, such as sending, posting, deleting, or paying.',
        'Only say an action happened when a tool result confirms it, and summarize what you did in plain language.'
      );
    }

    const baseConfig = {
      systemInstruction: systemInstruction.join(' '),
      thinkingConfig: { thinkingLevel },
      maxOutputTokens: isGreeting ? 100 : 8192
    };
    const configFor = function (round) {
      if (!toolset) return baseConfig;
      const config = { ...baseConfig, tools: [{ functionDeclarations: toolset.declarations }] };
      // On the last allowed round, force a written answer instead of another tool call.
      if (round >= MAX_TOOL_ROUNDS) config.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
      return config;
    };

    const client = getVertexClient();
    const conversation = contents.slice();
    let stream = await client.models.generateContentStream({
      model,
      contents: conversation,
      config: configFor(0)
    });

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    streamStarted = true;

    // Send only observable request lifecycle stages; never expose internal model reasoning.
    sendNdjson(res, {
      type: 'activity',
      step: {
        id: 'request-validated',
        title: 'Request validated',
        detail: 'Your sign-in, selected model, and request content were checked.',
        status: 'complete'
      }
    });
    if (pluginNotice) sendNdjson(res, { type: 'activity', step: pluginNotice });
    if (toolset) {
      sendNdjson(res, {
        type: 'activity',
        step: {
          id: 'plugins-ready',
          title: 'Plugins ready',
          detail: 'Using ' + toolset.plugins.join(', ') + ' for this reply.',
          status: 'complete'
        }
      });
    }
    sendNdjson(res, {
      type: 'activity',
      step: {
        id: 'generation-started',
        title: 'Model request started',
        detail: 'The validated prompt was submitted to the selected Vertex AI model.',
        status: 'active'
      }
    });

    let outputCharacters = 0;
    let responseStageRecorded = false;
    let toolStep = 0;
    for (let round = 0; ; round += 1) {
      const modelParts = [];
      const calls = [];
      for await (const chunk of stream) {
        if (res.destroyed) break;
        const parts = partsOf(chunk);
        for (const part of parts) {
          modelParts.push(part);
          if (part && part.functionCall && part.functionCall.name) calls.push(part.functionCall);
        }
        const text = textOf(parts);
        if (text) {
          if (!responseStageRecorded) {
            responseStageRecorded = true;
            sendNdjson(res, {
              type: 'activity',
              step: {
                id: 'response-streaming',
                title: 'Response streaming',
                detail: 'The first response text arrived and streaming began.',
                status: 'active'
              }
            });
          }
          outputCharacters += text.length;
          sendNdjson(res, { type: 'delta', text });
        }
      }
      if (res.destroyed || !toolset || !calls.length || round >= MAX_TOOL_ROUNDS) break;

      // Run each requested plugin tool, then hand the results back to the model.
      conversation.push({ role: 'model', parts: mergeParts(modelParts) });
      const responseParts = [];
      for (const call of calls) {
        toolStep += 1;
        const stepId = 'tool-' + toolStep;
        const info = toolset.describe(call.name, call.args);
        sendNdjson(res, { type: 'activity', step: { id: stepId, title: info.title, detail: info.detail, status: 'active' } });
        const result = await toolset.execute(call.name, call.args);
        sendNdjson(res, {
          type: 'activity',
          step: {
            id: stepId,
            title: info.title,
            detail: result.ok ? info.detail : 'This action did not complete: ' + String(result.error || 'unknown error').slice(0, 300),
            status: result.ok ? 'complete' : 'error'
          }
        });
        responseParts.push({
          functionResponse: {
            name: call.name,
            ...(call.id ? { id: call.id } : {}),
            response: result.ok ? { output: result.data } : { error: result.error }
          }
        });
      }
      conversation.push({ role: 'user', parts: responseParts });
      if (res.destroyed) break;
      stream = await client.models.generateContentStream({
        model,
        contents: conversation,
        config: configFor(round + 1)
      });
    }

    if (!res.destroyed) {
      if (outputCharacters === 0) {
        sendNdjson(res, {
          type: 'activity',
          step: {
            id: 'response-empty',
            title: 'No response text received',
            detail: 'The model stream ended without producing readable response text.',
            status: 'error'
          }
        });
        sendNdjson(res, {
          type: 'error',
          error: 'Vertex AI completed the request but returned no text for model ' + model +
            '. Verify model access and check the Cloud Run logs.'
        });
      } else {
        sendNdjson(res, {
          type: 'activity',
          step: {
            id: 'response-completed',
            title: 'Response completed',
            detail: 'The Vertex AI stream finished and the response was received.',
            status: 'complete'
          }
        });
        sendNdjson(res, { type: 'done' });
      }
      res.end();
    }
  } catch (error) {
    const status = statusFor(error);
    console.error('TruX Code request failed:', error && (error.code || error.name), error && error.message);

    const message = publicFailureMessage(error, status, requestedModel);

    if (streamStarted && !res.destroyed) {
      sendNdjson(res, {
        type: 'activity',
        step: {
          id: 'request-failed',
          title: 'Request interrupted',
          detail: message,
          status: 'error'
        }
      });
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
