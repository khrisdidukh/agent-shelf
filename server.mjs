// Agent Shelf web server: plain node http, no framework. Jobs run in memory; finished reports are cached on disk.
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { analyse, improve, auditStore } from './src/run.mjs';
import { importStore } from './src/shopify.mjs';
import { buy } from './src/buyer-agent.mjs';
import { publishProduct, getOrder, captureOrder } from './src/paypal.mjs';
import { mcpHandler } from './src/mcp.mjs';

const ROOT = new URL('./web/', import.meta.url).pathname;
const REPORTS = new URL('./cache/reports/', import.meta.url);
mkdirSync(REPORTS, { recursive: true });
const DEMO_STORE = 'https://candles.mock.shop';
const DEMO_ANSWERS = JSON.parse(readFileSync(new URL('./fixtures/demo-answers.json', import.meta.url), 'utf8'));
const jobs = new Map();
const stores = new Map(); // source -> imported store
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, bad) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 60_000) bad(new Error('Request too large')); }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { bad(e); } }); });
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const saved = (name) => { const f = new URL(name + '.json', REPORTS); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };
const save = (name, v) => writeFileSync(new URL(name + '.json', REPORTS), JSON.stringify(v));

// a small daily budget so a public demo can't run up the model bill
let budget = { day: '', used: 0 };
function spend(n = 1) {
  const d = new Date().toISOString().slice(0, 10);
  if (budget.day !== d) budget = { day: d, used: 0 };
  if (budget.used + n > Number(process.env.DAILY_RUNS || 60)) throw new Error('The live demo has reached today\'s limit. The recorded demo below still works.');
  budget.used += n;
}

function startJob(kind, fn) {
  const job = { id: randomUUID(), kind, status: 'running', steps: [], result: null, error: null };
  jobs.set(job.id, job);
  fn((m) => job.steps.push({ at: Date.now(), text: m }))
    .then((r) => { job.result = r; job.status = 'done'; })
    .catch((e) => { job.error = e.message; job.status = 'failed'; console.error(kind, e); });
  return job;
}

async function getStore(url) {
  const src = new URL(url.startsWith('http') ? url : 'https://' + url).origin;
  if (!stores.has(src)) stores.set(src, await importStore(src));
  return stores.get(src);
}

// shared by the web API and the MCP server: cached report or a fresh run
async function storeReport(url) {
  const st = await getStore(url || DEMO_STORE);
  const key = 'store-' + hash(st.source);
  let a = saved(key);
  if (!a) { spend(3); a = await auditStore(st); save(key, a); }
  return a;
}
async function productReport(url, id) {
  const st = await getStore(url || DEMO_STORE);
  const p = st.products.find((x) => x.id === id);
  if (!p) throw new Error('No such product in this store');
  const key = 'product-' + hash(st.source + id);
  let r = saved(key);
  if (!r) { spend(1); r = await analyse(p); save(key, r); }
  return r;
}
const mcp = mcpHandler({ storeReport, productReport });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
      return mcp(req, res, await readBody(req));
    }
    if (url.pathname === '/api/config') return send(res, 200, { demoStore: DEMO_STORE, demoAnswers: DEMO_ANSWERS, paypal: 'sandbox' });
    if (url.pathname.startsWith('/api/job/')) {
      const j = jobs.get(url.pathname.split('/').pop());
      return j ? send(res, 200, j) : send(res, 404, { error: 'This job is gone (the server restarted). Run it again.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/store') {
      const { store } = await readBody(req);
      const st = await getStore(store || DEMO_STORE);
      const key = 'store-' + hash(st.source);
      const cached = saved(key);
      if (cached) return send(res, 200, { done: { ...cached, products: st.products } });
      spend(3);
      const job = startJob('store', async (log) => { const a = await auditStore(st, { log }); save(key, a); return { ...a, products: st.products }; });
      return send(res, 202, { job: job.id });
    }
    if (req.method === 'POST' && url.pathname === '/api/product') {
      const { store, id } = await readBody(req);
      const st = await getStore(store || DEMO_STORE);
      const p = st.products.find((x) => x.id === id);
      if (!p) throw new Error('No such product in this store');
      const key = 'product-' + hash(st.source + id);
      const cached = saved(key);
      if (cached) return send(res, 200, { done: cached });
      spend(1);
      const job = startJob('product', async (log) => { const r = await analyse(p, { log }); save(key, r); return r; });
      return send(res, 202, { job: job.id });
    }
    if (req.method === 'POST' && url.pathname === '/api/improve') {
      const { store, id, answers } = await readBody(req);
      const st = await getStore(store || DEMO_STORE);
      const report = saved('product-' + hash(st.source + id));
      if (!report) throw new Error('Analyse the product first');
      const facts = Object.entries(answers || {}).filter(([, v]) => String(v).trim()).map(([k, v]) => `${k}: ${String(v).slice(0, 400)}`).join('\n');
      const key = 'improve-' + hash(st.source + id + facts);
      const cached = saved(key);
      if (cached) return send(res, 200, { done: cached });
      spend(1);
      const job = startJob('improve', async (log) => { const r = await improve(report, facts, { log }); save(key, r); return r; });
      return send(res, 202, { job: job.id });
    }
    if (req.method === 'POST' && url.pathname === '/api/questions') {
      const { store, id } = await readBody(req);
      const st = await getStore(store || DEMO_STORE);
      const report = saved('product-' + hash(st.source + id));
      if (!report) throw new Error('Analyse the product first');
      const gaps = report.checks.filter((c) => !c.stated);
      return send(res, 200, { questions: gaps.map((g) => ({ need: g.need, share: g.share, examples: g.examples })) });
    }
    if (req.method === 'POST' && url.pathname === '/api/buy') {
      const { listing, request } = await readBody(req);
      if (!listing?.title || !request) throw new Error('A listing and a buyer request are needed');
      spend(1);
      const job = startJob('buy', async (log) => { log('The shopping agent reads the request and the listing'); return buy(listing, String(request).slice(0, 300)); });
      return send(res, 202, { job: job.id });
    }
    if (req.method === 'POST' && url.pathname === '/api/publish') {
      const { listing } = await readBody(req);
      spend(1);
      return send(res, 200, await publishProduct(listing));
    }
    if (url.pathname.startsWith('/api/order/')) {
      const id = url.pathname.split('/').pop().replace(/[^A-Z0-9]/g, '');
      if (req.method === 'POST') {
        const o = await getOrder(id);
        return send(res, 200, o.status === 'APPROVED' ? await captureOrder(id) : o);
      }
      return send(res, 200, await getOrder(id));
    }
    // static (AG Grid served from the installed package, no CDN)
    if (url.pathname.startsWith('/vendor/ag-grid/')) {
      const name = url.pathname.split('/').pop();
      const f = name.endsWith('.css') ? `node_modules/ag-grid-community/styles/${name}` : `node_modules/ag-grid-community/dist/${name}`;
      const file = new URL('./' + f, import.meta.url).pathname;
      if (/^[A-Za-z.-]+$/.test(name) && existsSync(file)) { res.writeHead(200, { 'Content-Type': TYPES[extname(file)], 'Cache-Control': 'public, max-age=86400' }); return res.end(readFileSync(file)); }
    }
    let p = normalize(join(ROOT, url.pathname === '/' || url.pathname === '/paid' ? 'index.html' : url.pathname));
    if (!p.startsWith(ROOT) || !existsSync(p)) p = join(ROOT, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(readFileSync(p));
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

server.listen(process.env.PORT || 8790, () => console.log('agent-shelf on', server.address().port));
