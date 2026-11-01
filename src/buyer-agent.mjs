// The shopping agent that proves a listing is buyable: an LLM with PayPal Agent Toolkit tools.
// It reads the buyer's request and the agent-ready listing, decides whether the product fits,
// and if it does, creates the PayPal order itself (create_order) with item-level data.
import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';

const provider = () => createOpenAICompatible({
  name: 'nearai',
  baseURL: process.env.AI_BASE_URL || 'https://cloud-api.near.ai/v1',
  apiKey: process.env.AI_API_KEY || process.env.NEARAI_API_KEY,
});

let toolkit;
function paypalTools() {
  toolkit ??= new PayPalAgentToolkit({
    clientId: process.env.PAYPAL_CLIENT_ID,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET,
    configuration: { actions: { orders: { create: true, get: true } }, context: { sandbox: true } },
  });
  return toolkit.getTools();
}

const RETURN = process.env.PUBLIC_URL || 'http://localhost:8790';
const facts = (l) => [`Title: ${l.title}`, `Price: ${l.price} ${l.currency}`, l.description && `Description: ${l.description}`,
  ...Object.entries(l.attributes || {}).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join('\n');

/** buy(listing, request) -> { decision, reason, order?, transcript[] } */
export async function buy(listing, request) {
  const transcript = [];
  const res = await generateText({
    model: provider()(process.env.AI_MODEL || 'Qwen/Qwen3.8-27B'),
    tools: paypalTools(),
    maxSteps: 4,
    temperature: 0,
    system:
      'You are a shopping agent buying on behalf of a person. You may only buy a product whose listing explicitly states every requirement in the request. ' +
      'If it fits, call create_order exactly once with one item: name = the product title, quantity 1, item price = the listed price, currency as listed, shipping 0, tax 0, returnUrl ' + RETURN + '/paid, cancelUrl ' + RETURN + '/. ' +
      'Then answer with JSON {"decision":"buy"|"skip","reason":"<= 25 words"}. If it does not fit, do not call any tool and answer with decision "skip".',
    prompt: `BUYER REQUEST: ${request}\n\nLISTING:\n${facts(listing)}`,
    providerOptions: { nearai: { chat_template_kwargs: { enable_thinking: false } } },
    onStepFinish: (s) => {
      for (const c of s.toolCalls || []) transcript.push({ tool: c.toolName, args: c.args });
      for (const r of s.toolResults || []) transcript.push({ tool: r.toolName, result: r.result });
    },
  });
  let verdict = {};
  try { verdict = JSON.parse(res.text.replace(/<think>[\s\S]*?<\/think>/g, '').match(/\{[\s\S]*\}/)[0]); } catch { verdict = { decision: transcript.length ? 'buy' : 'skip', reason: res.text.slice(0, 160) }; }
  const created = transcript.find((t) => t.tool === 'create_order' && t.result);
  let order = null;
  if (created) {
    const r = typeof created.result === 'string' ? JSON.parse(created.result) : created.result;
    order = { id: r.id, status: r.status, approve: r.links?.find((l) => l.rel === 'approve' || l.rel === 'payer-action')?.href };
  }
  return { decision: verdict.decision, reason: verdict.reason, order, transcript };
}
