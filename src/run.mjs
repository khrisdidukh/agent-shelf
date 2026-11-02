// Full Agent Shelf pass for one listing: before -> fixes -> after, plus the PayPal steps.
import * as S from './shelf.mjs';
import * as OT from './otari.mjs';
import { protect } from './guard.mjs';

export async function analyse(listing, { n = 8, log = () => {} } = {}) {
  log('Writing the requests real buyers send to shopping agents');
  const intents = await S.buyerIntents(listing, n);
  log('Asking the live product catalog what agents see for each request');
  const field = await S.agentField(intents);
  const agent = S.agentNeeds(field);
  const customer = S.customerNeeds(intents);
  log('Reading the listing the way an agent does');
  const checks = await S.checkListing(listing, customer);
  log('Letting a shopping agent rank the listing against the field');
  const verdicts = [];
  for (const f of field) verdicts.push(await S.rankAsAgent(f.intent, listing, f.products));
  return { listing, intents, field: field.map((f) => ({ intent: f.intent.id, products: f.products })), agent, customer, checks, verdicts, score: score(checks, verdicts) };
}

export function score(checks, verdicts) {
  const stated = checks.reduce((s, c) => s + (c.stated ? c.count : 0), 0) / (checks.reduce((s, c) => s + c.count, 0) || 1);
  const top3 = verdicts.filter((v) => v.rank <= 3).length / (verdicts.length || 1);
  const wins = verdicts.filter((v) => v.rank === 1).length;
  const lostToMissing = verdicts.filter((v) => v.rank > 1 && v.status === 'missing_facts').length;
  return { needsStated: stated, top3, wins, lostToMissing, notAFit: verdicts.filter((v) => v.status === 'not_a_fit').length, requests: verdicts.length, avgRank: verdicts.reduce((s, v) => s + v.rank, 0) / (verdicts.length || 1) };
}

export async function improve(report, facts, { log = () => {} } = {}) {
  log('Filling gaps from facts you already gave, asking about the rest');
  const gaps = report.checks.filter((c) => !c.stated);
  // Otari mode: the merchant's answers pass the input guardrail (personal data, prompt injection, Llama Guard) first
  let guarded = null;
  if (OT.on()) { log('Checking your answers with the input guardrail'); guarded = await protect(facts); }
  const fixes = await S.proposeFixes(report.listing, gaps, facts, { guardrails: guarded?.guardrails });
  const after = S.applyFixes(report.listing, fixes);
  log('Re-checking the improved listing');
  const checks = await S.checkListing(after, report.customer);
  const verdicts = [];
  for (const f of report.field) {
    const intent = report.intents.find((i) => i.id === f.intent);
    verdicts.push(await S.rankAsAgent(intent, after, f.products));
  }
  return { fixes, listing: after, checks, verdicts, score: score(checks, verdicts), guard: guarded && { by: guarded.by, model: guarded.verdict?.guard?.served || null } };
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

/** Store-wide audit: for every product, which buyer needs of its product type does the listing state? */
export async function auditStore(store, { log = () => {} } = {}) {
  log(`Naming product types for ${store.products.length} products`);
  await pool(store.products, 6, async (p) => { p.genericType ??= await S.genericType(p); });
  const byType = new Map();
  for (const p of store.products) { if (!byType.has(p.genericType)) byType.set(p.genericType, []); byType.get(p.genericType).push(p); }
  log(`Writing buyer requests for ${byType.size} product types`);
  const needsByType = new Map();
  await pool([...byType.keys()], 6, async (type) => needsByType.set(type, S.customerNeeds(await S.buyerIntents(byType.get(type)[0]))));
  let done = 0;
  const rows = await pool(store.products, 6, async (p) => {
    const checks = await S.checkListing(p, needsByType.get(p.genericType));
    log(`Read ${++done} of ${store.products.length} listings as an agent`);
    const total = checks.reduce((s, c) => s + c.count, 0) || 1;
    return { id: p.id, title: p.title, type: p.genericType, price: p.price, currency: p.currency, image: p.image,
      stated: checks.reduce((s, c) => s + (c.stated ? c.count : 0), 0) / total,
      top: checks.slice(0, 6).map((c) => ({ need: c.need, share: c.share, stated: c.stated })) };
  });
  return { shop: store.shop, source: store.source, rows: rows.sort((a, b) => a.stated - b.stated) };
}
