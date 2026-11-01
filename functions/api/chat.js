'use strict';

const { GoogleGenAI } = require('@google/genai');
const { verifyRequestUser } = require('../firebase-auth');
const plugins = require('../composio');
const webSearch = require('../web-search');

const MODELS = Object.freeze({
  'gemini-4-argon': 'gemini-4-argon',
  'gemini-3.1-pro-preview': 'gemini-3.1-pro-preview',
  'gemini-3.8-flash': 'gemini-3.8-flash'
});

// The welcome headline is written by a model that this project is known to have access to.
const GREETING_MODEL = String(process.env.GREETING_MODEL || 'gemini-3.8-flash').trim();

const THINKING_LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH']);
let vertexClient;

// Node's fetch (used by the Google SDK) reports dropped connections, DNS hiccups and resets as a bare
// "TypeError: fetch failed" with the real reason on error.cause. These are usually momentary.
const TRANSIENT_NETWORK_CODES = /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_[A-Z_]+)$/;

function causeOf(error) {
  return error && error.cause && typeof error.cause === 'object' ? error.cause : null;
}

function isNetworkError(error) {
  if (!error) return false;
  const cause = causeOf(error);
  if (cause && TRANSIENT_NETWORK_CODES.test(String(cause.code || ''))) return true;
  return error.name === 'TypeError' && /fetch failed|network|socket|terminated|other side closed/i.test(String(error.message || ''));
}

// Opens a model stream, retrying once when the connection itself fails before any response arrives.
async function openStream(client, params) {
  try {
    return await client.models.generateContentStream(params);
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    console.warn('Vertex AI connection failed, retrying once:', error.name, error.message,
      causeOf(error) && (causeOf(error).code || causeOf(error).message));
    await new Promise((resolve) => setTimeout(resolve, 400));
    return client.models.generateContentStream(params);
  }
}

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
  if (!Array.isArray(input) || input.length === 0) {
    throw invalidRequest('The conversation must contain at least one message.');
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

    if (!content && attachments.length === 0) {
      throw invalidRequest('Each message must contain text or an attachment.');
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

// Builds the prompt for the welcome headline shown on the empty chat screen.
function greetingPrompt(body) {
  const name = typeof body.name === 'string'
    ? body.name.replace(/[^\p{L}\p{N} '\-]/gu, '').trim().slice(0, 40)
    : '';
  const hour = Number.isInteger(body.hour) && body.hour >= 0 && body.hour <= 23 ? body.hour : null;
  const period = hour === null ? '' : hour < 5 ? 'late at night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 22 ? 'evening' : 'late at night';
  return [
    'Write one short, warm, original headline to greet a developer opening their coding workspace.',
    name ? 'Their first name is ' + name + '; use it naturally.' : 'You do not know their name, so do not invent one.',
    period ? 'It is ' + period + ' for them; let that shape the tone without stating the time.' : '',
    'At most 10 words. Plain text only: no quotes, no markdown, no emoji, no list, no explanation.',
    'Do not start with "Welcome". Vary the wording each time.'
  ].filter(Boolean).join(' ');
}

function partsOf(chunk) {
  const candidates = chunk && Array.isArray(chunk.candidates) ? chunk.candidates : [];
  const content = candidates[0] && candidates[0].content;
  return content && Array.isArray(content.parts) ? content.parts : [];
}

// Reads text from the parts directly. The chunk.text accessor logs a warning whenever a chunk
// also carries a function call, which is normal when tools are enabled.
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
  if (isNetworkError(error)) {
    return 'Could not reach Vertex AI (network error). Retry in a moment. If it keeps happening, check Cloud Run egress and VPC settings.';
  }
  if (/deadline|timed out|timeout|unavailable|503/.test(combined)) {
    return 'Vertex AI did not finish the request. Check service availability and retry.';
  }
  if (/invalid argument|invalid_argument|thinking.?level|thinkingconfig|unsupported parameter/.test(combined)) {
    return 'Vertex AI rejected the request configuration. Check the selected model and thinking level.';
  }

  // A bare TypeError carries no code, so show its short message to make the failure diagnosable.
  const label = String(error && (error.code || error.name) || 'unknown error');
  const hint = error && !error.code && error.name === 'TypeError' && error.message
    ? ': ' + String(error.message).slice(0, 120)
    : '';
  return 'Vertex AI request failed (' + label + hint + ') for model ' + model +
    '. Check the Cloud Run logs for the underlying error.';
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
    const selectedModel = isGreeting ? GREETING_MODEL : body.model;
    const model = isGreeting ? selectedModel : MODELS[selectedModel];
    requestedModel = model || selectedModel || 'unknown';

    if (!model) {
      return res.status(400).json({ error: 'Choose a supported model.' });
    }

    const thinkingLevel = isGreeting
      ? 'LOW'
      : String(body.thinkingLevel || 'LOW').toUpperCase();

    if (!THINKING_LEVELS.has(thinkingLevel)) {
      return res.status(400).json({ error: 'Thinking level must be Low, Medium, or High.' });
    }

    const contents = isGreeting
      ? [{ role: 'user', parts: [{ text: greetingPrompt(body) }] }]
      : normalizeMessages(body.messages);

    // Flush an early lifecycle event so the UI can show progress while optional plugin setup
    // and the model's first-token wait are still in progress.
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    streamStarted = true;
    sendNdjson(res, {
      type: 'activity',
      step: {
        id: 'request-validated',
        title: 'Request validated',
        detail: 'Your sign-in, selected model, and request content were checked.',
        status: 'complete'
      }
    });
    sendNdjson(res, {
      type: 'activity',
      step: {
        id: 'generation-preparing',
        title: 'Preparing response',
        detail: 'The request is validated; TruX Code is preparing the model and enabled tools.',
        status: 'active'
      }
    });

    // Plugins (Composio). Failures here never block the chat; the reply continues without them.
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

    // Web search is always offered as a tool; the model chooses when (and whether) to call it.
    // Clients may send webSearch: false to switch it off for a request.
    const searchEnabled = !isGreeting && body.webSearch !== false;
    const hasTools = Boolean(toolset) || searchEnabled;

    const systemInstruction = [
      'You are TruX Code, a clear and capable software engineering assistant.',
      'Help users understand, design, write, debug, and improve software.',
      'Prefer correct, practical answers. State assumptions when needed.',
      'When sharing code, include complete, usable snippets and explain important risks.',
      'Do not claim to have changed a repository, run commands, or deployed software unless a tool actually did that.',
      'Never reveal private internal reasoning; provide concise explanations and useful conclusions.'
    ];
    if (searchEnabled) {
      systemInstruction.push(
        'Today is ' + new Date().toUTCString().slice(0, 16) + '.',
        'You have a web_search tool. Decide for yourself whether a question needs it.',
        'Use it when the answer depends on recent or changing facts you cannot know reliably, such as new releases, current library or API versions, documentation details, news, or prices, or when the user asks you to look something up.',
        'For ordinary coding, debugging, and explanations, answer directly without searching. When search is necessary, start with one focused query and avoid serial searches unless the first result is clearly insufficient.',
        'Do not use it for general programming knowledge, writing or explaining code, or anything you can answer well from what you already know; answer those directly.',
        'After searching, answer in your own words and cite the sources you used as markdown links. If a search fails, say so briefly and answer with what you know.'
      );
    }
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
      ...(isGreeting ? { temperature: 1 } : {})
    };
    const declarations = [];
    if (searchEnabled) declarations.push(webSearch.declaration);
    if (toolset) declarations.push(...toolset.declarations);

    const configFor = function () {
      if (!hasTools) return baseConfig;
      // The Google SDK rewrites function declarations in place while it builds the request. The shared
      // web_search declaration is frozen, so hand the SDK a fresh copy for every round, never the original.
      return {
        ...baseConfig,
        tools: [{ functionDeclarations: declarations.map((item) => structuredClone(item)) }]
      };
    };

    // Report tool setup and model connection as observable lifecycle stages.
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
        id: 'generation-preparing',
        title: 'Request prepared',
        detail: 'The selected model and enabled tools are ready.',
        status: 'complete'
      }
    });
    sendNdjson(res, {
      type: 'activity',
      step: {
        id: 'generation-started',
        title: 'Connecting to model',
        detail: 'Waiting for the selected Vertex AI model to begin streaming.',
        status: 'active'
      }
    });

    const client = getVertexClient();
    const conversation = contents.slice();
    let stream = await openStream(client, {
      model,
      contents: conversation,
      config: configFor()
    });

    let outputCharacters = 0;
    let responseStageRecorded = false;
    let toolStep = 0;
    while (true) {
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
      if (res.destroyed || !hasTools || !calls.length) break;

      // Run each requested tool, then hand the results back to the model.
      conversation.push({ role: 'model', parts: mergeParts(modelParts) });
      const responseParts = [];
      for (const call of calls) {
        toolStep += 1;
        const stepId = 'tool-' + toolStep;
        const isSearch = call.name === webSearch.declaration.name;
        const info = isSearch
          ? webSearch.describe(call.args)
          : toolset
            ? toolset.describe(call.name, call.args)
            : { title: 'Running a tool', detail: 'The model requested a tool that is not available.' };
        sendNdjson(res, { type: 'activity', step: { id: stepId, title: info.title, detail: info.detail, status: 'active' } });

        let result;
        if (isSearch) {
          result = await webSearch.execute(client, call.args);
        } else if (toolset) {
          result = await toolset.execute(call.name, call.args);
        } else {
          result = { ok: false, error: 'That tool is not available.' };
        }

        let doneDetail = info.detail;
        let doneTitle = info.title;
        if (isSearch && result.ok) {
          doneTitle = 'Searched the web';
          const hosts = (result.sources || []).map((source) => {
            try { return new URL(source.url).hostname.replace(/^www\./, ''); } catch { return ''; }
          }).filter(Boolean);
          const unique = Array.from(new Set(hosts)).slice(0, 4);
          doneDetail = info.detail + (unique.length ? ' Sources: ' + unique.join(', ') + '.' : '');
        } else if (!result.ok) {
          doneDetail = 'This action did not complete: ' + String(result.error || 'unknown error').slice(0, 300);
        }
        sendNdjson(res, {
          type: 'activity',
          step: { id: stepId, title: doneTitle, detail: doneDetail, status: result.ok ? 'complete' : 'error' }
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
      stream = await openStream(client, {
        model,
        contents: conversation,
        config: configFor()
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
    const cause = causeOf(error);
    console.error('TruX Code request failed:', error && (error.code || error.name), error && error.message,
      cause ? '| cause: ' + String(cause.code || cause.name || '') + ' ' + String(cause.message || '') : '');

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

module.exports = { chatHandler, getVertexClient, isNetworkError, statusFor };
