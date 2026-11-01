// One small helper for every model call: ask for JSON, get JSON back, retry when the model wanders.
// Model: Qwen3.8-27B on NEAR AI Cloud (OpenAI-compatible API). Any OpenAI-compatible endpoint works via env.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const API = process.env.AI_BASE_URL || 'https://cloud-api.near.ai/v1';
const MODEL = process.env.AI_MODEL || 'Qwen/Qwen3.8-27B';
const CACHE = new URL('../cache/ai/', import.meta.url);

function extractJson(text) {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : clean;
  const start = body.search(/[\[{]/);
  if (start < 0) throw new Error('no JSON in model answer');
  const open = body[start], close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  return JSON.parse(body.slice(start, end + 1));
}

/** askJson(system, user) -> parsed JSON. Cached by prompt hash so demos are repeatable and cheap. */
export async function askJson(system, user, { maxTokens = 2500, cache = true } = {}) {
  const key = createHash('sha256').update(MODEL + system + '\n' + user).digest('hex').slice(0, 24);
  const file = new URL(key + '.json', CACHE);
  if (cache && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const KEY = process.env.AI_API_KEY || process.env.NEARAI_API_KEY;
  if (!KEY) throw new Error('AI_API_KEY (or NEARAI_API_KEY) is not set');
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${API}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(90_000),
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system + '\nAnswer with JSON only. No prose, no markdown.' },
            { role: 'user', content: user },
          ],
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
      if (!res.ok) throw new Error(`AI ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const out = extractJson(data.choices?.[0]?.message?.content || '');
      if (cache) { mkdirSync(CACHE, { recursive: true }); writeFileSync(file, JSON.stringify(out, null, 1)); }
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
