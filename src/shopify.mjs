// Import a store's products. Works with Shopify's public mock.shop demo stores (Storefront GraphQL, no key)
// and with any live Shopify store's public /products.json feed.
const GQL = `{ shop { name } products(first: 60) { edges { node { id title handle productType vendor tags description onlineStoreUrl
  priceRange { minVariantPrice { amount currencyCode } } options { name values } featuredImage { url } } } } }`;

const strip = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

function fromNode(n, shop, base) {
  return {
    id: n.handle,
    shop,
    title: n.title,
    category: n.productType || '',
    description: strip(n.description),
    price: Number(n.priceRange?.minVariantPrice?.amount) || null,
    currency: n.priceRange?.minVariantPrice?.currencyCode || 'USD',
    attributes: Object.fromEntries((n.options || []).filter((o) => o.name !== 'Title').map((o) => [o.name, o.values.join(', ')])),
    tags: n.tags || [],
    image: n.featuredImage?.url || null,
    url: n.onlineStoreUrl || `${base}/products/${n.handle}`,
    notes: '',
  };
}

/** importStore('https://candles.mock.shop') or a live Shopify store URL -> { shop, products[] } */
export async function importStore(storeUrl) {
  const u = new URL(storeUrl.startsWith('http') ? storeUrl : 'https://' + storeUrl);
  const base = u.origin;
  if (u.hostname.endsWith('.mock.shop')) {
    const res = await fetch(`${base}/api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: GQL }) });
    if (!res.ok) throw new Error(`mock.shop ${res.status}`);
    const d = (await res.json()).data;
    return { shop: d.shop.name, source: base, products: d.products.edges.map((e) => fromNode(e.node, d.shop.name, base)) };
  }
  const res = await fetch(`${base}/products.json?limit=60`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`This store does not expose a public Shopify product feed (${res.status})`);
  const d = await res.json();
  const shop = u.hostname.replace(/^www\./, '');
  return {
    shop, source: base,
    products: d.products.map((p) => fromNode({
      handle: p.handle, title: p.title, productType: p.product_type, vendor: p.vendor, tags: typeof p.tags === 'string' ? p.tags.split(', ') : p.tags,
      description: p.body_html, priceRange: { minVariantPrice: { amount: p.variants?.[0]?.price, currencyCode: 'USD' } },
      options: p.options, featuredImage: p.images?.[0] ? { url: p.images[0].src } : null,
    }, shop, base)),
  };
}
