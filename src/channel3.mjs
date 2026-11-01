// What AI shopping agents actually see: live product search over Channel3's universal product catalog.
// Responses are cached on disk (cache/channel3) so a demo run is reproducible and judges see the same field.
import { Channel3 } from '@channel3/sdk';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const CACHE = new URL('../cache/channel3/', import.meta.url);
let client;

function compact(p) {
  const offer = p.offers?.[0];
  return {
    id: p.id,
    title: p.title,
    brand: p.brands?.[0]?.name ?? null,
    description: p.description ? p.description.slice(0, 600) : null,
    category: p.category?.title ?? null,
    materials: p.materials ?? [],
    key_features: p.key_features ?? [],
    attributes: p.structured_attributes ?? {},
    colors: (p.colors ?? []).map((c) => c.hex).filter(Boolean),
    price: offer?.price ? { amount: offer.price.price, currency: offer.price.currency } : null,
    availability: offer?.availability ?? null,
    domain: offer?.domain ?? null,
    url: offer?.url ?? null,
    image: p.images?.[0]?.url ?? null,
    rating: p.ratings ? { value: p.ratings.value, count: p.ratings.count } : null,
    dimensions: offer?.dimensions ?? null,
  };
}

/** search(query, limit) -> compact products, as an AI shopping agent would receive them */
export async function search(query, limit = 8) {
  const key = createHash('sha256').update(query + '|' + limit).digest('hex').slice(0, 20);
  const file = new URL(key + '.json', CACHE);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')).products;
  if (!process.env.CHANNEL3_API_KEY) throw new Error('CHANNEL3_API_KEY is not set and no cached result for: ' + query);
  client ??= new Channel3({ apiKey: process.env.CHANNEL3_API_KEY });
  const page = await client.products.search({ query, limit, filters: { availability: ['InStock'] } });
  const products = (page.response?.products ?? []).map(compact);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, JSON.stringify({ query, at: new Date().toISOString(), products }, null, 1));
  return products;
}
