'use strict';

// Web search for TruX Code. It is exposed to the model as an ordinary function tool, so the model
// decides on its own whether a question needs fresh information. Each call runs one grounded
// Google Search request on Vertex AI and hands a short, sourced answer back to the main model.

const SEARCH_MODEL = String(process.env.SEARCH_MODEL || 'gemini-3.8-flash').trim();
const MAX_SEARCHES_PER_REPLY = 5;

const declaration = Object.freeze({
  name: 'web_search',
  description:
    'Search the web with Google for current or external information. Use it only when the answer depends on ' +
    'facts that may have changed or that you cannot know: recent releases, library or API versions, ' +
    'documentation, error messages, news, prices, dates. Do not use it for general programming knowledge, ' +
    'explaining or writing code, or anything you can answer reliably yourself. Keep the query short and specific.',
  parameters: {
    type: 'OBJECT',
    properties: {
      query: {
        type: 'STRING',
        description: 'A short, specific search query, for example "node 24 release date" or "react 19 use hook docs".'
      }
    },
    required: ['query']
  }
});

function cleanQuery(args) {
  const raw = args && typeof args.query === 'string' ? args.query : '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function hostOf(uri) {
  try {
    return new URL(uri).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function describe(args) {
  const query = cleanQuery(args);
  return {
    title: 'Searching the web',
    detail: query ? 'Looking up: ' + query : 'Looking up current information.'
  };
}

async function execute(client, args, state) {
  const query = cleanQuery(args);
  if (!query) return { ok: false, error: 'The search query was empty.' };

  state.count += 1;
  if (state.count > MAX_SEARCHES_PER_REPLY) {
    return { ok: false, error: 'The search limit for this reply was reached. Answer with what you already have.' };
  }

  try {
    const response = await client.models.generateContent({
      model: SEARCH_MODEL,
      contents: [{
        role: 'user',
        parts: [{
          text: 'Search the web and answer briefly and factually, with concrete details such as versions, ' +
            'dates and names. Today is ' + new Date().toUTCString().slice(0, 16) + '.\n\nQuestion: ' + query
        }]
      }],
      config: {
        tools: [{ googleSearch: {} }],
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingLevel: 'LOW' }
      }
    });

    const candidate = response && Array.isArray(response.candidates) ? response.candidates[0] : null;
    const parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
    const answer = parts
      .map((part) => part && typeof part.text === 'string' && !part.thought ? part.text : '')
      .join('')
      .trim();

    const chunks = candidate && candidate.groundingMetadata && Array.isArray(candidate.groundingMetadata.groundingChunks)
      ? candidate.groundingMetadata.groundingChunks
      : [];
    const seen = new Set();
    const sources = [];
    for (const chunk of chunks) {
      const web = chunk && chunk.web;
      if (!web || typeof web.uri !== 'string' || seen.has(web.uri)) continue;
      seen.add(web.uri);
      sources.push({ title: String(web.title || hostOf(web.uri) || 'Source').slice(0, 120), url: web.uri });
      if (sources.length >= 6) break;
    }

    if (!answer) return { ok: false, error: 'The search returned no readable results.' };
    return {
      ok: true,
      data: { query, answer: answer.slice(0, 6000), sources },
      sources
    };
  } catch (error) {
    console.error('Web search failed:', error && (error.code || error.name), error && error.message);
    return { ok: false, error: 'The web search could not be completed right now.' };
  }
}

module.exports = { declaration, describe, execute };
