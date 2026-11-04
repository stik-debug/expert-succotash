(function () {
'use strict';

const KEY = 'marginpilot.v1';
const THEME_KEY = 'marginpilot.theme';
const ROLE_KEY = 'marginpilot.role';

const ACC = {
  cash: ['1000', 'Cash', 'D'],
  till: ['1010', 'M-Pesa Till', 'D'],
  clr: ['1015', 'M-Pesa Clearing (unverified)', 'D'],
  inv: ['1200', 'Inventory', 'D'],
  ar: ['1300', 'Money you are owed', 'D'],
  eq: ['3000', 'Owner Equity', 'C'],
  sales: ['4000', 'Sales', 'C'],
  cogs: ['5000', 'Cost of Goods Sold', 'D'],
  exp: ['6000', 'Operating Expenses', 'D'],
  disc: ['4100', 'Discounts given', 'D']
};

const ROLES = {
  owner: { label: 'Owner', can: ['sell', 'stock', 'money', 'ledger', 'plans', 'roles', 'reverse', 'lock', 'doctor'] },
  manager: { label: 'Manager', can: ['sell', 'stock', 'money', 'ledger', 'reverse', 'doctor'] },
  cashier: { label: 'Cashier', can: ['sell'] },
  stock_manager: { label: 'Stock manager', can: ['stock', 'sell'] },
  accountant: { label: 'Accountant', can: ['money', 'ledger', 'doctor', 'reverse'] }
};

let S = {
  products: [], entries: [], sales: [], pays: [], confs: [],
  customers: [], activity: [], plans: { small: 10000, big: 25000 },
  n: 1, offlineQueue: [], lockedThrough: null,
  settings: { businessName: 'My business', till: '', paybill: '' }
};
try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    S = Object.assign(S, parsed);
    if (!S.customers) S.customers = [];
    if (!S.activity) S.activity = [];
    if (!S.offlineQueue) S.offlineQueue = [];
    if (!S.settings) S.settings = { businessName: 'My business', till: '', paybill: '' };
  }
} catch (e) {}

function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
function logActivity(action, detail) {
  S.activity.unshift({ ts: Date.now(), role: currentRole(), action, detail: detail || '' });
  if (S.activity.length > 200) S.activity.length = 200;
  save();
}
function currentRole() { return localStorage.getItem(ROLE_KEY) || 'owner'; }
function can(action) {
  const r = ROLES[currentRole()] || ROLES.owner;
  return r.can.includes(action);
}

function applyTheme(t) {
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else {
    document.documentElement.removeAttribute('data-theme');
    t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  localStorage.setItem(THEME_KEY, t === 'system' ? 'system' : t);
}
(function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light') applyTheme(saved);
  else applyTheme('system');
})();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kes = (n) => 'KSh ' + (Number(n) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cents = (v) => {
  const x = Math.round(parseFloat(String(v).replace(/,/g, '')) * 100);
  return Number.isFinite(x) ? x : NaN;
};
const bal = (k) => {
  let d = 0, c = 0;
  S.entries.forEach((e) => e.lines.forEach((l) => { if (l.a === k) { d += l.dr; c += l.cr; } }));
  return ACC[k][2] === 'D' ? d - c : c - d;
};
const uid = () => 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDate = (ts) => {
  const d = new Date(ts);
  return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
};

/* Ledger — same rules as packages/core */
function post(memo, lines, ref) {
  const dr = lines.reduce((a, l) => a + l.dr, 0);
  const cr = lines.reduce((a, l) => a + l.cr, 0);
  if (dr !== cr || dr <= 0 || lines.some((l) => !Number.isInteger(l.dr) || !Number.isInteger(l.cr) || l.dr < 0 || l.cr < 0))
    throw new Error('Entry not balanced or invalid amounts');
  if (S.lockedThrough && todayISO() <= S.lockedThrough)
    throw new Error('Period is locked through ' + S.lockedThrough);
  const e = { id: S.n++, ts: Date.now(), date: todayISO(), memo, lines: lines.map((l) => ({ ...l })), ref: ref || null, reversed: false, isRev: false };
  S.entries.push(e);
  return e;
}
function reverseEntry(id, reason) {
  if (!can('reverse')) { toast('Your role cannot reverse entries.'); return; }
  const e = S.entries.find((x) => x.id === id);
  if (!e || e.reversed || e.isRev) { toast('Cannot reverse this entry.'); return; }
  if (S.entries.some((x) => x.reverses === id)) { toast('Already reversed.'); return; }
  const r = post('Reversal of #' + id + ': ' + (reason || e.memo), e.lines.map((l) => ({ a: l.a, dr: l.cr, cr: l.dr })), e.ref);
  r.isRev = true;
  r.reverses = id;
  e.reversed = true;
  logActivity('reverse', '#' + id + ' ' + (reason || ''));
  save();
  toast('Entry reversed.');
  render();
}

/* M-Pesa parser — aligned with packages/core */
const PARSER_VERSION = 'v1-unverified';
function parseSms(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const out = { ok: false, version: PARSER_VERSION, code: null, amountMinor: null, direction: null, counterparty: null, date: null, time: null, issues: [] };
  const code = t.match(/\b([A-Z0-9]{10})\s+Confirmed/i);
  if (!code) out.issues.push('No transaction code followed by "Confirmed"');
  else out.code = code[1].toUpperCase();
  const amt = t.match(/Ksh\.?\s?([\d,]+(?:\.\d{1,2})?)/i);
  if (!amt) out.issues.push('No amount found');
  else out.amountMinor = Math.round(parseFloat(String(amt[1]).replace(/,/g, '')) * 100);
  if (/\breceived\b/i.test(t)) out.direction = 'in';
  else if (/\b(sent to|paid to|withdraw|bought)\b/i.test(t)) out.direction = 'out';
  else out.issues.push('Cannot tell whether money came in or went out');
  if (out.direction === 'out') out.issues.push('This is an outgoing payment, not a customer payment');
  const who = t.match(/from\s+([A-Za-z][A-Za-z .'-]{1,40}?)(?=\s+(?:\+?\d|on\s)|\.)/);
  if (who) out.counterparty = who[1].trim();
  const when = t.match(/on\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+at\s+(\d{1,2}:\d{2}\s?[AP]M)/i);
  if (when) { out.date = when[1]; out.time = when[2].toUpperCase(); }
  out.ok = out.issues.length === 0;
  return out;
}

function matchCode(code) {
  const conf = S.confs.find((c) => c.code === code && !c.sale);
  const pay = S.pays.find((p) => p.code === code);
  if (conf && pay) {
    conf.sale = pay.sale;
    if (pay.conf !== 'verified') {
      pay.conf = 'verified';
      const amt = pay.amt;
      try {
        post('Verify M-Pesa ' + code, [{ a: 'till', dr: amt, cr: 0 }, { a: 'clr', dr: 0, cr: amt }], code);
      } catch (err) {}
    }
    save();
  }
}

function importStatement() {
  const el = document.getElementById('stmt');
  if (!el) return;
  const lines = el.value.split(/\n/).map((l) => l.trim()).filter(Boolean);
  let n = 0;
  lines.forEach((line) => {
    const m = line.match(/([A-Z0-9]{10})\s*[,;\s]\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (!m) return;
    const code = m[1].toUpperCase();
    const amt = cents(m[2]);
    if (isNaN(amt)) return;
    if (S.confs.some((c) => c.code === code)) return;
    S.confs.push({ code, amt, sale: null, ts: Date.now() });
    n++;
    matchCode(code);
  });
  el.value = '';
  logActivity('import_statement', n + ' lines');
  save();
  toast(n ? n + ' statement line(s) imported.' : 'No new codes found.');
  render();
}

let online = navigator.onLine;
function updateOnline() {
  online = navigator.onLine;
  const el = document.getElementById('sync-status');
  if (!el) return;
  const pending = S.offlineQueue.length;
  if (!online) { el.textContent = 'Offline'; el.className = 'sync-badge'; }
  else if (pending) { el.textContent = 'Waiting to sync (' + pending + ')'; el.className = 'sync-badge'; flushQueue(); }
  else { el.textContent = 'Online'; el.className = 'sync-badge online'; }
}
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);

function enqueue(op) {
  const item = { id: uid(), ts: Date.now(), op, ...op };
  S.offlineQueue.push(item);
  save();
  updateOnline();
  return item;
}
function flushQueue() {
  if (!online || !S.offlineQueue.length) return;
  S.offlineQueue = [];
  save();
  updateOnline();
}

let tab = 'home';
let period = 'today';
let cart = [];
let parsedSms = null;
let toastTimer = null;
let cmdOpen = false;
let modal = null;
let sellMode = 'products';
let customAmt = '';
let discountPct = 0;
let scanStream = null;
let scanTimer = null;

function toast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3200);
}

function periodRange(p) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (p === 'week') { const day = start.getDay() || 7; start.setDate(start.getDate() - day + 1); }
  else if (p === 'month') start.setDate(1);
  else if (p === 'quarter') { const q = Math.floor(start.getMonth() / 3) * 3; start.setMonth(q, 1); }
  else if (p === 'year') start.setMonth(0, 1);
  return { start: start.getTime(), end: now.getTime() };
}
function salesInPeriod(p) {
  const { start, end } = periodRange(p);
  return S.sales.filter((s) => s.ts >= start && s.ts <= end && !s.refunded);
}
function profitInPeriod(p) {
  let rev = 0, cogs = 0;
  salesInPeriod(p).forEach((s) => {
    rev += s.total;
    (s.items || []).forEach((it) => {
      const prod = S.products.find((x) => x.id === it.id);
      const cost = it.cost != null ? it.cost : (prod ? prod.cost : 0);
      cogs += it.q * cost;
    });
  });
  return { rev, cogs, profit: rev - cogs };
}

const TABS = [
  { id: 'home', label: 'Home', icon: 'home', need: null },
  { id: 'sell', label: 'Sell', icon: 'sell', need: 'sell' },
  { id: 'stock', label: 'Stock', icon: 'stock', need: 'stock' },
  { id: 'money', label: 'Money', icon: 'money', need: 'money' },
  { id: 'more', label: 'More', icon: 'more', need: null }
];

function iconSvg(name) {
  const icons = {
    home: '<path d="M3 12l9-9 9 9M5 10v10h5v-6h4v6h5V10"/>',
    sell: '<path d="M6 6h15l-1.5 9h-12zM6 6L5 3H2m4 15a1 1 0 100 2 1 1 0 000-2zm11 0a1 1 0 100 2 1 1 0 000-2z"/>',
    stock: '<path d="M3 7l9-4 9 4-9 4-9-4zm0 5l9 4 9-4m-18 5l9 4 9-4"/>',
    money: '<path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>',
    more: '<circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>'
  };
  return '<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">' + (icons[name] || '') + '</svg>';
}

function setTab(id) {
  const t = TABS.find((x) => x.id === id);
  if (t && t.need && !can(t.need)) { toast('Your role cannot open ' + t.label + '.'); return; }
  tab = id;
  cart = [];
  parsedSms = null;
  customAmt = '';
  discountPct = 0;
  stopScan();
  render();
}
window.setTab = setTab;

function lockedView(name) {
  return '<div class="card"><h2>' + esc(name) + '</h2><p>Your current role cannot open this section.</p><button type="button" class="btn btn-secondary" onclick="setTab(\'more\')">Change role in More</button></div>';
}

function viewHome() {
  const { rev, cogs, profit } = profitInPeriod(period);
  const cash = bal('cash'), till = bal('till'), clr = bal('clr');
  const sales = salesInPeriod(period);
  const flagged = S.pays.filter((p) => p.conf === 'flagged').length;
  const oldUnver = S.pays.filter((p) => p.conf !== 'verified' && Date.now() - p.ts > 864e5).length;
  const lowStock = S.products.filter((p) => p.qty <= 2 && p.qty >= 0);
  const overdue = S.customers.filter((c) => (c.balance || 0) > 0);
  const attention = [];
  if (flagged) attention.push({ t: flagged + ' flagged M-Pesa payment(s)', why: 'Message amount did not match the sale total.' });
  if (oldUnver) attention.push({ t: oldUnver + ' unverified payment(s) older than 24h', why: 'Still in M-Pesa clearing until matched to a statement line.' });
  if (lowStock.length) attention.push({ t: lowStock.length + ' product(s) low on stock', why: 'Quantity is 2 or fewer. Check Stock.' });
  if (overdue.length) attention.push({ t: overdue.length + ' customer(s) with money owed', why: 'Credit sales not fully paid.' });
  const unm = S.confs.filter((c) => !c.sale).length;
  if (unm) attention.push({ t: unm + ' statement payment(s) with no sale', why: 'Money received but no matching sale recorded.' });

  const periods = [{ id: 'today', label: 'Today' }, { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }, { id: 'quarter', label: 'Quarter' }, { id: 'year', label: 'Year' }];
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    const next = new Date(d); next.setDate(next.getDate() + 1);
    const tot = S.sales.filter((s) => s.ts >= d.getTime() && s.ts < next.getTime() && !s.refunded).reduce((a, s) => a + s.total, 0);
    days.push({ label: d.toLocaleDateString('en-KE', { weekday: 'short' }), v: tot });
  }
  const maxV = Math.max(...days.map((d) => d.v), 1);
  const chartH = 120, chartW = 280, barW = 28, gap = 10;
  const bars = days.map((d, i) => {
    const h = Math.round((d.v / maxV) * (chartH - 24));
    const x = i * (barW + gap) + 8;
    const y = chartH - h - 16;
    return '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + h + '" rx="4" fill="var(--em)" opacity="' + (d.v ? 1 : 0.25) + '"/><text x="' + (x + barW / 2) + '" y="' + (chartH - 2) + '" text-anchor="middle" font-size="10" fill="var(--mu)">' + d.label + '</text>';
  }).join('');

  const prodSales = {};
  sales.forEach((s) => (s.items || []).forEach((it) => {
    prodSales[it.id] = (prodSales[it.id] || 0) + it.q * (it.price != null ? it.price : (S.products.find((p) => p.id === it.id)?.price || 0));
  }));
  const top = Object.entries(prodSales).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

  return '<h1>Good ' + greet + '</h1>' +
    '<p style="color:var(--mu);margin-bottom:12px">' + esc(S.settings.businessName) + ' · ' + new Date().toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long' }) + '</p>' +
    '<div class="period-switch" role="group" aria-label="Period">' +
    periods.map((p) => '<button type="button" aria-pressed="' + (period === p.id) + '" data-period="' + p.id + '">' + p.label + '</button>').join('') +
    '</div>' +
    '<div class="card"><h3>Morning briefing</h3><div class="grid" style="margin:0">' +
    '<button type="button" class="stat" data-goto="money"><div class="lbl">Sales (' + period + ')</div><div class="val">' + kes(rev) + '</div><div class="sub">' + sales.length + ' sale(s) · actual</div></button>' +
    '<button type="button" class="stat" data-goto="money"><div class="lbl">Profit so far</div><div class="val ' + (profit < 0 ? 'bad' : 'ok') + '">' + kes(profit) + '</div><div class="sub">Sales minus cost of goods · actual</div></button>' +
    '<button type="button" class="stat" data-goto="money"><div class="lbl">Cash received</div><div class="val">' + kes(cash) + '</div><div class="sub">In hand · actual</div></button>' +
    '<button type="button" class="stat" data-goto="money"><div class="lbl">M-Pesa verified</div><div class="val">' + kes(till) + '</div><div class="sub">' + (clr ? kes(clr) + ' awaiting verification' : 'All clear') + ' · actual</div></button>' +
    '</div></div>' +
    (attention.length
      ? '<div class="card gold"><h3>Needs attention</h3><ul style="margin:0;padding-left:18px">' + attention.map((a) => '<li><strong>' + esc(a.t) + '</strong><br><span style="color:var(--mu);font-size:0.85rem">' + esc(a.why) + '</span></li>').join('') + '</ul></div>'
      : '<div class="card"><p class="ok" style="margin:0"><strong>Nothing urgent.</strong> Sales, stock and payments look fine for now.</p></div>') +
    '<div class="card"><h3>Sales trend (7 days)</h3><div class="chart-wrap" role="img" aria-label="Bar chart of daily sales"><svg viewBox="0 0 ' + chartW + ' ' + chartH + '" preserveAspectRatio="none">' + bars + '</svg></div>' +
    '<div class="table-scroll sr-only"><table><caption>Daily sales</caption><thead><tr><th>Day</th><th class="n">Amount</th></tr></thead><tbody>' +
    days.map((d) => '<tr><td>' + d.label + '</td><td class="n">' + kes(d.v) + '</td></tr>').join('') + '</tbody></table></div></div>' +
    '<div class="card"><h3>Top products (' + period + ')</h3>' +
    (top.length ? top.map(([id, v]) => { const p = S.products.find((x) => x.id === id); return '<div class="row"><span>' + esc(p ? p.name : id) + '</span><b>' + kes(v) + '</b></div>'; }).join('') : '<p class="empty">No sales in this period yet.</p>') +
    '</div>' +
    (!S.products.length && !S.sales.length
      ? '<div class="card"><h3>Start here</h3><ol style="margin:0;padding-left:18px"><li>Add products in <strong>Stock</strong>.</li><li>Record sales in <strong>Sell</strong> (or tap +).</li><li>Paste M-Pesa confirmations and import your statement in <strong>Money</strong> to verify payments.</li></ol></div>'
      : '');
}

function viewSell() {
  if (!can('sell')) return lockedView('Sell');
  const prods = S.products;
  const lines = cart.map((c) => {
    const price = c.custom ? c.price : (S.products.find((x) => x.id === c.id)?.price || 0);
    const name = c.custom ? (c.name || 'Custom') : (S.products.find((x) => x.id === c.id)?.name || '?');
    return '<div class="row"><span>' + esc(name) + ' × ' + c.q +
      ' <button type="button" class="btn btn-sm btn-ghost" data-qty="' + c.id + '|-1" aria-label="Decrease">−</button>' +
      ' <button type="button" class="btn btn-sm btn-ghost" data-qty="' + c.id + '|1" aria-label="Increase">+</button></span><b>' + kes(c.q * price) + '</b></div>';
  }).join('');
  let sub = 0;
  cart.forEach((c) => { sub += c.q * (c.custom ? c.price : (S.products.find((x) => x.id === c.id)?.price || 0)); });
  const discAmt = Math.round(sub * (discountPct / 100));
  const total = Math.max(0, sub - discAmt);
  const methEl = document.getElementById('meth');
  const meth = methEl ? methEl.value : 'cash';

  let body = '<h1>New sale</h1><div class="period-switch" role="group" aria-label="Sell mode">' +
    '<button type="button" aria-pressed="' + (sellMode === 'products') + '" data-sellmode="products">Products</button>' +
    '<button type="button" aria-pressed="' + (sellMode === 'custom') + '" data-sellmode="custom">Custom amount</button>' +
    '<button type="button" aria-pressed="' + (sellMode === 'scan') + '" data-sellmode="scan">Scan barcode</button></div>';

  if (sellMode === 'products') {
    body += '<div class="card"><h3>Products</h3>' +
      (prods.length
        ? '<div class="prod-grid">' + prods.map((p) =>
          '<button type="button" class="prod-tile" data-add="' + p.id + '" ' + (p.qty < 1 ? 'disabled' : '') + ' aria-label="Add ' + esc(p.name) + '"><b>' + esc(p.name) + '</b>' + kes(p.price) + '<br><small>' + p.qty + ' in stock</small></button>'
        ).join('') + '</div>'
        : '<div class="empty"><h3>No products yet</h3><p>Add products in Stock first.</p><button type="button" class="btn btn-primary" data-goto="stock">Go to Stock</button></div>') +
      '</div>';
  }
  if (sellMode === 'custom') {
    body += '<div class="card"><h3>Custom amount</h3><p style="color:var(--mu)">For services or items not in stock</p>' +
      '<div class="big" style="margin:12px 0;text-align:center">' + (customAmt ? kes(cents(customAmt) || 0) : 'KSh 0.00') + '</div>' +
      '<div class="keypad">' +
      [1,2,3,4,5,6,7,8,9,'.',0,'⌫'].map((k) => '<button type="button" data-key="' + k + '">' + k + '</button>').join('') +
      '<button type="button" class="wide" data-addcustom="1">Add to sale</button></div></div>';
  }
  if (sellMode === 'scan') {
    body += '<div class="card"><h3>Barcode</h3><p>Point your camera at a product barcode. On supported phones this uses the built-in scanner.</p>' +
      '<video id="scan-video" playsinline style="width:100%;max-height:240px;border-radius:8px;background:#000;display:none"></video>' +
      '<p id="scan-status" style="color:var(--mu)">Checking camera support…</p>' +
      '<button type="button" class="btn btn-primary" data-scanstart="1">Start camera</button> ' +
      '<button type="button" class="btn btn-secondary" data-scanstop="1">Stop</button>' +
      '<label class="field" style="margin-top:12px"><span>Or type barcode / SKU</span><input id="barcode-manual" inputmode="numeric" autocomplete="off"></label>' +
      '<button type="button" class="btn btn-secondary" data-manualbar="1">Add by code</button></div>';
  }

  body += '<div class="card"><h3>Cart</h3>' + (lines || '<p style="color:var(--mu)">Tap products or add a custom amount.</p>');
  if (sub) {
    body += '<div class="row"><span>Subtotal</span><b>' + kes(sub) + '</b></div>' +
      '<label class="field"><span>Discount %</span><input type="number" id="disc" min="0" max="100" value="' + discountPct + '" inputmode="numeric"></label>' +
      (discAmt ? '<div class="row"><span>Discount</span><b class="bad">−' + kes(discAmt) + '</b></div>' : '') +
      '<div class="row"><span><strong>Total</strong></span><b style="font-size:1.25rem">' + kes(total) + '</b></div>' +
      '<label class="field"><span>Payment method</span><select id="meth">' +
      '<option value="cash"' + (meth === 'cash' ? ' selected' : '') + '>Cash</option>' +
      '<option value="mpesa"' + (meth === 'mpesa' ? ' selected' : '') + '>M-Pesa</option>' +
      '<option value="split"' + (meth === 'split' ? ' selected' : '') + '>Split (cash + M-Pesa)</option>' +
      '<option value="credit"' + (meth === 'credit' ? ' selected' : '') + '>Credit (pay later)</option></select></label>';
    if (meth === 'mpesa' || meth === 'split') {
      body += '<label class="field"><span>Paste M-Pesa confirmation message</span><textarea id="sms" placeholder="Paste the SMS here…">' + (parsedSms && parsedSms.raw ? esc(parsedSms.raw) : '') + '</textarea></label>' +
        '<button type="button" class="btn btn-secondary" data-readsms="1">Read message</button>';
      if (parsedSms) {
        body += '<div class="help-panel" role="status"><strong>What was read</strong> (not yet saved)<br>Code: ' + esc(parsedSms.code || '—') +
          '<br>Amount: ' + (parsedSms.amountMinor != null ? kes(parsedSms.amountMinor) : '—') +
          '<br>From: ' + esc(parsedSms.counterparty || '—') + '<br>' +
          (parsedSms.issues && parsedSms.issues.length ? '<span class="bad">' + parsedSms.issues.map(esc).join('; ') + '</span>' : '<span class="ok">Looks complete</span>') +
          '<br><small>Payment stays unverified until it matches a statement line. A message alone never marks money as collected.</small></div>';
      }
      body += '<label class="field"><span>M-Pesa code (10 characters)</span><input id="code" maxlength="10" autocomplete="off" style="text-transform:uppercase" value="' + (parsedSms && parsedSms.code ? esc(parsedSms.code) : '') + '"></label>';
    }
    if (meth === 'split') {
      body += '<div class="grid"><label class="field"><span>Cash portion (KES)</span><input id="split-cash" inputmode="decimal"></label>' +
        '<label class="field"><span>M-Pesa portion (KES)</span><input id="split-mpesa" inputmode="decimal"></label></div>';
    }
    if (meth === 'credit') {
      body += '<label class="field"><span>Customer name</span><input id="cust-name" list="cust-list" placeholder="Who owes this?"><datalist id="cust-list">' +
        S.customers.map((c) => '<option value="' + esc(c.name) + '">').join('') + '</datalist></label>';
    }
    body += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">' +
      '<button type="button" class="btn btn-primary" data-completesale="1"' + (cart.length ? '' : ' disabled') + '>Record sale</button>' +
      '<button type="button" class="btn btn-secondary" data-clearcart="1">Clear</button></div>';
  }
  body += '</div>';
  return body;
}

function viewStock() {
  if (!can('stock')) return lockedView('Stock');
  return '<h1>Stock</h1><div class="card"><h3>Add product</h3>' +
    '<label class="field"><span>Name</span><input id="pn" autocomplete="off"></label>' +
    '<div class="grid"><label class="field"><span>Selling price (KES)</span><input id="pp" inputmode="decimal"></label>' +
    '<label class="field"><span>Cost price (KES)</span><input id="pc" inputmode="decimal"></label>' +
    '<label class="field"><span>Opening quantity</span><input id="pq" inputmode="numeric" value="0"></label>' +
    '<label class="field"><span>Barcode / SKU (optional)</span><input id="pb" inputmode="numeric" autocomplete="off"></label></div>' +
    '<button type="button" class="btn btn-primary" data-addproduct="1">Add product</button></div>' +
    '<div class="card"><h3>Products</h3>' +
    (S.products.length ? S.products.map((p) => {
      const margin = p.price ? Math.round((p.price - p.cost) / p.price * 100) : 0;
      const low = p.qty <= 2;
      return '<div class="row"><span><strong>' + esc(p.name) + '</strong>' + (p.barcode ? ' · ' + esc(p.barcode) : '') +
        '<br><small>Sell ' + kes(p.price) + ', cost ' + kes(p.cost) + ', margin ' + margin + '%</small>' +
        (low ? '<br><span class="tag w">Low stock</span>' : '') + '</span><b>' + p.qty + '</b></div>';
    }).join('') : '<div class="empty"><h3>No products</h3><p>Add your first product above so you can sell quickly.</p></div>') +
    '</div>';
}

function viewMoney() {
  if (!can('money') && !can('ledger')) return lockedView('Money');
  const tag = (c) => c === 'verified' ? '<span class="tag">Verified</span>' : c === 'attested' ? '<span class="tag w">Attested</span>' : c === 'flagged' ? '<span class="tag b">Flagged</span>' : '<span class="tag w">Unconfirmed</span>';
  const ks = Object.keys(ACC);
  let td = 0, tc = 0;
  const rows = ks.map((k) => {
    let d = 0, c = 0;
    S.entries.forEach((e) => e.lines.forEach((l) => { if (l.a === k) { d += l.dr; c += l.cr; } }));
    td += d; tc += c;
    return '<tr><td>' + ACC[k][0] + ' ' + ACC[k][1] + '</td><td class="n">' + kes(d) + '</td><td class="n">' + kes(c) + '</td></tr>';
  }).join('');

  let body = '<h1>Money</h1><div class="grid">' +
    '<div class="stat" style="cursor:default"><div class="lbl">Cash in hand</div><div class="val">' + kes(bal('cash')) + '</div><div class="sub">actual</div></div>' +
    '<div class="stat" style="cursor:default"><div class="lbl">M-Pesa Till (verified)</div><div class="val">' + kes(bal('till')) + '</div><div class="sub">actual</div></div>' +
    '<div class="stat" style="cursor:default"><div class="lbl">Awaiting verification</div><div class="val est">' + kes(bal('clr')) + '</div><div class="sub">estimated until statement match</div></div>' +
    '<div class="stat" style="cursor:default"><div class="lbl">Money you are owed</div><div class="val">' + kes(bal('ar')) + '</div><div class="sub">credit sales</div></div></div>';

  if (can('money')) {
    body += '<div class="card"><h3>Import M-Pesa statement</h3>' +
      '<p style="color:var(--mu);font-size:0.9rem">One payment per line: code, amount. Example: ABC1234567, 500.00. Copy from your M-Pesa business portal.</p>' +
      '<textarea id="stmt" placeholder="ABC1234567, 500.00"></textarea>' +
      '<button type="button" class="btn btn-primary" style="margin-top:8px" data-importstmt="1">Match payments</button></div>' +
      '<div class="card"><h3>M-Pesa payments</h3>' +
      (S.pays.length ? S.pays.slice().reverse().map((p) =>
        '<div class="row"><span>' + esc(p.code) + ' · sale #' + p.sale + '<br><small>' + (p.src === 'manual' ? 'code typed' : 'from pasted message') + (p.note ? ' · ' + esc(p.note) : '') + '</small></span><span>' + kes(p.amt) + ' ' + tag(p.conf) + '</span></div>'
      ).join('') : '<p style="color:var(--mu)">No M-Pesa payments yet.</p>') + '</div>' +
      '<div class="card"><h3>Money received, no sale recorded</h3>' +
      (S.confs.filter((c) => !c.sale).length
        ? S.confs.filter((c) => !c.sale).map((c) => '<div class="row"><span>' + esc(c.code) + '</span><b>' + kes(c.amt) + '</b></div>').join('')
        : '<p style="color:var(--mu)">None.</p>') +
      '<small style="color:var(--mu)">These can mean an unrecorded sale or a payment for something else. Check before drawing conclusions.</small></div>';
  }

  if (can('ledger')) {
    body += '<div class="card"><h3>Trial balance</h3><div class="table-scroll"><table><thead><tr><th>Account</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead><tbody>' +
      rows + '<tr><th>Total</th><th class="n">' + kes(td) + '</th><th class="n">' + kes(tc) + '</th></tr></tbody></table></div>' +
      '<p class="' + (td === tc ? 'ok' : 'bad') + '"><strong>' + (td === tc ? 'Balanced: debits equal credits.' : 'Out of balance.') + '</strong></p></div>' +
      '<div class="card"><h3>Record an expense (paid in cash)</h3>' +
      '<label class="field"><span>Description</span><input id="ed"></label>' +
      '<label class="field"><span>Amount (KES)</span><input id="ea" inputmode="decimal"></label>' +
      '<button type="button" class="btn btn-primary" data-addexpense="1">Save expense</button></div>' +
      '<div class="card"><h3>Journal</h3><p style="color:var(--mu);font-size:0.9rem">Posted records cannot be edited. Reverse one to correct it, with a reason.</p>' +
      (S.entries.length ? S.entries.slice().reverse().map((e) =>
        '<div class="row"><span>#' + e.id + ' ' + esc(e.memo) + '<br><small>' +
        e.lines.map((l) => ACC[l.a][1] + (l.dr ? ' Dr ' + kes(l.dr) : ' Cr ' + kes(l.cr))).join(' · ') +
        '</small></span>' +
        (e.reversed || e.isRev ? '<span class="tag w">' + (e.isRev ? 'Reversal' : 'Reversed') + '</span>' :
          (can('reverse') ? '<button type="button" class="btn btn-sm btn-secondary" data-reverse="' + e.id + '">Reverse</button>' : '')) +
        '</div>'
      ).join('') : '<p style="color:var(--mu)">No entries yet.</p>') + '</div>';
    if (can('lock')) {
      body += '<div class="card"><h3>Period lock</h3><p style="color:var(--mu);font-size:0.9rem">Lock closed periods so no one can post or reverse into them. Currently locked through: <strong>' +
        (S.lockedThrough || 'nothing') + '</strong></p>' +
        '<label class="field"><span>Lock through date (YYYY-MM-DD)</span><input id="lock-date" placeholder="2026-10-31"></label>' +
        '<button type="button" class="btn btn-secondary" data-dolock="1">Lock period</button></div>';
    }
  }
  return body;
}

function doctorPanel() {
  const { rev, cogs, profit } = profitInPeriod('month');
  const margin = rev ? Math.round((profit / rev) * 100) : 0;
  const unver = S.pays.filter((p) => p.conf !== 'verified').length;
  const low = S.products.filter((p) => p.qty <= 2);
  const exp = bal('exp');
  return '<p style="color:var(--mu);font-size:0.9rem">Answers use only your own records. Each answer shows the numbers, timeframe and assumptions.</p>' +
    '<div class="help-panel"><strong>How is this month going?</strong><br>Sales ' + kes(rev) + ', cost of goods ' + kes(cogs) + ', gross profit ' + kes(profit) + ' (' + margin + '% margin). Timeframe: calendar month to now. Assumption: COGS uses product cost at time of sale.</div>' +
    '<div class="help-panel"><strong>Where could profit be leaking?</strong><br>' +
    (unver ? unver + ' M-Pesa payment(s) not yet verified against a statement — cash may be delayed in clearing. ' : 'No unverified M-Pesa backlog. ') +
    (low.length ? low.length + ' product(s) at low stock — risk of missed sales. ' : 'Stock levels look fine. ') +
    'Operating expenses on the books: ' + kes(exp) + '.</div>' +
    '<div class="help-panel"><strong>Cash position</strong><br>Cash ' + kes(bal('cash')) + ', verified M-Pesa ' + kes(bal('till')) + ', awaiting verification ' + kes(bal('clr')) + ', money owed to you ' + kes(bal('ar')) + '. Assumption: only verified statement matches move money out of clearing into Till.</div>' +
    '<label class="field"><span>Ask a question (uses your data only)</span><input id="doctor-q" placeholder="e.g. What was my best product this week?"></label>' +
    '<button type="button" class="btn btn-secondary" data-askdoctor="1">Ask</button><div id="doctor-a" style="margin-top:8px"></div>';
}

function viewMore() {
  const role = currentRole();
  return '<h1>More</h1><div class="card"><h3>Business</h3>' +
    '<label class="field"><span>Business name</span><input id="biz-name" value="' + esc(S.settings.businessName) + '"></label>' +
    '<label class="field"><span>Your Till number</span><input id="biz-till" value="' + esc(S.settings.till || '') + '" placeholder="Not connected yet"></label>' +
    '<label class="field"><span>Your Paybill</span><input id="biz-paybill" value="' + esc(S.settings.paybill || '') + '" placeholder="Not connected yet"></label>' +
    '<p style="color:var(--mu);font-size:0.85rem">MarginPilot never holds customers\' money. Each business receives payments in its own Till or Paybill.</p></div>' +
    '<div class="card"><h3>Your role</h3><p>Acting as <strong>' + esc(ROLES[role].label) + '</strong>. Roles hide or lock actions you do not have permission for.</p>' +
    '<label class="field"><span>Switch role (demo — no server yet)</span><select id="role-sel">' +
    Object.entries(ROLES).map(([k, v]) => '<option value="' + k + '"' + (k === role ? ' selected' : '') + '>' + esc(v.label) + '</option>').join('') +
    '</select></label><p class="lock-note">Full staff accounts, PIN and biometric lock need the server backend. Not connected yet.</p></div>' +
    '<div class="card"><h3>Business Doctor</h3>' + (can('doctor') ? doctorPanel() : '<p class="lock-note">Available to owner, manager and accountant.</p>') + '</div>' +
    '<div class="card"><h3>What-if simulator</h3><p style="color:var(--mu);font-size:0.9rem">Estimate how price or cost changes would affect margin. Never touches real records.</p>' +
    '<label class="field"><span>Product</span><select id="sim-prod">' + (S.products.map((p) => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('') || '<option value="">No products</option>') + '</select></label>' +
    '<div class="grid"><label class="field"><span>New selling price (KES)</span><input id="sim-price" inputmode="decimal"></label>' +
    '<label class="field"><span>New cost (KES)</span><input id="sim-cost" inputmode="decimal"></label></div>' +
    '<button type="button" class="btn btn-secondary" data-runsim="1">Simulate</button><div id="sim-out" style="margin-top:8px"></div></div>' +
    '<div class="card"><h3>Plans (KES)</h3><p style="color:var(--mu);font-size:0.9rem">Prices shown before checkout. No hidden fees. Platform owner can edit prices without code.</p><div class="grid">' +
    ['small', 'big'].map((k) => {
      const names = { small: 'Small Shop', big: 'Big Business' };
      const desc = { small: 'Kiosks, small shops and individual traders.', big: 'Supermarkets, wholesalers, restaurants and growing businesses.' };
      return '<div class="card" style="margin:0;box-shadow:none"><h3>' + names[k] + '</h3><div class="val" style="font-size:1.5rem">' + kes(S.plans[k]) + '<small style="font-size:0.8rem;font-weight:500"> / month</small></div>' +
        '<p style="font-size:0.85rem;color:var(--mu)">' + desc[k] + '</p>' +
        (can('plans') ? '<label class="field"><span>Edit price (KES / month)</span><input id="pl' + k + '" inputmode="decimal" value="' + (S.plans[k] / 100) + '"><button type="button" class="btn btn-sm btn-secondary" style="margin-top:6px" data-setprice="' + k + '">Save price</button></label>' : '') +
        '</div>';
    }).join('') +
    '</div><div class="card gold" style="margin-top:12px"><h3>Not connected yet</h3><p>Billing, M-Pesa subscription payments, renewals and Super Admin need the server backend. Prices here stay in this browser only.</p>' +
    '<p><strong>Credentials needed:</strong> Safaricom Daraja production approval for a MarginPilot Paybill/Till, hosting with managed PostgreSQL, SMS/WhatsApp provider.</p></div></div>' +
    '<div class="card"><h3>Activity history</h3>' +
    (S.activity.length ? S.activity.slice(0, 20).map((a) =>
      '<div class="row"><span><strong>' + esc(a.action) + '</strong> · ' + esc(a.role) + '<br><small>' + fmtDate(a.ts) + (a.detail ? ' · ' + esc(a.detail) : '') + '</small></span></div>'
    ).join('') : '<p style="color:var(--mu)">No activity logged yet.</p>') + '</div>' +
    '<div class="card"><h3>Install & offline</h3><p style="color:var(--mu);font-size:0.9rem">This app is a PWA. Install it from your browser menu for a home-screen icon and offline shell. Sales recorded offline stay in a durable queue with unique IDs and show “Waiting to sync” until online. Financial data is never overwritten silently.</p></div>' +
    '<div class="card"><h3>Data</h3><p style="color:var(--mu);font-size:0.85rem">All business data stays in this browser (localStorage key <code>marginpilot.v1</code>). No accounts or records were reset by this upgrade.</p></div>';
}

function addCart(id) {
  const p = S.products.find((x) => x.id === id);
  if (!p) return;
  const c = cart.find((x) => x.id === id);
  const have = c ? c.q : 0;
  if (have + 1 > p.qty) { toast('Only ' + p.qty + ' of ' + p.name + ' in stock.'); return; }
  c ? c.q++ : cart.push({ id, q: 1 });
  render();
}

function completeSale() {
  if (!can('sell')) return;
  const items = cart.map((c) => {
    if (c.custom) return { id: c.id, q: c.q, name: c.name, price: c.price, cost: 0, custom: true };
    const p = S.products.find((x) => x.id === c.id);
    return { id: c.id, q: c.q, name: p.name, price: p.price, cost: p.cost };
  });
  if (!items.length) { toast('Cart is empty.'); return; }
  let sub = items.reduce((a, it) => a + it.q * it.price, 0);
  const discAmt = Math.round(sub * (discountPct / 100));
  const total = Math.max(0, sub - discAmt);
  const meth = (document.getElementById('meth') || {}).value || 'cash';
  let cogs = items.reduce((a, it) => a + it.q * (it.cost || 0), 0);
  let pay = null;
  let cashPart = 0, mpesaPart = 0;

  if (meth === 'mpesa' || meth === 'split') {
    const code = ((document.getElementById('code') || {}).value || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(code)) { toast('Enter the 10-character M-Pesa code.'); return; }
    if (S.pays.some((p) => p.code === code)) { toast('Code ' + code + ' was already used.'); return; }
    const fromSms = parsedSms && parsedSms.code === code && parsedSms.amountMinor != null;
    let conf = fromSms ? 'attested' : 'unconfirmed';
    let note = '';
    const expected = meth === 'split' ? cents((document.getElementById('split-mpesa') || {}).value) : total;
    if (fromSms && parsedSms.amountMinor !== expected) {
      conf = 'flagged';
      note = 'Message amount ' + kes(parsedSms.amountMinor) + ' differs from expected ' + kes(expected || total) + '.';
    }
    pay = { code, amt: expected || total, conf, note, src: fromSms ? 'pasted_sms' : 'manual', pv: fromSms ? parsedSms.version : null, ts: Date.now() };
    mpesaPart = pay.amt;
  }
  if (meth === 'split') {
    cashPart = cents((document.getElementById('split-cash') || {}).value);
    if (isNaN(cashPart) || cashPart < 0) { toast('Enter cash portion.'); return; }
    if (cashPart + mpesaPart !== total) { toast('Cash + M-Pesa must equal total ' + kes(total) + '.'); return; }
  }
  if (meth === 'cash') cashPart = total;
  if (meth === 'credit') {
    const name = ((document.getElementById('cust-name') || {}).value || '').trim();
    if (!name) { toast('Enter customer name for credit sale.'); return; }
    let cust = S.customers.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!cust) { cust = { id: uid(), name, balance: 0 }; S.customers.push(cust); }
    cust.balance = (cust.balance || 0) + total;
  }

  try {
    const sid = S.n;
    const lines = [];
    if (meth === 'credit') {
      lines.push({ a: 'ar', dr: total, cr: 0 });
      lines.push({ a: 'sales', dr: 0, cr: total });
    } else if (meth === 'split') {
      if (cashPart) lines.push({ a: 'cash', dr: cashPart, cr: 0 });
      if (mpesaPart) lines.push({ a: 'clr', dr: mpesaPart, cr: 0 });
      lines.push({ a: 'sales', dr: 0, cr: total });
    } else if (meth === 'mpesa') {
      lines.push({ a: 'clr', dr: total, cr: 0 });
      lines.push({ a: 'sales', dr: 0, cr: total });
    } else {
      lines.push({ a: 'cash', dr: total, cr: 0 });
      lines.push({ a: 'sales', dr: 0, cr: total });
    }
    post('Sale #' + sid + (pay ? ' (M-Pesa ' + pay.code + ')' : meth === 'credit' ? ' (credit)' : ' (cash)'), lines);
    if (cogs > 0) post('Cost of sale #' + sid, [{ a: 'cogs', dr: cogs, cr: 0 }, { a: 'inv', dr: 0, cr: cogs }]);
    items.forEach((it) => {
      if (!it.custom) {
        const p = S.products.find((x) => x.id === it.id);
        if (p) p.qty -= it.q;
      }
    });
    const sale = { id: sid, ts: Date.now(), total, method: meth, items, discount: discAmt, refunded: false };
    S.sales.push(sale);
    if (pay) { pay.sale = sid; S.pays.push(pay); matchCode(pay.code); }
    logActivity('sale', '#' + sid + ' ' + kes(total));
    if (!online) enqueue({ type: 'sale', saleId: sid });
    cart = [];
    parsedSms = null;
    discountPct = 0;
    customAmt = '';
    save();
    toast('Sale recorded.');
    showReceipt(sale, pay);
  } catch (err) {
    toast(err.message || 'Could not record sale.');
  }
}

function showReceipt(sale, pay) {
  const items = (sale.items || []).map((it) => (it.name || 'Item') + ' x' + it.q + '  ' + kes(it.q * it.price)).join('\n');
  const text = S.settings.businessName + '\nSale #' + sale.id + '\n' + fmtDate(sale.ts) + '\n----------------\n' + items +
    (sale.discount ? '\nDiscount  -' + kes(sale.discount) : '') + '\nTOTAL  ' + kes(sale.total) + '\n' + sale.method.toUpperCase() +
    (pay ? '\nM-Pesa ' + pay.code + ' (' + pay.conf + ')' : '') + '\n----------------\nThank you';
  modal = { type: 'receipt', text, sale };
  renderOverlays();
}

async function startScan() {
  const status = document.getElementById('scan-status');
  const video = document.getElementById('scan-video');
  if (!window.BarcodeDetector) {
    if (status) status.textContent = 'BarcodeDetector not supported in this browser. Type the code instead.';
    return;
  }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = scanStream;
    video.style.display = 'block';
    await video.play();
    if (status) status.textContent = 'Scanning…';
    const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'qr_code', 'upc_a'] });
    const tick = async () => {
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          const raw = codes[0].rawValue;
          stopScan();
          const p = S.products.find((x) => x.barcode === raw);
          if (p) { addCart(p.id); toast('Added ' + p.name); }
          else toast('No product with barcode ' + raw);
        }
      } catch (e) {}
      if (scanStream) scanTimer = requestAnimationFrame(tick);
    };
    scanTimer = requestAnimationFrame(tick);
  } catch (e) {
    if (status) status.textContent = 'Camera permission denied or unavailable.';
  }
}
function stopScan() {
  if (scanTimer) cancelAnimationFrame(scanTimer);
  scanTimer = null;
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  const video = document.getElementById('scan-video');
  if (video) { video.srcObject = null; video.style.display = 'none'; }
}

function openCmd() {
  cmdOpen = true;
  renderOverlays();
  setTimeout(() => { const inp = document.getElementById('cmd-input'); if (inp) inp.focus(); }, 50);
}
function closeCmd() { cmdOpen = false; renderOverlays(); }
function closeModal() { modal = null; renderOverlays(); }

function cmdResults(q) {
  q = (q || '').toLowerCase().trim();
  const items = [];
  TABS.forEach((t) => { if (!q || t.label.toLowerCase().includes(q)) items.push({ label: 'Go to ' + t.label, action: 'tab', arg: t.id }); });
  S.products.forEach((p) => {
    if (!q || p.name.toLowerCase().includes(q) || (p.barcode && p.barcode.includes(q)))
      items.push({ label: p.name + ' — ' + kes(p.price), action: 'product', arg: p.id });
  });
  S.sales.slice(-20).reverse().forEach((s) => {
    if (!q || String(s.id).includes(q)) items.push({ label: 'Sale #' + s.id + ' · ' + kes(s.total), action: 'sale', arg: String(s.id) });
  });
  return items.slice(0, 12);
}

function renderOverlays() {
  const root = document.getElementById('overlays');
  if (!root) return;
  let html = '';
  if (cmdOpen) {
    html += '<div class="overlay" id="cmd-overlay" role="dialog" aria-label="Command menu"><div class="cmd">' +
      '<input id="cmd-input" type="search" placeholder="Jump to products, sales, pages…" aria-label="Search" autocomplete="off">' +
      '<div class="cmd-list" id="cmd-list"></div></div></div>';
  }
  if (modal && modal.type === 'receipt') {
    html += '<div class="modal-backdrop" role="dialog" aria-label="Receipt"><div class="modal"><h2>Receipt</h2><div class="receipt">' + esc(modal.text) + '</div>' +
      '<div class="modal-actions"><button type="button" class="btn btn-primary" data-sharereceipt="1">Share (WhatsApp / SMS)</button>' +
      '<button type="button" class="btn btn-secondary" data-printreceipt="1">Print</button>' +
      '<button type="button" class="btn btn-ghost" data-closemodal="1">Close</button></div>' +
      '<p style="color:var(--mu);font-size:0.8rem;margin-top:8px">WhatsApp and SMS use your device share sheet or clipboard. No third-party API is connected yet.</p></div></div>';
  }
  root.innerHTML = html;
  if (cmdOpen) {
    const list = document.getElementById('cmd-list');
    const fill = (q) => {
      list.innerHTML = cmdResults(q).map((it, i) =>
        '<button type="button" class="cmd-item" aria-selected="' + (i === 0) + '" data-cmd="' + it.action + '|' + esc(it.arg) + '">' + esc(it.label) + '</button>'
      ).join('') || '<div class="cmd-item" style="color:var(--mu)">No matches</div>';
    };
    fill('');
    document.getElementById('cmd-input').addEventListener('input', (e) => fill(e.target.value));
    document.getElementById('cmd-input').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeCmd();
      if (e.key === 'Enter') { const first = document.querySelector('.cmd-item[aria-selected="true"]'); if (first) first.click(); }
    });
    document.getElementById('cmd-overlay').addEventListener('click', (e) => { if (e.target.id === 'cmd-overlay') closeCmd(); });
  }
}

function render() {
  const side = document.getElementById('side-nav');
  if (side) {
    side.innerHTML = TABS.map((t) =>
      '<button type="button" ' + (tab === t.id ? 'aria-current="page"' : '') + ' data-tab="' + t.id + '">' + iconSvg(t.icon) + ' <span class="brand-text">' + t.label + '</span></button>'
    ).join('');
  }
  const bot = document.getElementById('bottom-nav');
  if (bot) {
    bot.innerHTML = TABS.map((t) =>
      '<button type="button" ' + (tab === t.id ? 'aria-current="page"' : '') + ' data-tab="' + t.id + '" aria-label="' + t.label + '">' + iconSvg(t.icon) + '<span>' + t.label + '</span></button>'
    ).join('');
  }
  const fab = document.getElementById('fab-sale');
  if (fab) fab.hidden = tab === 'sell' || !can('sell');

  const main = document.getElementById('main');
  if (!main) return;
  let body = '';
  if (tab === 'home') body = viewHome();
  else if (tab === 'sell') body = viewSell();
  else if (tab === 'stock') body = viewStock();
  else if (tab === 'money') body = viewMoney();
  else if (tab === 'more') body = viewMore();
  main.innerHTML = body;
  updateOnline();
  renderOverlays();

  // Bind period switches after render
  main.querySelectorAll('[data-period]').forEach((btn) => {
    btn.addEventListener('click', () => { period = btn.getAttribute('data-period'); render(); });
  });
  main.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => setTab(btn.getAttribute('data-goto')));
  });
  main.querySelectorAll('[data-sellmode]').forEach((btn) => {
    btn.addEventListener('click', () => { sellMode = btn.getAttribute('data-sellmode'); render(); });
  });
  main.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', () => addCart(btn.getAttribute('data-add')));
  });
  main.querySelectorAll('[data-qty]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [id, d] = btn.getAttribute('data-qty').split('|');
      const c = cart.find((x) => x.id === id);
      if (!c) return;
      const p = S.products.find((x) => x.id === id);
      const delta = parseInt(d, 10);
      if (delta > 0 && p && c.q + delta > p.qty) { toast('Not enough stock.'); return; }
      c.q += delta;
      if (c.q <= 0) cart = cart.filter((x) => x.id !== id);
      render();
    });
  });
  main.querySelectorAll('[data-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = btn.getAttribute('data-key');
      if (k === '⌫') customAmt = customAmt.slice(0, -1);
      else if (k === '.' && customAmt.includes('.')) return;
      else customAmt += k;
      render();
    });
  });
  const addCustomBtn = main.querySelector('[data-addcustom]');
  if (addCustomBtn) addCustomBtn.addEventListener('click', () => {
    const amt = cents(customAmt);
    if (!amt || amt <= 0) { toast('Enter an amount.'); return; }
    cart.push({ id: 'custom-' + uid(), q: 1, custom: true, name: 'Custom amount', price: amt, cost: 0 });
    customAmt = '';
    sellMode = 'products';
    render();
  });
  const disc = document.getElementById('disc');
  if (disc) disc.addEventListener('change', () => { discountPct = Math.min(100, Math.max(0, parseFloat(disc.value) || 0)); render(); });
  const meth = document.getElementById('meth');
  if (meth) meth.addEventListener('change', () => render());
  main.querySelectorAll('[data-readsms]').forEach((btn) => btn.addEventListener('click', () => {
    const t = (document.getElementById('sms') || {}).value || '';
    parsedSms = parseSms(t);
    parsedSms.raw = t;
    toast(parsedSms.ok ? 'Message read. Review before saving.' : 'Could not read fully — check the code field.');
    render();
  }));
  main.querySelectorAll('[data-completesale]').forEach((btn) => btn.addEventListener('click', completeSale));
  main.querySelectorAll('[data-clearcart]').forEach((btn) => btn.addEventListener('click', () => { cart = []; parsedSms = null; discountPct = 0; customAmt = ''; render(); }));
  main.querySelectorAll('[data-addproduct]').forEach((btn) => btn.addEventListener('click', () => {
    if (!can('stock')) return;
    const name = (document.getElementById('pn') || {}).value.trim();
    const price = cents((document.getElementById('pp') || {}).value);
    const cost = cents((document.getElementById('pc') || {}).value);
    const q = parseInt((document.getElementById('pq') || {}).value || '0', 10);
    const barcode = ((document.getElementById('pb') || {}).value || '').trim();
    if (!name || isNaN(price) || isNaN(cost) || q < 0 || isNaN(q)) { toast('Enter a name, selling price, cost price and quantity.'); return; }
    const id = 'p' + Date.now();
    S.products.push({ id, name, price, cost, qty: q, barcode: barcode || null });
    if (q > 0) { try { post('Opening stock: ' + name, [{ a: 'inv', dr: q * cost, cr: 0 }, { a: 'eq', dr: 0, cr: q * cost }]); } catch (e) { toast(e.message); return; } }
    logActivity('add_product', name);
    save();
    toast('Product added.');
    render();
  }));
  main.querySelectorAll('[data-importstmt]').forEach((btn) => btn.addEventListener('click', importStatement));
  main.querySelectorAll('[data-addexpense]').forEach((btn) => btn.addEventListener('click', () => {
    if (!can('ledger')) return;
    const d = (document.getElementById('ed') || {}).value.trim();
    const a = cents((document.getElementById('ea') || {}).value);
    if (!d || isNaN(a) || a <= 0) { toast('Enter a description and amount.'); return; }
    try { post('Expense: ' + d, [{ a: 'exp', dr: a, cr: 0 }, { a: 'cash', dr: 0, cr: a }]); logActivity('expense', d + ' ' + kes(a)); save(); toast('Expense saved.'); render(); }
    catch (e) { toast(e.message); }
  }));
  main.querySelectorAll('[data-reverse]').forEach((btn) => btn.addEventListener('click', () => {
    const id = parseInt(btn.getAttribute('data-reverse'), 10);
    const reason = prompt('Reason for reversal (required):');
    if (reason === null) return;
    if (!reason.trim()) { toast('A reason is required.'); return; }
    reverseEntry(id, reason.trim());
  }));
  main.querySelectorAll('[data-dolock]').forEach((btn) => btn.addEventListener('click', () => {
    if (!can('lock')) return;
    const d = ((document.getElementById('lock-date') || {}).value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { toast('Use YYYY-MM-DD.'); return; }
    if (S.lockedThrough && d < S.lockedThrough) {
      const reason = prompt('Moving the lock back needs a reason:');
      const approver = prompt('Approver name:');
      if (!reason || !approver) { toast('Reopening needs a reason and approver.'); return; }
      S.lockedThrough = d;
      logActivity('reopen', d + ' ' + reason + ' by ' + approver);
    } else {
      S.lockedThrough = d;
      logActivity('lock', d);
    }
    save();
    toast('Period locked through ' + d);
    render();
  }));
  main.querySelectorAll('[data-setprice]').forEach((btn) => btn.addEventListener('click', () => {
    if (!can('plans')) return;
    const k = btn.getAttribute('data-setprice');
    const v = cents((document.getElementById('pl' + k) || {}).value);
    if (isNaN(v) || v < 0) return;
    S.plans[k] = v;
    save();
    toast('Price saved.');
    render();
  }));
  main.querySelectorAll('[data-runsim]').forEach((btn) => btn.addEventListener('click', () => {
    const id = (document.getElementById('sim-prod') || {}).value;
    const p = S.products.find((x) => x.id === id);
    const out = document.getElementById('sim-out');
    if (!p || !out) return;
    const np = cents((document.getElementById('sim-price') || {}).value);
    const nc = cents((document.getElementById('sim-cost') || {}).value);
    const price = isNaN(np) ? p.price : np;
    const cost = isNaN(nc) ? p.cost : nc;
    const oldM = p.price ? Math.round((p.price - p.cost) / p.price * 100) : 0;
    const newM = price ? Math.round((price - cost) / price * 100) : 0;
    out.innerHTML = '<div class="help-panel"><strong>Simulation only — no records changed</strong><br>' + esc(p.name) + ': margin ' + oldM + '% → ' + newM + '%.<br>Profit per unit: ' + kes(p.price - p.cost) + ' → ' + kes(price - cost) + '.<br>Assumption: volume stays the same; tax and discounts ignored.</div>';
  }));
  main.querySelectorAll('[data-askdoctor]').forEach((btn) => btn.addEventListener('click', () => {
    const q = ((document.getElementById('doctor-q') || {}).value || '').toLowerCase();
    const out = document.getElementById('doctor-a');
    if (!out) return;
    if (!q) { out.innerHTML = ''; return; }
    let ans = '';
    if (/best product|top product/.test(q)) {
      const { start, end } = periodRange('week');
      const map = {};
      S.sales.filter((s) => s.ts >= start && s.ts <= end).forEach((s) => (s.items || []).forEach((it) => {
        map[it.id] = (map[it.id] || 0) + it.q * (it.price || 0);
      }));
      const top = Object.entries(map).sort((a, b) => b[1] - a[1])[0];
      if (top) {
        const p = S.products.find((x) => x.id === top[0]);
        ans = 'Best product this week: <strong>' + esc(p ? p.name : top[0]) + '</strong> with ' + kes(top[1]) + ' in sales. Timeframe: last 7 days. From your sales records only.';
      } else ans = 'No sales this week yet.';
    } else if (/profit|margin/.test(q)) {
      const m = profitInPeriod('month');
      ans = 'This month: sales ' + kes(m.rev) + ', COGS ' + kes(m.cogs) + ', gross profit ' + kes(m.profit) + '. From posted sales and product costs.';
    } else if (/owe|credit|receivable/.test(q)) {
      ans = 'Customers owe you ' + kes(bal('ar')) + '. From credit sales not yet paid.';
    } else if (/unverified|mpesa|clearing/.test(q)) {
      ans = S.pays.filter((p) => p.conf !== 'verified').length + ' payment(s) still unverified. ' + kes(bal('clr')) + ' sits in M-Pesa clearing until a statement match.';
    } else {
      ans = 'Try: “best product this week”, “profit this month”, “who owes me”, or “unverified M-Pesa”.';
    }
    out.innerHTML = '<div class="help-panel">' + ans + '</div>';
  }));
  main.querySelectorAll('[data-scanstart]').forEach((btn) => btn.addEventListener('click', startScan));
  main.querySelectorAll('[data-scanstop]').forEach((btn) => btn.addEventListener('click', stopScan));
  main.querySelectorAll('[data-manualbar]').forEach((btn) => btn.addEventListener('click', () => {
    const raw = ((document.getElementById('barcode-manual') || {}).value || '').trim();
    if (!raw) return;
    const p = S.products.find((x) => x.barcode === raw || x.id === raw);
    if (p) { addCart(p.id); toast('Added ' + p.name); }
    else toast('No product matches that code.');
  }));

  const roleSel = document.getElementById('role-sel');
  if (roleSel) roleSel.addEventListener('change', () => { localStorage.setItem(ROLE_KEY, roleSel.value); logActivity('role_switch', roleSel.value); render(); });
  const bizName = document.getElementById('biz-name');
  if (bizName) bizName.addEventListener('change', () => { S.settings.businessName = bizName.value; save(); });
  const bizTill = document.getElementById('biz-till');
  if (bizTill) bizTill.addEventListener('change', () => { S.settings.till = bizTill.value; save(); });
  const bizPay = document.getElementById('biz-paybill');
  if (bizPay) bizPay.addEventListener('change', () => { S.settings.paybill = bizPay.value; save(); });

  // Scan status init
  if (sellMode === 'scan') {
    const status = document.getElementById('scan-status');
    if (status) status.textContent = window.BarcodeDetector ? 'Ready. Tap Start camera.' : 'BarcodeDetector not supported. Type the code instead.';
  }
}

// Event delegation for overlays
document.getElementById('overlays').addEventListener('click', (e) => {
  const t = e.target.closest('[data-cmd],[data-sharereceipt],[data-printreceipt],[data-closemodal]');
  if (!t) return;
  if (t.hasAttribute('data-cmd')) {
    const [action, arg] = t.getAttribute('data-cmd').split('|');
    closeCmd();
    if (action === 'tab') setTab(arg);
    else if (action === 'product') { setTab('sell'); addCart(arg); }
    else if (action === 'sale') { setTab('money'); toast('Sale #' + arg); }
  }
  if (t.hasAttribute('data-sharereceipt')) {
    if (!modal || modal.type !== 'receipt') return;
    const text = modal.text;
    if (navigator.share) navigator.share({ text }).catch(() => { if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Receipt copied. Paste into WhatsApp or SMS.')); });
    else if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Receipt copied. Paste into WhatsApp or SMS.'));
    else toast('Copy not available.');
  }
  if (t.hasAttribute('data-printreceipt')) {
    if (!modal || modal.type !== 'receipt') return;
    const w = window.open('', '_blank');
    w.document.write('<pre style="font:14px monospace;padding:24px">' + esc(modal.text) + '</pre>');
    w.document.close();
    w.print();
  }
  if (t.hasAttribute('data-closemodal')) closeModal();
});

document.getElementById('fab-sale').addEventListener('click', () => setTab('sell'));
document.getElementById('theme-btn').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});
document.getElementById('side-theme').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});
document.getElementById('search-open').addEventListener('click', openCmd);
document.getElementById('side-cmd').addEventListener('click', openCmd);
document.getElementById('side-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (btn) setTab(btn.getAttribute('data-tab'));
});
document.getElementById('bottom-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (btn) setTab(btn.getAttribute('data-tab'));
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmd(); }
  if (e.key === 'Escape') { closeCmd(); closeModal(); }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

render();
})();
