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
  ['#after', '#buy'].forEach((s) => ($(s).hidden = true));
  try {
    const r = await run('/api/product', { store: state.store, id }, 'Asking agents about this product');
    state.report = r;
    drawProduct();
    await drawQuestions();
    $('#product').hidden = false; $('#ask').hidden = false;
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
    ul.innerHTML = a.rows.slice(0, 12).map((x) => `<li class="slot ${x.coverage >= 0.5 ? 'on' : 'off'}"><span class="n">${esc(x.field)}</span><span class="q">${pct(x.coverage)} of competing products carry it</span><span class="s">${x.kind}</span></li>`).join('');
    $('#slotsNote').textContent = `Measured on ${a.sample} competing products that a live product search (Channel3) returned for these requests. This is what agents are used to receiving.`;
  }
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
  $('#added').innerHTML = state.after.fixes.add.map((x) => `<li><span class="a">${esc(x.attribute)}</span><span>${esc(x.value)}</span><span class="from">from your answer: “${esc(x.fact_quote)}”</span></li>`).join('');
  drawRequests($('#requestsAfter'), state.after);
  drawSlots();
  const win = state.after.verdicts.find((v) => v.rank === 1) || state.after.verdicts[0];
  $('#buyRequest').value = win ? win.query : '';
  $('#buy').hidden = false;
  $('#after').scrollIntoView({ behavior: 'smooth' });
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
$('#publish').addEventListener('click', publish);

(async () => {
  state.config = await api('/api/config');
  if (await returnedFromPayPal()) return;
  readShelf($('#storeUrl').value.trim());
})();
