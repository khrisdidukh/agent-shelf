// Input guardrail for everything a model reads on a merchant's behalf: merchant answers, listing text, fetched pages.
// Two layers, both cheap: Llama Guard 4 (open-weight safety classifier, called through Otari) and plain-code checks
// for personal data and prompt injection (a listing must never carry a customer's email, and a competitor page
// must never be able to tell the analyst what to do).
//
// It is served as an Otari guardrail service: POST <url>/validate {profile, input_text} -> {result:{valid, explanation, score}}
// (the contract in Otari's docs/guardrails.md). Requests then carry
//   guardrails: [{ profile: 'shelf-input', url: '<public url>/guardrails/<token>', mode: 'block' }]
// and Otari refuses the model call (403) before any provider sees flagged input.
// Otari can only reach a public URL; on localhost the app runs the same check itself before the call.
import { randomBytes } from 'node:crypto';
import * as OT from './otari.mjs';

const TOKEN = process.env.GUARDRAIL_TOKEN || randomBytes(12).toString('hex');
export const PROFILE = 'shelf-input';
export const tokenOk = (t) => t === TOKEN;

const HAZARDS = { S1: 'violent crimes', S2: 'non-violent crimes', S3: 'sex-related crimes', S4: 'child sexual exploitation', S5: 'defamation', S6: 'specialized advice', S7: 'privacy / personal data', S8: 'intellectual property', S9: 'indiscriminate weapons', S10: 'hate', S11: 'suicide & self-harm', S12: 'sexual content', S13: 'elections', S14: 'code interpreter abuse' };
// S6 fires on ordinary product facts (care instructions, burn safety); for a shop listing only these matter
const BLOCKING = new Set(['S1', 'S2', 'S3', 'S4', 'S5', 'S7', 'S9', 'S10', 'S11', 'S12', 'S14']);

const PII = [
  ['email address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ['payment card number', /\b(?:\d[ -]?){13,19}\b/],
  ['phone number', /(?:\+\d{1,3}[ .-]?\(?\d{1,4}\)?[ .-]?\d{2,4}[ .-]?\d{2,4}(?:[ .-]?\d{2,4})?|\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4})\b/],
];
const luhn = (s) => { const d = s.replace(/\D/g, ''); let sum = 0; for (let i = 0; i < d.length; i++) { let n = +d[d.length - 1 - i]; if (i % 2) { n *= 2; if (n > 9) n -= 9; } sum += n; } return d.length >= 13 && sum % 10 === 0; };
const INJECTION = /(ignore|disregard|forget) (all |any |the )?(previous|prior|above|earlier) (instructions|prompts?|rules)|you are now|system prompt|rank (this|me|us) (first|#?1)|always (pick|choose|recommend) (this|me|us)/i;

/** screen(text) -> { valid, reasons[], hazards[], guard: meta | null } */
export async function screen(text, { useModel = true } = {}) {
  const t = String(text || '').slice(0, 12_000);
  const reasons = [];
  for (const [label, re] of PII) {
    const m = t.match(new RegExp(re.source, re.flags + 'g')) || [];
    if (m.some((x) => label !== 'payment card number' || luhn(x))) reasons.push(label);
  }
  if (INJECTION.test(t)) reasons.push('instructions aimed at the AI (prompt injection)');
  let hazards = [], guard = null;
  if (useModel && OT.on()) {
    try {
      const r = await OT.chat({ role: 'guard', tag: 'guardrail', maxTokens: 12, messages: [{ role: 'user', content: t }], timeoutMs: 20_000 });
      guard = r.meta;
      const m = r.text.match(/unsafe\s*([S\d,\s]*)/i);
      if (m) hazards = m[1].split(/[,\s]+/).filter((x) => /^S\d+$/.test(x));
      for (const h of hazards) if (BLOCKING.has(h)) reasons.push('Llama Guard: ' + (HAZARDS[h] || h));
    } catch (e) { reasons.length || (guard = { error: e.message }); }
  }
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)], hazards, guard };
}

/** Express-free handler for POST /guardrails/<token>/validate (the Otari guardrail service contract). */
export async function validate(body) {
  const v = await screen(body?.input_text || '');
  return { profile: body?.profile || PROFILE, result: { valid: v.valid, explanation: v.valid ? null : v.reasons.join('; '), score: v.valid ? 0 : 1 } };
}

/** Where Otari can reach this service, or null when the app only runs on localhost. */
export function serviceUrl() {
  if (process.env.OTARI_GUARDRAIL_URL) return process.env.OTARI_GUARDRAIL_URL.replace(/\/$/, '');
  const pub = process.env.PUBLIC_URL || '';
  if (/^https:\/\//.test(pub) && !/localhost|127\.0\.0\.1/.test(pub)) return `${pub.replace(/\/$/, '')}/guardrails/${TOKEN}`;
  return null;
}

/**
 * protect(text): decide how the next model call is guarded.
 * Public deployment -> returns the guardrails field for the Otari request (Otari enforces it, mode block).
 * Localhost -> screens here first and throws when the input is flagged.
 * Either way returns { guardrails, verdict } so the UI can show what was checked and by whom.
 */
export async function protect(text, { app = false } = {}) {
  const url = app ? null : serviceUrl();
  if (url) return { by: 'otari', guardrails: [{ profile: PROFILE, url, mode: 'block', on_unavailable: 'block' }], verdict: null };
  const verdict = await screen(text);
  if (!verdict.valid) throw new OT.OtariRefusal('Blocked by the input guardrail: ' + verdict.reasons.join('; ') + '. Remove it and try again.', { code: 'guardrail_blocked' });
  return { by: 'app', guardrails: null, verdict };
}

/**
 * guarded(text, call): run call(guardrails) behind the input guardrail.
 * If Otari cannot evaluate our guardrail service (it fails closed with 502), screen the input in the app
 * and retry without the Otari-side entry, so a slow or cold guardrail host never takes the feature down.
 */
export async function guarded(text, call) {
  const g = await protect(text);
  try { return { guard: g, out: await call(g.guardrails || undefined) }; }
  catch (e) {
    if (e?.code !== 'guardrail_unavailable') throw e;
    console.log('guardrail: Otari could not evaluate it, screening in the app instead');
    const a = await protect(text, { app: true });
    return { guard: { ...a, fallback: true }, out: await call(undefined) };
  }
}
