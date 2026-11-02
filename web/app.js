const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x) => Math.round(x * 100) + '%';
const state = { config: null, store: null, products: [], product: null, report: null, after: null, mode: 'customer', grid: null };

function progress(text) {
  const p = $('#progress');
  if (!text) { p.hidden = true; return; }
  p.hidden = false; $('#progressText').textContent = text;
}

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

// POST that may answer at once ({done}) or start a job ({job}) that we poll
async function run(path, body, label) {
  const first = await api(path, body);
  if (first.done) return first.done;
  if (!first.job) return first;
  progress(label);
  for (;;) {
    await new Promise((r) => setTimeout(r, 1200));
    const j = await api('/api/job/' + first.job);
    const last = j.steps[j.steps.length - 1];
    if (last) progress(last.text);
    if (j.status === 'done') { progress(); return j.result; }
    if (j.status === 'failed') { progress(); throw new Error(j.error); }
  }
}

function fail(where, e) {
  progress();
  const p = document.createElement('p');
  p.className = 'err'; p.textContent = e.message;
  where.appendChild(p);
  setTimeout(() => p.remove(), 9000);
}

/* ---------- shelf ---------- */
async function readShelf(store) {
  const btn = $('#storeForm button'); btn.disabled = true;
  try {
    const a = await run('/api/store', { store }, 'Reading the store');
    state.store = store; state.products = a.products;
    $('#shelf').hidden = false;
    const weak = a.rows.filter((r) => r.stated < 0.5).length;
    $('#shelfSummary').textContent = `${a.shop}: ${a.rows.length} products. In ${weak} of them the listing states less than half of what buyers ask agents for.`;
    drawGrid(a.rows);
    $('#shelf').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  } catch (e) { fail($('#storeForm'), e); }
  btn.disabled = false;
}

function drawGrid(rows) {
  const opts = {
    rowData: rows,
    rowHeight: 52,
    rowSelection: 'single',
    columnDefs: [
      { headerName: 'Product', field: 'title', flex: 2, minWidth: 220, cellRenderer: (p) => `<span class="cell-prod">${p.data.image ? `<img src="${esc(p.data.image)}&width=80" alt="">` : ''}<span>${esc(p.value)}</span></span>` },
      { headerName: 'Buyers search for', field: 'type', flex: 1, minWidth: 140 },
      { headerName: 'Price', field: 'price', width: 100, valueFormatter: (p) => p.value != null ? `$${Number(p.value).toFixed(2)}` : '' },
      { headerName: 'Agent-readable', field: 'stated', width: 170, sort: 'asc', cellRenderer: (p) => `<span class="meter"><i><b style="width:${pct(p.value)}"></b></i>${pct(p.value)}</span>` },
      { headerName: 'What buyers ask about', field: 'top', flex: 2, minWidth: 260, sortable: false, cellRenderer: (p) => `<span class="chips">${p.value.filter((t) => !/price|budget|cost/.test(t.need)).slice(0, 4).map((t) => `<span class="chip ${t.stated ? 'on' : 'off'}">${esc(t.need)}</span>`).join('')}</span>` },
    ],
    defaultColDef: { sortable: true, resizable: true },
    onRowClicked: (e) => openProduct(e.data.id),
  };
  $('#grid').innerHTML = '';
  state.grid = agGrid.createGrid($('#grid'), opts);
}

/* ---------- product ---------- */
async function openProduct(id) {
  state.product = state.products.find((p) => p.id === id);
  state.after = null;
  ['#after', '#buy', '#panelOut', '#useAfterWrap'].forEach((s) => ($(s).hidden = true));
  try {
    const r = await run('/api/product', { store: state.store, id }, 'Asking agents about this product');
    state.report = r;
    drawProduct();
    await drawQuestions();
    $('#product').hidden = false; $('#ask').hidden = false;
    if (state.config.otari?.on) showPanel();
    $('#product').scrollIntoView({ behavior: 'smooth' });
  } catch (e) { fail($('#shelf'), e); }
}

function verdictLine(s) {
  const fit = s.notAFit ? ` ${s.notAFit} ${s.notAFit === 1 ? 'buyer wants' : 'buyers want'} something this product isn’t, and that’s fine.` : '';
  return `Picked first in <em>${s.wins} of ${s.requests}</em> buyer requests. Lost ${s.lostToMissing} only because the listing doesn’t say enough.${fit}`;
}

function drawProduct() {
  const p = state.product, r = state.report;
  $('#pTitle').textContent = p.title;
  $('#pVerdict').innerHTML = verdictLine(r.score);
  $('#pImg').src = p.image ? p.image + '&width=900' : '';
  $('#pImg').alt = p.title;
  $('#pDesc').textContent = p.description || '(no description)';
  $('#pPrice').textContent = p.price != null ? `$${p.price.toFixed(2)}` : '';
  drawSlots();
  drawRequests($('#requests'), r);
}

function drawSlots() {
  const r = state.after || state.report;
  const ul = $('#slots');
  if (state.mode === 'customer') {
    ul.innerHTML = r.checks.map((c) => `<li class="slot ${c.stated ? 'on' : 'off'}"><span class="n">${esc(c.need)}</span><span class="q">${c.stated ? '“' + esc(c.quote) + '”' : 'not stated'}</span><span class="s">${c.count} of ${state.report.intents.length} buyers</span></li>`).join('');
    $('#slotsNote').textContent = 'Buyer needs come from the requests below. A need counts only when the listing states it; the quote is checked word for word.';
  } else {
    const a = state.report.agent;
    const l = (state.after || state.report).listing;
    ul.innerHTML = a.rows.slice(0, 12).map((x) => {
      const has = merchantHas(x.field, l, r.checks);
      const you = has === null ? 'you: n/a' : has ? 'you: stated' : 'you: missing';
      return `<li class="slot ${has === false ? 'off' : 'on'}"><span class="n">${esc(x.field)}</span><span class="q">${pct(x.coverage)} of competing products state it</span><span class="s">${you}</span></li>`;
    }).join('');
    $('#slotsNote').textContent = `Measured on ${a.sample} competing products that a live product search (Channel3) returned for these buyer requests: this is what agents are used to receiving. Marked: what your listing has.`;
  }
}

// does the merchant's listing carry a field that competing products carry? (null = not applicable to a Shopify listing)
function merchantHas(field, l, checks) {
  const stated = (re) => checks.some((c) => c.stated && re.test(c.need));
  const attrs = Object.keys(l.attributes || {}).map((k) => k.toLowerCase());
  const key = field.toLowerCase().split(/[^a-z]+/).filter((w) => w && w !== 'candle')[0] || '';
  const syn = { material: 'material|wax', type: 'type|wax', container: 'container|vessel', scent: 'scent|fragrance' }[key] || key;
  switch (field) {
    case 'price': return l.price != null;
    case 'image': return !!l.image;
    case 'brand': return !!l.shop;
    case 'in-stock signal': return null;
    case 'rating & reviews': return false;
    case 'description 300+ chars': return (l.description || '').length >= 300;
    case '3+ key features': return attrs.length >= 5;
    case 'dimensions': return stated(/size|dimension/);
    case 'materials': return stated(/material|wax|container/);
  }
  if (key && attrs.some((k) => new RegExp(syn).test(k))) return true;
  return key ? stated(new RegExp(syn)) : false;
}

function drawRequests(ol, r) {
  ol.innerHTML = r.verdicts.map((v) => {
    const pips = Array.from({ length: v.of }, (_, i) => `<span class="pip ${i + 1 === v.rank ? 'me' + (v.rank === 1 ? ' first' : '') : ''}">${i + 1 === v.rank ? 'you' : i + 1}</span>`).join('');
    const st = v.rank === 1 ? 'fits' : v.status;
    const label = v.rank === 1 ? 'picked first' : ({ fits: 'fits, ranked lower', missing_facts: 'lost: missing facts', not_a_fit: 'not a fit' }[v.status] || v.status);
    return `<li class="req"><span class="qy">“${esc(v.query)}”</span><span class="pips" aria-label="ranked ${v.rank} of ${v.of}">${pips}</span><span class="why"><span class="status ${st}">${label}.</span> ${esc(v.merchant_reason)}</span></li>`;
  }).join('');
}

async function drawQuestions() {
  const { questions } = await api('/api/questions', { store: state.store, id: state.product.id });
  const n = state.report.intents.length;
  $('#askForm').innerHTML = questions.map((q, i) => `<label>${esc(q.need)} <small>· ${Math.round(q.share * n)} of ${n} buyers ask, e.g. “${esc(q.examples[0])}”</small><input name="${esc(q.need)}" data-i="${i}" placeholder="Your answer, or leave empty if it does not apply"></label>`).join('');
  const demo = state.config.demoAnswers[state.product.id];
  $('#demoAnswers').hidden = !demo;
}

async function rewrite() {
  const answers = {};
  for (const i of $('#askForm').querySelectorAll('input')) if (i.value.trim()) answers[i.name] = i.value.trim();
  if (!Object.keys(answers).length) return fail($('#ask'), new Error('Answer at least one question first.'));
  $('#rewrite').disabled = true;
  try {
    const a = await run('/api/improve', { store: state.store, id: state.product.id, answers }, 'Rewriting for agents');
    state.after = a;
    drawAfter();
  } catch (e) { fail($('#ask'), e); }
  $('#rewrite').disabled = false;
}

function drawAfter() {
  const b = state.report.score, a = state.after.score;
  $('#after').hidden = false;
  $('#aVerdict').innerHTML = verdictLine(a);
  $('#sWins').innerHTML = `<s>${b.wins}</s>${a.wins} of ${a.requests}`;
  $('#sMissing').innerHTML = `<s>${b.lostToMissing}</s>${a.lostToMissing}`;
  $('#sStated').innerHTML = `<s>${pct(b.needsStated)}</s>${pct(a.needsStated)}`;
  $('#aTitle').textContent = state.after.listing.title;
  if (state.after.guard) $('#aTitle').title = 'Your answers passed the input guardrail (' + (state.after.guard.by === 'otari' ? 'enforced by Otari' : 'run by the app') + ')';
  $('#added').innerHTML = state.after.fixes.add.map((x) => `<li><span class="a">${esc(x.attribute)}</span><span>${esc(x.value)}</span><span class="from">from your answer: “${esc(x.fact_quote)}”</span></li>`).join('');
  drawRequests($('#requestsAfter'), state.after);
  drawSlots();
  const win = state.after.verdicts.find((v) => v.rank === 1) || state.after.verdicts[0];
  $('#buyRequest').value = state.config.demoRequests?.[state.product.id] || (win ? win.query : '');
  $('#buy').hidden = false;
  $('#useAfterWrap').hidden = !state.config.otari?.on;
  $('#after').scrollIntoView({ behavior: 'smooth' });
}

/* ---------- Otari: the agent panel ---------- */
const money = (x) => x == null ? '' : '$' + (x < 0.01 ? Number(x).toFixed(4) : Number(x).toFixed(2));
const short = (m) => String(m || '').split('/').pop();

async function drawBudget() {
  try {
    const b = await api('/api/budget?store=' + encodeURIComponent(state.store || state.config.demoStore));
    if (b.mode === 'off') return;
    const used = Math.min(1, b.spent / (b.limit || 1));
    const who = b.mode === 'otari-end-user' ? 'Otari end user' : 'this store';
    $('#budget').innerHTML = `<span class="k">AI budget for ${esc(who)} <b>${esc(b.merchant.replace('merchant:', ''))}</b></span>
      <span class="meter wide"><i><b style="width:${pct(used)}"></b></i></span>
      <span class="v">${money(b.spent)} of ${money(b.limit)} used · ${b.calls} calls${b.otari ? ` · Otari spend ${money(b.otari.spend)}${b.otari.blocked ? ' · blocked' : ''}` : ''}</span>`;
  } catch {}
}

function showPanel() {
  $('#panel').hidden = false;
  $('#panelIntent').innerHTML = state.report.intents.map((i) => `<option value="${esc(i.id)}">${esc(i.query)}</option>`).join('');
  drawBudget();
}

function served(meta) {
  if (!meta) return '';
  const fb = (meta.skipped || []).map((s) => `<span class="badge warn" title="${esc(s.error)}">fallback: ${esc(short(s.model))} → ${esc(short(meta.requested))}</span>`).join('');
  const ofb = meta.otariFallback ? `<span class="badge warn">Otari provider fallback (${meta.attempts} tries)</span>` : '';
  return `<p class="served"><span class="mono">${esc(meta.served || meta.model)}</span> via ${esc(meta.provider || '?')} ${fb}${ofb}<span class="cost">${money(meta.cost)} · ${(meta.ms / 1000).toFixed(1)}s</span></p>`;
}

function drawPanel(r) {
  $('#panelOut').hidden = false;
  $('#agents').innerHTML = r.agents.map((a) => {
    if (!a.verdict) return `<article class="card agent-card"><h3>${esc(a.label)}</h3><p class="err">${esc(a.error)}</p></article>`;
    const v = a.verdict;
    const pips = Array.from({ length: v.of }, (_, i) => `<span class="pip ${i + 1 === v.rank ? 'me' + (v.rank === 1 ? ' first' : '') : ''}">${i + 1 === v.rank ? 'you' : i + 1}</span>`).join('');
    const label = v.rank === 1 ? 'picked you first' : ({ fits: 'fits, ranked lower', missing_facts: 'missing facts', not_a_fit: 'not a fit' }[v.status] || v.status);
    return `<article class="card agent-card"><h3>${esc(a.label)}</h3>${served(a.meta)}
      <p class="pips">${pips}</p><p><span class="status ${v.rank === 1 ? 'fits' : v.status}">${esc(label)}.</span> ${esc(v.merchant_reason || '')}</p>
      <p class="hint">Picked: ${esc(v.winner === 'merchant' ? 'your product' : (v.winnerTitle || v.winner))}. ${esc(v.pick_reason || '')}</p></article>`;
  }).join('');

  const p = r.price, st = p.stats;
  $('#priceCard').innerHTML = `<h3>Price position</h3>${served(p.meta)}
    <p class="big">${st.percentile}% <small>of ${st.n} competing products are cheaper</small></p>
    <dl class="kv"><dt>Median competitor</dt><dd>${money(st.median)} (you: ${st.gap_to_median >= 0 ? '+' : ''}${money(Math.abs(st.gap_to_median)).replace('$', st.gap_to_median < 0 ? '−$' : '$')})</dd><dt>Range</dt><dd>${money(st.min)} – ${money(st.max)}</dd>${st.within_budget_pct != null ? `<dt>Within buyer’s ${money(p.ceiling)}</dt><dd>${st.within_budget_pct}% of competitors</dd>` : ''}</dl>
    <p class="hint">${p.error ? 'The sandbox step failed (' + esc(p.error) + '); these numbers are computed by the app.' : `Computed with Python in Otari’s code-execution sandbox${p.verified ? ', and the app recomputed every number: they match.' : '; the app’s own numbers differ, so those are shown.'}`}</p>
    ${p.code ? `<details><summary>Code the model ran</summary><div class="call">${esc(p.code)}</div></details>` : ''}`;

  const w = r.web;
  $('#webCard').innerHTML = `<h3>Live web check</h3>${served(w.meta)}` + (w.skipped
    ? `<p class="hint">Not run: ${esc(w.skipped)}. In Otari: Tools &amp; Guardrails → Web search, turn web access on for this workspace.</p>`
    : `${w.page ? `<p class="hint">Read with Otari web fetch: <a href="${esc(w.target)}" target="_blank" rel="noopener">a competing product page</a></p>` : ''}
       <ul class="facts">${(w.competitor_facts || []).map((f) => `<li><b>${esc(f.fact)}</b> “${esc(f.quote)}”</li>`).join('')}</ul>
       ${(w.buyer_checklist || []).length ? `<p class="hint">What buyers are told to check (Otari web search):</p><ul class="facts">${w.buyer_checklist.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}${w.note ? `<p class="hint">${esc(w.note)}</p>` : ''}`);

  const a = r.analysis;
  const g = a.guard;
  const guardLine = g.by === 'otari'
    ? `Input guardrail enforced by Otari (block mode): ${esc(JSON.stringify(g.otari || 'passed'))}`
    : `Input guardrail passed: Llama Guard 4 ${g.verdict?.model ? '(' + esc(g.verdict.model) + ')' : ''} + personal-data and prompt-injection checks, run by the app because Otari can’t reach localhost.`;
  const mcpLine = a.mcp.used
    ? `Read Agent Shelf’s diagnosis through MCP (<span class="mono">product_gaps</span>, called by Otari). ${a.mcp.verified ? 'Its quote matches the tool’s answer: “' + esc(a.mcp.quote) + '”' : 'Its quote did not match the tool’s answer, so treat it with care.'}`
    : `MCP not used: ${esc(a.mcp.error || '')}`;
  $('#analystCard').innerHTML = `<h3>The analyst</h3>${served(a.meta)}
    <p class="decision">${esc(a.headline || '')}</p>
    <dl class="kv"><dt>Agents agree</dt><dd>${esc(a.agree || '')}</dd><dt>They differ</dt><dd>${esc(a.disagree || '')}</dd></dl>
    <ol class="fixes">${a.fixes.map((f) => `<li><b>${esc(f.change)}</b> <span class="hint">${esc(f.why || '')}</span> ${(f.agents || []).map((x) => `<span class="badge">${esc(x)}</span>`).join('')}${f.unverified?.length ? ` <span class="badge warn">numbers ${esc(f.unverified.join(', '))} are examples, not your facts</span>` : ''}</li>`).join('')}</ol>
    ${a.ask.length ? `<p class="hint">Questions for you:</p><ul class="facts">${a.ask.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
    <p class="hint">${mcpLine}</p><p class="hint">${guardLine}</p>`;

  const all = [];
  for (const e of r._events || []) all.push(e);
  $('#calls').innerHTML = `<table><thead><tr><th>Role</th><th>Model asked</th><th>Answered by</th><th>Provider</th><th>Cost</th><th>Note</th></tr></thead><tbody>${all.map((e) => e.type === 'call'
    ? `<tr><td>${esc(e.role)}</td><td class="mono">${esc(e.requested)}</td><td class="mono">${esc(e.served)}</td><td>${esc(e.provider)}</td><td>${money(e.cost)}</td><td>${e.otariFallback ? 'Otari fallback' : ''}${e.guardrails ? ' guardrail ' + esc(JSON.stringify(e.guardrails)) : ''}</td></tr>`
    : `<tr class="fb"><td>${esc(e.role)}</td><td class="mono">${esc(e.model)}</td><td colspan="2">failed, next model</td><td>${money(e.cost)}</td><td>${esc(e.reason)}</td></tr>`).join('')}</tbody></table>
    <p class="hint">Total this run: ${money(all.reduce((s, e) => s + (e.cost || 0), 0))}. “Answered by” and “Provider” come from Otari’s response headers.</p>`;
  if (r.budget) drawBudget();
}

async function runAgentPanel(ev) {
  ev.preventDefault();
  const btn = $('#panelForm button'); btn.disabled = true;
  try {
    const listing = state.after && $('#useAfter').checked ? state.after.listing : undefined;
    const first = await api('/api/panel', { store: state.store, id: state.product.id, intent: $('#panelIntent').value, listing });
    progress('Asking three shopping agents');
    let j;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1200));
      j = await api('/api/job/' + first.job);
      const last = j.steps[j.steps.length - 1];
      if (last) progress(last.text);
      if (j.status !== 'running') break;
    }
    progress();
    if (j.status === 'failed') throw new Error(j.error);
    drawPanel({ ...j.result, _events: j.events });
    $('#panelOut').scrollIntoView({ behavior: 'smooth' });
  } catch (e) { fail($('#panelForm'), e); drawBudget(); }
  btn.disabled = false;
}

/* ---------- agent purchase ---------- */
async function sendAgent(ev) {
  ev.preventDefault();
  const listing = state.after?.listing || state.product;
  const btn = $('#buyForm button[type=submit]'); btn.disabled = true;
  try {
    const r = await run('/api/buy', { listing, request: $('#buyRequest').value }, 'The shopping agent is deciding');
    const out = $('#buyOut'); out.hidden = false;
    const call = r.transcript.find((t) => t.tool === 'create_order' && t.args);
    out.innerHTML = `<p class="decision">${r.decision === 'buy' ? 'The agent is buying it.' : 'The agent skipped it.'}</p><p>${esc(r.reason || '')}</p>` +
      (call ? `<p class="hint">Tool call through the PayPal Agent Toolkit:</p><div class="call">create_order(${esc(JSON.stringify(call.args, null, 2))})</div>` : '') +
      (r.order ? `<dl class="kv"><dt>PayPal order</dt><dd>${esc(r.order.id)}</dd><dt>Status</dt><dd>${esc(r.order.status)}</dd></dl>
        <p>The buyer now confirms in PayPal. <a class="btn primary" href="${esc(r.order.approve)}" target="_blank" rel="noopener">Approve as the buyer (sandbox)</a></p>
        <p class="hint">After approval PayPal returns to this page and the payment is captured.</p>` : '');
    try { localStorage.setItem('agentShelfLast', JSON.stringify({ order: r.order?.id, title: listing.title })); } catch {}
  } catch (e) { fail($('#buyForm'), e); }
  btn.disabled = false;
}

async function publish() {
  const listing = state.after?.listing || state.product;
  $('#publish').disabled = true;
  try {
    const p = await api('/api/publish', { listing });
    const out = $('#buyOut'); out.hidden = false;
    out.insertAdjacentHTML('afterbegin', `<dl class="kv"><dt>PayPal catalog product</dt><dd>${esc(p.id)}</dd><dt>Name</dt><dd>${esc(p.name)}</dd></dl>`);
  } catch (e) { fail($('#buyForm'), e); }
  $('#publish').disabled = false;
}

async function returnedFromPayPal() {
  const token = new URLSearchParams(location.search).get('token');
  if (location.pathname !== '/paid' || !token) return false;
  $('#paid').hidden = false;
  $('#paidOut').innerHTML = '<p>Capturing the payment…</p>';
  try {
    const o = await api('/api/order/' + encodeURIComponent(token), {});
    const cap = o.purchase_units?.[0]?.payments?.captures?.[0];
    const item = o.purchase_units?.[0]?.items?.[0];
    $('#paidOut').innerHTML = `<p class="decision">${o.status === 'COMPLETED' ? 'Paid. The agent’s order is complete.' : 'Order status: ' + esc(o.status)}</p>
      <dl class="kv"><dt>Order</dt><dd>${esc(o.id)}</dd>${item ? `<dt>Item</dt><dd>${esc(item.name)}</dd>` : ''}${cap ? `<dt>Captured</dt><dd>${esc(cap.amount.value)} ${esc(cap.amount.currency_code)} · ${esc(cap.status)}</dd><dt>Capture id</dt><dd>${esc(cap.id)}</dd>` : ''}${o.payer?.email_address ? `<dt>Buyer (sandbox)</dt><dd>${esc(o.payer.email_address)}</dd>` : ''}</dl>
      <p><a href="/">Back to Agent Shelf</a></p>`;
  } catch (e) { $('#paidOut').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  return true;
}

/* ---------- wire up ---------- */
document.querySelectorAll('.toggle button').forEach((b) => b.addEventListener('click', () => {
  state.mode = b.dataset.mode;
  document.querySelectorAll('.toggle button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  drawSlots();
}));
$('#storeForm').addEventListener('submit', (e) => { e.preventDefault(); readShelf($('#storeUrl').value.trim()); });
$('#rewrite').addEventListener('click', rewrite);
$('#demoAnswers').addEventListener('click', () => {
  const demo = state.config.demoAnswers[state.product.id] || {};
  for (const i of $('#askForm').querySelectorAll('input')) if (demo[i.name]) i.value = demo[i.name];
});
$('#buyForm').addEventListener('submit', sendAgent);
$('#panelForm').addEventListener('submit', runAgentPanel);
$('#publish').addEventListener('click', publish);

(async () => {
  state.config = await api('/api/config');
  if (state.config.otari?.on) {
    $('#topNote').textContent = 'Models: open-weight, through Otari · PayPal sandbox · product data from Channel3';
    document.querySelector('.foot p').textContent = 'Agent Shelf · open-weight models (Llama, Qwen, Gemma, Mistral, DeepSeek, Llama Guard) through Mozilla.ai’s Otari gateway · PayPal runs in sandbox, no real money moves. Demo store data: Shopify mock.shop. Live competitor data: Channel3.';
  }
  if (await returnedFromPayPal()) return;
  readShelf($('#storeUrl').value.trim());
})();
