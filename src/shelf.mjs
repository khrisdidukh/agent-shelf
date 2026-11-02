// Agent Shelf engine: how do AI shopping agents see one merchant's product, and what would make them pick it?
// Three views of the same listing:
//   customer needs — what real buyers ask an agent for in this category (generated intents)
//   agent needs    — which fields the agents' product data actually carries for winners (measured, not guessed)
//   agent verdict  — a shopping agent ranks the listing against the live field for each request
// Every claim the model makes about the listing must quote the listing; quotes are checked by code.
import { askJson } from './ai.mjs';
import { search } from './channel3.mjs';

export const listingText = (l) => [
  l.title, l.description, l.price != null ? `Price: ${l.price} ${l.currency || ''}` : '',
  ...Object.entries(l.attributes || {}).map(([k, v]) => `${k}: ${[].concat(v).join(', ')}`),
  ...(l.key_features || []),
].filter(Boolean).join('\n');

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
const quoted = (quote, text) => !!quote && norm(text).includes(norm(quote));

/** 0. The generic product type a shopper would ask for (no brand, colour or product name). */
export async function genericType(listing) {
  const out = await askJson(
    'You name product types the way shoppers search for them.',
    `Product: ${listing.title}\nTags: ${(listing.tags || []).join(', ')}\nDescription: ${(listing.description || '').slice(0, 300)}\n\n` +
      'Return {"type":"the generic product type in 2-4 words, no colour, no brand, no product name, e.g. \'scented candle\'"}',
  );
  return out.type;
}

/** 1. Buyer requests an agent would receive in this category (customer view). Buyers do not know this product exists. */
export async function buyerIntents(listing, n = 8) {
  const type = listing.genericType || (listing.genericType = await genericType(listing));
  const out = await askJson(
    'You model shoppers who delegate purchases to an AI shopping agent (ChatGPT, Perplexity, Gemini, PayPal agentic checkout). ' +
      'Write realistic requests that real buyers of this product type send to such an agent. The buyers do not know any specific shop or product: they describe what they need. ' +
      'Mix gift buyers, price-conscious buyers, quality seekers, buyers with a specific use, and buyers in a hurry. Keep budgets realistic for the product type. ' +
      'For each request list its hard constraints as short need labels from a SHARED vocabulary (reuse the same label across requests when the need is the same, e.g. "scent", "burn time", "wax type", "size", "price ceiling", "delivery time", "gift packaging", "safety", "returns").',
    `Product type: ${type}\n\n` +
      `Return {"intents":[{"id":"i1","who":"short buyer description","query":"what they type to the agent, <= 20 words","needs":[{"need":"label","value":"what exactly they require"}]}]} with exactly ${n} intents.`,
  );
  return out.intents.slice(0, n);
}

/** 2. The live field: what the agent's product search returns for each request. */
export async function agentField(intents, limit = 8) {
  const field = [];
  for (const it of intents) field.push({ intent: it, products: await search(it.query, limit) });
  return field;
}

/** 3. Agent needs: fields present in the data of products agents return (measured coverage, 0..1). */
export function agentNeeds(field) {
  const all = new Map();
  for (const f of field) for (const p of f.products) all.set(p.id, p);
  const ps = [...all.values()];
  const has = {
    'price': (p) => p.price?.amount != null,
    'in-stock signal': (p) => p.availability === 'InStock',
    'brand': (p) => !!p.brand,
    'rating & reviews': (p) => (p.rating?.count ?? 0) > 0,
    'materials': (p) => p.materials.length > 0,
    '3+ key features': (p) => p.key_features.length >= 3,
    'dimensions': (p) => !!p.dimensions,
    'image': (p) => !!p.image,
    'description 300+ chars': (p) => (p.description?.length ?? 0) >= 300,
  };
  const rows = Object.entries(has).map(([field, fn]) => ({ field, kind: 'core', coverage: ps.filter(fn).length / (ps.length || 1) }));
  const attrCount = new Map();
  for (const p of ps) for (const k of Object.keys(p.attributes || {})) attrCount.set(k, (attrCount.get(k) || 0) + 1);
  for (const [k, c] of attrCount) rows.push({ field: k, kind: 'attribute', coverage: c / ps.length });
  return { sample: ps.length, rows: rows.sort((a, b) => b.coverage - a.coverage) };
}

/** 4. Customer needs: how often each need appears across buyer requests. */
export function customerNeeds(intents) {
  const m = new Map();
  for (const it of intents) for (const n of it.needs) {
    const k = norm(n.need);
    const e = m.get(k) || { need: k, count: 0, examples: [] };
    e.count++; if (e.examples.length < 3) e.examples.push(n.value);
    m.set(k, e);
  }
  return [...m.values()].map((e) => ({ ...e, share: e.count / intents.length })).sort((a, b) => b.count - a.count);
}

/** 5. Does the listing state each need explicitly? The model must quote the listing; code checks the quote. */
export async function checkListing(listing, needs) {
  const text = listingText(listing);
  const out = await askJson(
    'You audit a product listing the way an AI shopping agent reads it: only what is written counts. For each need, quote the exact words from the listing that satisfy it, or null if the listing does not state it. Never infer.',
    `LISTING:\n${text}\n\nNEEDS:\n${needs.map((n) => `- ${n.need} (buyers ask e.g.: ${n.examples.join('; ')})`).join('\n')}\n\n` +
      'Return {"checks":[{"need":"label","quote":"exact words from the listing or null"}]}',
  );
  return needs.map((n) => {
    // price is structured data every agent receives; whether it fits a budget is a fit question, not a listing gap
    if (/price|budget|cost/.test(n.need) && !/shipping/.test(n.need) && listing.price != null) return { ...n, stated: true, quote: `Price: ${listing.price} ${listing.currency || ''}`.trim() };
    const c = out.checks.find((x) => norm(x.need) === n.need);
    const ok = quoted(c?.quote, text);
    return { ...n, stated: ok, quote: ok ? c.quote : null };
  });
}

/** 6. The verdict: a shopping agent ranks the merchant against the live field for one request. */
export function rankPrompt(intent, listing, products, top = 5) {
  const cands = [
    { id: 'merchant', title: listing.title, text: listingText(listing).slice(0, 900) },
    ...products.slice(0, top).map((p) => ({
      id: p.id, title: p.title,
      text: [p.brand && `Brand: ${p.brand}`, p.price && `Price: ${p.price.amount} ${p.price.currency}`, p.materials.length && `Materials: ${p.materials.join(', ')}`,
        ...p.key_features.slice(0, 6), ...Object.entries(p.attributes).slice(0, 8).map(([k, v]) => `${k}: ${v.join(', ')}`),
        p.rating && `Rating ${p.rating.value} (${p.rating.count})`, p.description?.slice(0, 300)].filter(Boolean).join('\n'),
    })),
  ];
  // shuffle-free but position-neutral: the merchant is not always first
  const order = [...cands.slice(1, 3), cands[0], ...cands.slice(3)];
  return {
    cands,
    system: 'You are an AI shopping agent acting for a buyer. Rank the candidate products for the buyer request, using only what each listing states. A product whose listing does not state a required need loses to one that does. Be strict and brief.',
    user: `BUYER REQUEST: ${intent.query}\nREQUIRED: ${intent.needs.map((n) => `${n.need}=${n.value}`).join('; ')}\n\nCANDIDATES:\n` +
      order.map((c) => `### id=${c.id}\n${c.title}\n${c.text}`).join('\n\n') +
      '\n\nReturn {"ranking":["id", ...all ids best first],"pick_reason":"why #1 wins, <= 25 words","merchant_reason":"why id=merchant is where it is, <= 25 words, name the missing facts","merchant_status":"one of: fits (merchant listing states a match for every required need), missing_facts (it might fit but the listing does not state one or more required needs), not_a_fit (the listing states something that contradicts a required need, e.g. wrong scent, too expensive)"}',
  };
}

export function rankParse(out, intent, cands) {
  const ranking = (out.ranking || []).map(String).filter((id) => cands.some((c) => c.id === id));
  return { intent: intent.id, query: intent.query, rank: ranking.indexOf('merchant') + 1 || cands.length, of: cands.length, winner: ranking[0], winnerTitle: cands.find((c) => c.id === ranking[0])?.title, pick_reason: out.pick_reason, merchant_reason: out.merchant_reason, status: ['fits', 'missing_facts', 'not_a_fit'].includes(out.merchant_status) ? out.merchant_status : 'missing_facts' };
}

export async function rankAsAgent(intent, listing, products, top = 5) {
  const p = rankPrompt(intent, listing, products, top);
  return rankParse(await askJson(p.system, p.user), intent, p.cands);
}

/** 7. Fixes: fill gaps only with facts the merchant already gave (notes/answers); otherwise ask. */
export async function proposeFixes(listing, gaps, facts, { guardrails } = {}) {
  const out = await askJson(
    'You improve a product listing for AI shopping agents. For each missing need, if the merchant facts state it, write the attribute to add and quote the fact. If the facts do not state it, ask the merchant one short question instead. Never invent facts, numbers or policies.',
    `LISTING:\n${listingText(listing)}\n\nMERCHANT FACTS (the only allowed source):\n${facts || '(none)'}\n\nMISSING NEEDS:\n${gaps.map((g) => `- ${g.need} (e.g. ${g.examples.join('; ')})`).join('\n')}\n\n` +
      'Return {"add":[{"need":"label","attribute":"short attribute name","value":"value","fact_quote":"exact words from MERCHANT FACTS"}],"ask":[{"need":"label","question":"question to the merchant"}],"title":"improved title <= 90 chars using only stated facts"}',
    { guardrails },
  );
  const add = (out.add || []).filter((a) => quoted(a.fact_quote, facts || ''));
  const dropped = (out.add || []).filter((a) => !add.includes(a)).map((a) => ({ need: a.need, question: `Please confirm: ${a.attribute} = ${a.value}?` }));
  return { add, ask: [...(out.ask || []), ...dropped], title: out.title };
}

export function applyFixes(listing, fixes) {
  const attributes = { ...(listing.attributes || {}) };
  for (const a of fixes.add) attributes[a.attribute] = a.value;
  return { ...listing, title: fixes.title && fixes.title.length <= 120 ? fixes.title : listing.title, attributes };
}
