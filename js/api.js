/* ============================================================
   api.js – Anthropic API integration
   ============================================================ */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const API_VER       = '2023-06-01';

/**
 * If the user has configured a proxy URL in settings (stored in localStorage
 * as 'pb_proxy'), requests are routed through it instead of calling Anthropic
 * directly. The proxy must forward the request to api.anthropic.com and add
 * CORS headers. See the in-app instructions for a one-click Cloudflare Worker.
 */
function apiUrl() {
  const proxy = localStorage.getItem('pb_proxy');
  return proxy ? proxy.replace(/\/$/, '') : ANTHROPIC_URL;
}

/* ── core fetch ─────────────────────────────────────────────── */

async function call(apiKey, model, messages, maxTokens = 4096) {
  let res;
  try {
    res = await fetch(apiUrl(), {
      method: 'POST',
      headers: {
        'content-type':                      'application/json',
        'x-api-key':                         apiKey,
        'anthropic-version':                 API_VER,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
    });
  } catch (networkErr) {
    // fetch() itself throws on network failure or CORS preflight block
    throw new CorsOrNetworkError(networkErr.message);
  }

  if (!res.ok) {
    let msg = `API error ${res.status}`;
    try { const e = await res.json(); msg = e.error?.message || msg; } catch {}
    throw new Error(msg);
  }

  const data = await res.json();
  return data.content[0].text;
}

/** Sentinel error type so callers can show a tailored CORS message */
class CorsOrNetworkError extends Error {
  constructor(msg) { super(msg); this.name = 'CorsOrNetworkError'; }
}

export { CorsOrNetworkError };

/* ── helpers ────────────────────────────────────────────────── */

function parseJSON(text) {
  // Strip markdown code fences if model wraps response
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Extract the first complete JSON object or array
  const obj   = cleaned.match(/\{[\s\S]*\}/);
  const arr   = cleaned.match(/\[[\s\S]*\]/);
  const match = obj && arr
    ? (cleaned.indexOf('{') < cleaned.indexOf('[') ? obj : arr)
    : (obj || arr);
  if (!match) throw new Error('No JSON found in API response');
  return JSON.parse(match[0]);
}

/* ── image utilities ────────────────────────────────────────── */

/**
 * Resize an image data-URL so neither dimension exceeds maxPx,
 * then re-encode as JPEG at the given quality.
 */
export function resizeImage(dataUrl, maxPx = 1568, quality = 0.82) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxPx || height > maxPx) {
        if (width >= height) { height = Math.round(height * maxPx / width);  width  = maxPx; }
        else                  { width  = Math.round(width  * maxPx / height); height = maxPx; }
      }
      const canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl); // fallback: use original
    img.src = dataUrl;
  });
}

/** Convert a File/Blob to a base64 data-URL */
export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Build an Anthropic image content block from a data-URL */
function imageBlock(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const meta  = dataUrl.slice(5, comma);                   // strip "data:"
  const [mediaType] = meta.split(';');
  const data  = dataUrl.slice(comma + 1);
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

/* ── processNote ────────────────────────────────────────────── */

/**
 * Send one or more page images to Claude and receive structured note data.
 * Returns: { title, transcription, organized, summary, tags, keyPoints }
 */
export async function processNote(dataUrls, apiKey, model) {
  const pageWord = dataUrls.length > 1 ? `these ${dataUrls.length} pages` : 'this page';

  const content = [
    ...dataUrls.map(imageBlock),
    {
      type: 'text',
      text: `You are an expert at reading handwritten notes and organizing information clearly.

Please analyze ${pageWord} of handwritten notes and return a JSON object with EXACTLY this structure:

{
  "title": "A concise descriptive title, max 60 characters",
  "transcription": "Complete verbatim transcription of all handwritten text. Preserve the original layout with line breaks. If any text is unclear, write [unclear] in its place.",
  "organized": "The same content reorganized into a clean, logical structure using Markdown. Group related ideas under ## headings. Use bullet points, numbered lists, and **bold** for key terms. Make it easy to scan.",
  "summary": "2-3 sentence summary of the main ideas and takeaways.",
  "tags": ["3", "to", "8", "lowercase", "topic", "tags"],
  "keyPoints": ["Most important point 1", "Most important point 2", "Most important point 3"]
}

If the image contains no readable text, set transcription to "[No readable text found]" and provide minimal values for the other fields.
Return ONLY the JSON object. No preamble, no explanation.`,
    },
  ];

  const text   = await call(apiKey, model, [{ role: 'user', content }]);
  const parsed = parseJSON(text);

  // Validate / fill missing keys
  return {
    title:         parsed.title         || 'Untitled Note',
    transcription: parsed.transcription || '',
    organized:     parsed.organized     || '',
    summary:       parsed.summary       || '',
    tags:          Array.isArray(parsed.tags)       ? parsed.tags       : [],
    keyPoints:     Array.isArray(parsed.keyPoints)  ? parsed.keyPoints  : [],
  };
}

/* ── findRelatedNotes ────────────────────────────────────────── */

/**
 * Given a newly processed note and an array of existing notes,
 * return up to 5 related note IDs with scores and reasons.
 * Returns: Array<{ id, score, reason }>
 */
export async function findRelatedNotes(newNote, existingNotes, apiKey, model) {
  if (!existingNotes.length) return [];

  // Send compact representations to keep tokens low
  const candidates = existingNotes.slice(0, 40).map(n => ({
    id:      n.id,
    title:   n.title,
    summary: n.summary,
    tags:    n.tags,
  }));

  const prompt = `You are finding connections between notes.

NEW NOTE:
Title: ${newNote.title}
Summary: ${newNote.summary}
Tags: ${(newNote.tags || []).join(', ')}

EXISTING NOTES:
${JSON.stringify(candidates, null, 2)}

Return a JSON array of the most related existing notes (up to 5).
Only include notes with meaningful topical overlap (score ≥ 0.45).

[
  {
    "id": "note-id-here",
    "score": 0.85,
    "reason": "One concise sentence explaining the connection."
  }
]

Return ONLY the JSON array. If no notes are sufficiently related, return [].`;

  try {
    const text   = await call(apiKey, model, [{ role: 'user', content: [{ type: 'text', text: prompt }] }], 1024);
    const parsed = parseJSON(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // Relations are non-critical; don't fail the whole note save
  }
}

/* ── testApiKey ─────────────────────────────────────────────── */

export async function testApiKey(apiKey) {
  // Cheapest possible call just to validate the key
  await call(
    apiKey,
    'claude-haiku-4-5-20251001',
    [{ role: 'user', content: 'Reply with the single word: ok' }],
    5,
  );
  return true;
}
