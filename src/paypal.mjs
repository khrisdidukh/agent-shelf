// PayPal sandbox: publish the fixed listing to the merchant's PayPal catalog and prove an AI agent can buy it.
// REST v1/v2 with client-credentials OAuth. Sandbox only (api-m.sandbox.paypal.com).
const BASE = process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com';
let tok = null;

export async function token() {
  if (tok && tok.exp > Date.now() + 60_000) return tok.value;
  const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal OAuth ${res.status}: ${await res.text()}`);
  const j = await res.json();
  tok = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return tok.value;
}

async function call(method, path, body, extra = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) { const e = new Error(`PayPal ${method} ${path} ${res.status}: ${json.message || text.slice(0, 300)}`); e.details = json; throw e; }
  return { json, debugId: res.headers.get('paypal-debug-id') };
}

const sku = (l) => (l.sku || l.title).toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 40);

/** Publish (or republish) the listing into the PayPal Catalog Products API, with the agent-readable facts in the description. */
export async function publishProduct(listing) {
  const facts = Object.entries(listing.attributes || {}).map(([k, v]) => `${k}: ${v}`).join('; ');
  const { json } = await call('POST', '/v1/catalogs/products', {
    name: listing.title.slice(0, 127),
    description: `${listing.description || ''} ${facts}`.trim().slice(0, 256),
    type: 'PHYSICAL',
    category: 'GIFTS_AND_FLOWERS',
    ...(listing.image ? { image_url: listing.image } : {}),
    ...(listing.url ? { home_url: listing.url } : {}),
  }, { 'PayPal-Request-Id': `agent-shelf-${sku(listing)}-${Date.now()}` });
  return { id: json.id, name: json.name, description: json.description, created: json.create_time };
}

/** An agent creates an order for exactly the item the buyer asked for; item-level data travels with the order. */
export async function createAgentOrder(listing, { quantity = 1, buyerRequest = '' } = {}) {
  const value = Number(listing.price).toFixed(2), currency = listing.currency || 'USD';
  const { json, debugId } = await call('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: sku(listing),
      description: `Agent purchase: ${buyerRequest}`.slice(0, 127),
      amount: { currency_code: currency, value: (value * quantity).toFixed(2), breakdown: { item_total: { currency_code: currency, value: (value * quantity).toFixed(2) } } },
      items: [{ name: listing.title.slice(0, 127), sku: sku(listing), quantity: String(quantity), category: 'PHYSICAL_GOODS', unit_amount: { currency_code: currency, value },
        description: Object.entries(listing.attributes || {}).map(([k, v]) => `${k}: ${v}`).join('; ').slice(0, 127) }],
    }],
    payment_source: { paypal: { experience_context: { user_action: 'PAY_NOW', shipping_preference: 'GET_FROM_FILE', return_url: process.env.PUBLIC_URL ? process.env.PUBLIC_URL + '/paid' : 'https://example.com/paid', cancel_url: process.env.PUBLIC_URL ? process.env.PUBLIC_URL + '/' : 'https://example.com/' } } },
  }, { 'PayPal-Request-Id': `agent-shelf-order-${Date.now()}` });
  return { id: json.id, status: json.status, approve: json.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href, debugId };
}

export async function getOrder(id) { return (await call('GET', `/v2/checkout/orders/${id}`)).json; }
export async function captureOrder(id) { return (await call('POST', `/v2/checkout/orders/${id}/capture`, {})).json; }
