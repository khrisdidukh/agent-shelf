// Otari mode: every model call goes through Mozilla.ai's Otari gateway (OpenAI-compatible).
// One place for: which open-weight model plays which role, fallbacks, per-merchant budgets,
// gateway tools (web fetch/search, code execution, MCP) and guardrails.
// Secrets: the key is read from OTARI_API_KEY (or OTARI_SERVICE_KEY) and never logged or returned to the browser.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';

// A job runs inside scope.run({ merchant, events }): every call made for it is billed to that merchant and logged.
export const scope = new AsyncLocalStorage();

export const BASE = (process.env.OTARI_BASE_URL || 'https://eu.api.otari.ai/api/v1').replace(/\/$/, '');
export const on = () => !!(process.env.OTARI_API_KEY || process.env.OTARI_SERVICE_KEY);
// A service key bills each merchant as its own Otari end user, with its own budget (per-user budgets).
const serviceKey = () => process.env.OTARI_SERVICE_KEY || '';
const apiKey = () => serviceKey() || process.env.OTARI_API_KEY || '';

// Open-weight models only. Each role is a chain: the first model that answers serves, the rest are fallbacks.
// A routing policy created in the Otari dashboard can lead any chain: OTARI_POLICY_<ROLE>=policy-name.
const chain = (role, models) => [process.env['OTARI_POLICY_' + role.toUpperCase()], ...models].filter(Boolean);
export const ROLES = {
  worker: chain('worker', ['alibaba/qwen3-235b-a22b-instruct-2507', 'meta/llama-3.3-70b-instruct', 'deepseek/deepseek-v3.2']),
  analyst: chain('analyst', ['mistralai/mistral-large-3', 'deepseek/deepseek-v3.2']),
  quant: chain('quant', ['mistralai/mistral-small-4', 'mistralai/mistral-large-3']),
  scout: chain('scout', ['mistralai/mistral-small-4', 'alibaba/qwen3-235b-a22b-instruct-2507']),
  guard: chain('guard', ['meta/llama-guard-4-12b']),
  buyer: chain('buyer', ['mistralai/mistral-large-3', 'alibaba/qwen3-235b-a22b-instruct-2507']), // PayPal Agent Toolkit tool calling
};
// The shopper panel: three shopping agents built on three different open-weight model families.
export const SHOPPERS = [
  { id: 'llama', label: 'Llama shopping agent', models: chain('shopper_llama', ['meta/llama-4-scout-17b', 'meta/llama-3.3-70b-instruct']) },
  { id: 'qwen', label: 'Qwen shopping agent', models: chain('shopper_qwen', ['alibaba/qwen3-235b-a22b-instruct-2507', 'alibaba/qwen3-next-80b-a3b-instruct']) },
  { id: 'gemma', label: 'Gemma shopping agent', models: chain('shopper_gemma', ['google/gemma-4-26b-a4b-it', 'google/gemma-3-27b-it']) },
];

export class OtariRefusal extends Error {
  constructor(message, { status, code, scope, retryAfter } = {}) { super(message); Object.assign(this, { status, code, scope, retryAfter }); }
}

/* ---------- per-merchant spend: Otari reports the cost of every call (usage.cost_usd); we keep a ledger per merchant ---------- */
const LEDGER = new URL('../cache/otari-spend.json', import.meta.url);
let ledger = {};
try { if (existsSync(LEDGER)) ledger = JSON.parse(readFileSync(LEDGER, 'utf8')); } catch { ledger = {}; }
const limitUsd = () => Number(process.env.MERCHANT_BUDGET_USD || 0.25);
const today = () => new Date().toISOString().slice(0, 10);
// the allowance is per UTC day, like a calendar_day budget in Otari
const entry = (merchant) => {
  let e = ledger[merchant];
  if (!e || e.day !== today()) e = ledger[merchant] = { day: today(), spent: 0, calls: 0 };
  return e;
};
function record(merchant, cost) {
  if (!merchant || !cost) return;
  const e = entry(merchant);
  e.spent = Math.round((e.spent + cost) * 1e6) / 1e6; e.calls++;
  try { mkdirSync(new URL('../cache/', import.meta.url), { recursive: true }); writeFileSync(LEDGER, JSON.stringify(ledger, null, 1)); } catch {}
}
export const merchantId = (storeUrl) => 'merchant:' + new URL(storeUrl.startsWith('http') ? storeUrl : 'https://' + storeUrl).hostname;

/** Refuse a run before it starts when this merchant has used its allowance. */
export function assertBudget(merchant) {
  if (!merchant || merchant === 'guardrail-service') return;
  const e = entry(merchant);
  if (e.spent >= limitUsd()) throw new OtariRefusal(`This store has used today's AI budget ($${e.spent.toFixed(4)} of $${limitUsd().toFixed(2)}). It resets at midnight UTC.`, { status: 402, code: 'merchant_budget_exceeded', scope: 'merchant' });
}

/** Budget view for the UI: the app ledger, plus Otari's own end-user record when a service key is configured. */
export async function budget(merchant) {
  const e = merchant ? entry(merchant) : { spent: 0, calls: 0 };
  const out = { merchant, limit: limitUsd(), spent: e.spent, calls: e.calls, remaining: Math.max(0, limitUsd() - e.spent), otari: null, mode: serviceKey() ? 'otari-end-user' : 'app-ledger' };
  if (serviceKey()) {
    try {
      const r = await fetch(`${BASE}/end-users?external_id=${encodeURIComponent(merchant)}`, { headers: { Authorization: `Bearer ${serviceKey()}` }, signal: AbortSignal.timeout(10_000) });
      if (r.ok) { const [u] = await r.json(); if (u) out.otari = { budget_id: u.budget_id, spend: u.spend, blocked: u.blocked, next_reset: u.next_budget_reset_at }; }
    } catch {}
  }
  return out;
}

/* ---------- the call ---------- */
const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * chat({ models | role, messages, maxTokens, tools, mcpServers, guardrails, merchant, tag, timeoutMs, events })
 * Tries each model of the chain in order. Inside one model, Otari itself may fall back across providers
 * (catalog ids route automatically); we read that from the Otari-* response headers.
 * Returns { text, meta } where meta says which model really answered, from which provider, at what cost.
 */
export async function chat({ models, role = 'worker', messages, maxTokens = 800, temperature = 0, tools, mcpServers, guardrails, merchant, tag, timeoutMs = 60_000, events, extra = {} }) {
  const sc = scope.getStore() || {};
  merchant ??= sc.merchant; events ??= sc.events;
  const list = models || ROLES[role];
  const tried = [];
  for (const model of list) {
    assertBudget(merchant); // checked before every call, fallbacks included: a run stops as soon as the allowance is gone
    const body = { model, messages, max_tokens: maxTokens, temperature, ...extra };
    if (tools?.length) body.tools = tools;
    if (mcpServers?.length) body.mcp_servers = mcpServers;
    if (guardrails?.length) body.guardrails = guardrails;
    if (tools?.length || mcpServers?.length) body.max_tool_iterations = extra.max_tool_iterations || 4;
    body.metadata = { app: 'agent-shelf', role: tag || role, ...(merchant ? { merchant } : {}) };
    if (merchant && serviceKey()) body.user = merchant; // service key: each merchant is an Otari end user with its own budget
    const headers = { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' };
    if (merchant && serviceKey() && process.env.OTARI_END_USER_BUDGET) headers['Otari-End-User-Budget'] = process.env.OTARI_END_USER_BUDGET;
    const t0 = Date.now();
    let res, text;
    try {
      res = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      text = await res.text();
    } catch (e) {
      tried.push({ model, error: e.name === 'TimeoutError' ? `no answer in ${Math.round(timeoutMs / 1000)}s` : 'network error' });
      events?.push({ type: 'fallback', role: tag || role, model, reason: tried.at(-1).error });
      continue;
    }
    const h = (k) => res.headers.get(k);
    const j = parseJson(text) || {};
    const code = h('otari-error-code') || j.code || j.detail?.code;
    if (!res.ok) {
      const detail = typeof j.detail === 'string' ? j.detail : (j.detail?.message || j.error?.message || text.slice(0, 160));
      // budget and policy refusals are answers, not outages: never fall back around them
      if (res.status === 401) throw new OtariRefusal('Otari rejected the API key (401). Check OTARI_API_KEY and OTARI_BASE_URL (EU keys need https://eu.api.otari.ai/api/v1).', { status: 401, code: 'invalid_key' });
      if (code === 'budget_exceeded' || code === 'end_user_limit_reached' || res.status === 402) {
        throw new OtariRefusal(`Otari refused the call: budget used up (${h('otari-budget-scope') || 'budget'})${h('retry-after') ? `, resets in ${Math.ceil(Number(h('retry-after')) / 3600)} h` : ''}.`, { status: res.status, code: code || 'budget_exceeded', scope: h('otari-budget-scope'), retryAfter: h('retry-after') });
      }
      if (res.status === 403 && (j.detail?.code === 'guardrail_violation' || /guardrail/i.test(detail))) {
        const why = (j.detail?.guardrails || []).map((g) => g.explanation).filter(Boolean).join('; ');
        throw new OtariRefusal(`Otari blocked the call at the input guardrail${why ? ': ' + why : ''}. Remove it and try again.`, { status: 403, code: 'guardrail_blocked' });
      }
      if (res.status === 502 && /guardrail/i.test(detail)) throw new OtariRefusal('The input guardrail could not run, so Otari refused the call (fail closed): ' + detail, { status: 502, code: 'guardrail_unavailable' });
      if (res.status === 403 && /web (access|search)|code execution|not enabled/i.test(detail)) throw new OtariRefusal(detail, { status: 403, code: 'tool_not_enabled' });
      tried.push({ model, error: `${res.status} ${code || ''} ${detail}`.replace(/\s+/g, ' ').trim().slice(0, 140) });
      events?.push({ type: 'fallback', role: tag || role, model, reason: tried.at(-1).error });
      continue;
    }
    const msg = j.choices?.[0]?.message || {};
    const out = String(msg.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const cost = Number(j.usage?.cost_usd || 0);
    record(merchant, cost); // a failed attempt still costs money: count it
    if (!out) {
      tried.push({ model, error: `empty answer (finish: ${j.choices?.[0]?.finish_reason || '?'})` });
      events?.push({ type: 'fallback', role: tag || role, model, reason: tried.at(-1).error, cost });
      continue;
    }
    const meta = {
      role: tag || role, requested: model, model: j.model || model,
      served: h('otari-model'), provider: h('otari-provider'),
      otariFallback: h('otari-fallback') === 'true', attempts: Number(h('otari-attempt-count') || 1),
      appFallback: tried.length > 0, skipped: tried,
      cost, tokens: j.usage?.total_tokens, ms: Date.now() - t0, requestId: h('otari-request-id'),
      guardrails: parseJson(h('otari-guardrails') || 'null'), toolCalls: j.otari_tool_calls || null,
    };
    events?.push({ type: 'call', ...meta });
    return { text: out, meta };
  }
  throw new Error(`Every model for ${tag || role} failed: ${tried.map((t) => `${t.model} (${t.error})`).join('; ')}`);
}

export function extractJson(text) {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : clean;
  const start = body.search(/[\[{]/);
  if (start < 0) throw new Error('no JSON in model answer');
  const close = body[start] === '{' ? '}' : ']';
  return JSON.parse(body.slice(start, body.lastIndexOf(close) + 1));
}

/** chatJson: chat() that must return JSON; one retry on the same chain when the model wanders. */
export async function chatJson(opts) {
  let last;
  for (let i = 0; i < 2; i++) {
    const r = await chat(opts);
    try { return { json: extractJson(r.text), meta: r.meta }; } catch (e) { last = e; }
  }
  throw last;
}
