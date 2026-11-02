// One small helper for every model call: ask for JSON, get JSON back, retry when the model wanders.
// Default: Qwen3.8-27B on NEAR AI Cloud (OpenAI-compatible API). Any OpenAI-compatible endpoint works via env.
// Otari mode (OTARI_API_KEY set): the same calls go through Mozilla.ai's Otari gateway to open-weight models,
// with fallbacks, per-merchant spend and guardrails (see src/otari.mjs).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as OT from './otari.mjs';

const API = process.env.AI_BASE_URL || 'https://cloud-api.near.ai/v1';
const MODEL = process.env.AI_MODEL || 'Qwen/Qwen3.8-27B';
const CACHE = new URL('../cache/ai/', import.meta.url);

const extractJson = OT.extractJson;

/** askJson(system, user) -> parsed JSON. Cached by prompt hash so demos are repeatable and cheap. */
export async function askJson(system, user, { maxTokens = 2500, cache = true, role = 'worker', guardrails } = {}) {
  const otari = OT.on();
  const modelKey = otari ? 'otari:' + OT.ROLES[role][0] : MODEL;
  const key = createHash('sha256').update(modelKey + system + '\n' + user).digest('hex').slice(0, 24);
  const file = new URL(key + '.json', CACHE);
  if (cache && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  if (otari) {
    const { json } = await OT.chatJson({
      role, maxTokens, guardrails,
      messages: [{ role: 'system', content: system + '\nAnswer with JSON only. No prose, no markdown.' }, { role: 'user', content: user }],
    });
    if (cache) { mkdirSync(CACHE, { recursive: true }); writeFileSync(file, JSON.stringify(json, null, 1)); }
    return json;
  }
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
