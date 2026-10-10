// Talks to Google Gemini. The API key is read from GEMINI_API_KEY in your .env
// file and only ever used here on the server, never sent to the browser.

const MODEL = 'gemini-3.5-flash-lite';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const TIMEOUT_MS = 30 * 1000;
const MAX_REPLY_CHARS = 2000; // same cap the chat uses for normal messages

const SYSTEM_PROMPT =
  'You are Gemini, an AI assistant inside a small chat app. Someone typed @ai to ask you something. ' +
  'Answer helpfully and briefly (a few sentences unless more is clearly needed). ' +
  'The chat shows plain text only, so do not use Markdown (no **bold**, #headings or code fences). ' +
  'Recent messages from the chat may be included for context; use them only if relevant.';

/**
 * @param {object} opts
 * @param {string} opts.question  what the person asked (with "@ai" removed)
 * @param {string} opts.asker     display name of the person asking
 * @param {{name: string, text: string}[]} [opts.history]  recent chat messages, oldest first
 * @returns {Promise<string>} always a string that is safe to post in the chat
 */
async function askGemini({ question, asker, history = [] }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error('GEMINI_API_KEY is missing from .env');
    return "AI isn't set up on this server yet.";
  }

  const transcript = history.map((h) => `${h.name}: ${h.text}`).join('\n');
  const prompt =
    (transcript ? `Recent chat (for context):\n${transcript}\n\n` : '') +
    `${asker} asks you: ${question}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        // One user turn on purpose: Gemini 3.5 Flash-Lite rejects requests that end on a "model" turn.
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 800 }
      })
    });

    if (!res.ok) {
      console.error('Gemini API error', res.status, (await res.text()).slice(0, 500));
      if (res.status === 429) return "I'm getting too many requests right now. Try again in a minute.";
      return 'Sorry, I could not get an answer right now.';
    }

    const data = await res.json();
    const cand = data.candidates && data.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    const out = parts
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('')
      .trim();

    if (!out) {
      const blocked = (data.promptFeedback && data.promptFeedback.blockReason) || (cand && cand.finishReason === 'SAFETY');
      return blocked ? "I can't help with that one." : "I didn't come up with an answer. Try rephrasing?";
    }
    return out.length > MAX_REPLY_CHARS ? out.slice(0, MAX_REPLY_CHARS - 1) + '\u2026' : out;
  } catch (err) {
    console.error('Gemini request failed:', err.name === 'AbortError' ? 'timed out' : err.message);
    return err.name === 'AbortError' ? 'That took too long. Try again?' : 'Sorry, I could not get an answer right now.';
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { askGemini, MODEL };
