(function () {
'use strict';

const KEY = 'marginpilot.v1';
const THEME_KEY = 'marginpilot.theme';
const ROLE_KEY = 'marginpilot.role';
const AI_KEY = 'marginpilot.aiKey';
const AI_PROVIDER = 'marginpilot.aiProvider';

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
  owner: { label: 'Owner', can: ['sell', 'stock', 'money', 'ledger', 'plans', 'roles', 'reverse', 'lock', 'doctor', 'customers', 'reports'] },
  manager: { label: 'Manager', can: ['sell', 'stock', 'money', 'ledger', 'reverse', 'doctor', 'customers', 'reports'] },
  cashier: { label: 'Cashier', can: ['sell'] },
  stock_manager: { label: 'Stock manager', can: ['stock', 'sell'] },
  accountant: { label: 'Accountant', can: ['money', 'ledger', 'doctor', 'reverse', 'reports', 'customers'] }
};

let S = {
  products: [], entries: [], sales: [], pays: [], confs: [],
  customers: [], activity: [], plans: { small: 10000, big: 25000 },
  n: 1, offlineQueue: [], lockedThrough: null,
  settings: { businessName: 'My business', till: '', paybill: '', currency: 'KES' },
  aiChat: []
};
try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const p = JSON.parse(raw);
    S = Object.assign(S, p);
    if (!S.customers) S.customers = [];
    if (!S.activity) S.activity = [];
    if (!S.offlineQueue) S.offlineQueue = [];
    if (!S.settings) S.settings = { businessName: 'My business', till: '', paybill: '', currency: 'KES' };
    if (!S.aiChat) S.aiChat = [];
  }
} catch (e) {}

function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
function logActivity(action, detail) {
  S.activity.unshift({ ts: Date.now(), role: currentRole(), action, detail: detail || '' });
  if (S.activity.length > 300) S.activity.length = 300;
  save();
}
function currentRole() { return localStorage.getItem(ROLE_KEY) || 'owner'; }
function can(action) { return (ROLES[currentRole()] || ROLES.owner).can.includes(action); }

function applyTheme(t) {
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else {
    document.documentElement.removeAttribute('data-theme');
    t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  localStorage.setItem(THEME_KEY, t === 'system' ? 'system' : t);
}
(function () {
  const s = localStorage.getItem(THEME_KEY);
  applyTheme(s === 'dark' || s === 'light' ? s : 'system');
})();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CURRENCIES = {
  KES: { country: 'Kenya', sym: 'KSh', loc: 'en-KE', dec: 2, dial: '+254', mm: 'M-Pesa', mmFull: 'M-Pesa' },
  TZS: { country: 'Tanzania', sym: 'TSh', loc: 'en-TZ', dec: 0, dial: '+255', mm: 'Mobile money', mmFull: 'M-Pesa, Tigo Pesa, Airtel Money, HaloPesa' },
  UGX: { country: 'Uganda', sym: 'USh', loc: 'en-UG', dec: 0, dial: '+256', mm: 'Mobile money', mmFull: 'MTN MoMo, Airtel Money' }
};
const CC = () => (S.settings && CURRENCIES[S.settings.currency] ? S.settings.currency : 'KES');
const cur = () => CURRENCIES[CC()];
const fmtIn = (code, n) => { const c = CURRENCIES[code]; return c.sym + ' ' + (Number(n) / 100).toLocaleString(c.loc, { minimumFractionDigits: c.dec, maximumFractionDigits: c.dec }); };
const kes = (n) => fmtIn(CC(), n);
const mm = () => cur().mm;
const codeOk = (c) => CC() === 'KES' ? /^[A-Z0-9]{10}$/.test(c) : /^[A-Z0-9]{6,16}$/.test(c);
const getRates = () => Object.assign({ KES: 1, TZS: 19.5, UGX: 28 }, (S.settings && S.settings.rates) || {});
const cents = (v) => { const x = Math.round(parseFloat(String(v).replace(/,/g, '')) * 100); return Number.isFinite(x) ? x : NaN; };
const bal = (k) => {
  let d = 0, c = 0;
  S.entries.forEach((e) => e.lines.forEach((l) => { if (l.a === k) { d += l.dr; c += l.cr; } }));
  return ACC[k][2] === 'D' ? d - c : c - d;
};
const uid = () => 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDate = (ts) => {
  const d = new Date(ts);
  return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
};
const fmtDay = (ts) => new Date(ts).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });

/* ===== Ledger ===== */
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
  r.isRev = true; r.reverses = id; e.reversed = true;
  logActivity('reverse', '#' + id + ' ' + (reason || ''));
  save(); toast('Entry reversed.'); render();
}

/* ===== M-Pesa ===== */
const PARSER_VERSION = 'v1-unverified';
function parseSms(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const out = { ok: false, version: PARSER_VERSION, code: null, amountMinor: null, direction: null, counterparty: null, date: null, time: null, issues: [] };
  const code = t.match(/\b([A-Z0-9]{10})\s+Confirmed/i);
  if (!code) out.issues.push('No transaction code followed by "Confirmed"');
  else out.code = code[1].toUpperCase();
  const amt = t.match(/(?:Ksh|TSh|Tsh|TZS|UGX|USh)\.?\s?([\d,]+(?:\.\d{1,2})?)/i);
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
      try { post('Verify M-Pesa ' + code, [{ a: 'till', dr: pay.amt, cr: 0 }, { a: 'clr', dr: 0, cr: pay.amt }], code); } catch (e) {}
    }
    save();
  }
}
function importStatement() {
  const el = document.getElementById('stmt');
  if (!el) return;
  let n = 0;
  el.value.split(/\n/).map((l) => l.trim()).filter(Boolean).forEach((line) => {
    const m = line.match(/([A-Z0-9]{10})\s*[,;\s]\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (!m) return;
    const code = m[1].toUpperCase(), amt = cents(m[2]);
    if (isNaN(amt) || S.confs.some((c) => c.code === code)) return;
    S.confs.push({ code, amt, sale: null, ts: Date.now() });
    n++; matchCode(code);
  });
  el.value = '';
  logActivity('import_statement', n + ' lines');
  save(); toast(n ? n + ' statement line(s) imported.' : 'No new codes found.'); render();
}

/* ===== Offline ===== */
let online = navigator.onLine;
function updateOnline() {
  online = navigator.onLine;
  const el = document.getElementById('sync-status');
  if (!el) return;
  const pending = S.offlineQueue.length;
  if (!online) { el.textContent = 'Offline'; el.className = 'sync-badge'; }
  else if (pending) { el.textContent = 'Waiting to sync (' + pending + ')'; el.className = 'sync-badge'; S.offlineQueue = []; save(); }
  else { el.textContent = 'Online'; el.className = 'sync-badge online'; }
}
addEventListener('online', updateOnline);
addEventListener('offline', updateOnline);
function enqueue(op) {
  S.offlineQueue.push({ id: uid(), ts: Date.now(), ...op });
  save(); updateOnline();
}

/* ===== Period helpers ===== */
function periodRange(p) {
  const now = new Date(), start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (p === 'week') { const day = start.getDay() || 7; start.setDate(start.getDate() - day + 1); }
  else if (p === 'month') start.setDate(1);
  else if (p === 'quarter') start.setMonth(Math.floor(start.getMonth() / 3) * 3, 1);
  else if (p === 'year') start.setMonth(0, 1);
  else if (p === 'all') start.setTime(0);
  return { start: start.getTime(), end: now.getTime() };
}
function salesInPeriod(p) {
  const { start, end } = periodRange(p);
  return S.sales.filter((s) => s.ts >= start && s.ts <= end && !s.refunded);
}
function profitInPeriod(p) {
  let rev = 0, cogs = 0, disc = 0;
  salesInPeriod(p).forEach((s) => {
    rev += s.total + (s.discount || 0);
    disc += s.discount || 0;
    (s.items || []).forEach((it) => {
      const cost = it.cost != null ? it.cost : (S.products.find((x) => x.id === it.id)?.cost || 0);
      cogs += it.q * cost;
    });
  });
  return { rev, cogs, disc, profit: rev - disc - cogs, netRev: rev - disc };
}

/* ===== Alerts (real data only) ===== */
function buildAlerts() {
  const a = [];
  const flagged = S.pays.filter((p) => p.conf === 'flagged');
  const oldUnver = S.pays.filter((p) => p.conf !== 'verified' && Date.now() - p.ts > 864e5);
  const low = S.products.filter((p) => p.qty <= 2);
  const overdue = S.customers.filter((c) => (c.balance || 0) > 0);
  const unm = S.confs.filter((c) => !c.sale);
  flagged.forEach((p) => a.push({ type: 'bad', title: 'Flagged M-Pesa ' + p.code, body: p.note || 'Amount in message did not match sale.', ts: p.ts }));
  if (oldUnver.length) a.push({ type: 'warn', title: oldUnver.length + ' unverified payment(s) > 24h', body: 'Still in M-Pesa clearing until matched to a statement.', ts: Date.now() });
  low.forEach((p) => a.push({ type: 'warn', title: 'Low stock: ' + p.name, body: 'Only ' + p.qty + ' left. Reorder or adjust stock.', ts: Date.now() }));
  overdue.forEach((c) => a.push({ type: 'warn', title: c.name + ' owes ' + kes(c.balance), body: 'Credit sale not fully paid.', ts: Date.now() }));
  if (unm.length) a.push({ type: 'warn', title: unm.length + ' statement payment(s) with no sale', body: 'Money received but no matching sale recorded.', ts: Date.now() });
  return a;
}

/* ===== AI — local intelligence over real records ===== */
function businessContext() {
  const m = profitInPeriod('month');
  const w = profitInPeriod('week');
  const t = profitInPeriod('today');
  const topWeek = {};
  salesInPeriod('week').forEach((s) => (s.items || []).forEach((it) => {
    topWeek[it.id] = (topWeek[it.id] || 0) + it.q * (it.price || 0);
  }));
  const topList = Object.entries(topWeek).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, v]) => {
    const p = S.products.find((x) => x.id === id);
    return { name: p ? p.name : id, sales: v };
  });
  return {
    business: S.settings.businessName,
    today: t, week: w, month: m,
    cash: bal('cash'), till: bal('till'), clr: bal('clr'), ar: bal('ar'), inv: bal('inv'), exp: bal('exp'),
    products: S.products.length, salesCount: S.sales.length,
    lowStock: S.products.filter((p) => p.qty <= 2).map((p) => ({ name: p.name, qty: p.qty })),
    unverifiedPays: S.pays.filter((p) => p.conf !== 'verified').length,
    customersOwing: S.customers.filter((c) => (c.balance || 0) > 0).map((c) => ({ name: c.name, balance: c.balance })),
    topWeek: topList,
    productsDetail: S.products.map((p) => ({
      name: p.name, price: p.price, cost: p.cost, qty: p.qty,
      margin: p.price ? Math.round((p.price - p.cost) / p.price * 100) : 0
    }))
  };
}

function localAI(question) {
  const q = (question || '').toLowerCase().trim();
  const ctx = businessContext();
  const cite = (text, source) => ({ text, cite: source });

  if (!q) return cite('Ask about sales, profit, stock, customers, M-Pesa, or what needs attention.', 'Ready');

  if (/help|what can|capabilities/.test(q)) {
    return cite('I can answer from your own MarginPilot records: sales and profit by period, best products, low stock, money owed, unverified M-Pesa, expenses, and a plain-language health check. I do not invent numbers. For cloud AI (Grok/OpenAI), add an API key in Settings.', 'Local assistant');
  }
  if (/health|how.*(business|doing|going)|summary|overview|brief/.test(q)) {
    const margin = ctx.month.netRev ? Math.round((ctx.month.profit / ctx.month.netRev) * 100) : 0;
    return cite(
      'This month: sales ' + kes(ctx.month.netRev) + ', cost of goods ' + kes(ctx.month.cogs) + ', gross profit ' + kes(ctx.month.profit) + ' (' + margin + '% margin). ' +
      'Cash ' + kes(ctx.cash) + ', verified M-Pesa ' + kes(ctx.till) + (ctx.clr ? ', ' + kes(ctx.clr) + ' awaiting verification' : '') + '. ' +
      (ctx.ar ? 'Customers owe you ' + kes(ctx.ar) + '. ' : '') +
      (ctx.lowStock.length ? ctx.lowStock.length + ' product(s) low on stock. ' : 'Stock levels look fine. ') +
      (ctx.unverifiedPays ? ctx.unverifiedPays + ' M-Pesa payment(s) still unverified.' : 'No unverified M-Pesa backlog.'),
      'Month to date · your sales, ledger balances, stock and payments'
    );
  }
  if (/today|this morning/.test(q) && /sale|revenue|profit|made|earn/.test(q)) {
    return cite('Today: ' + salesInPeriod('today').length + ' sale(s) totalling ' + kes(ctx.today.netRev) + '. Gross profit ' + kes(ctx.today.profit) + ' after cost of goods ' + kes(ctx.today.cogs) + '.', 'Sales recorded today');
  }
  if (/week/.test(q) && /sale|revenue|profit/.test(q)) {
    return cite('This week: ' + kes(ctx.week.netRev) + ' in sales, COGS ' + kes(ctx.week.cogs) + ', gross profit ' + kes(ctx.week.profit) + '.', 'Calendar week to now');
  }
  if (/month|monthly/.test(q) && /sale|revenue|profit|margin/.test(q)) {
    const margin = ctx.month.netRev ? Math.round((ctx.month.profit / ctx.month.netRev) * 100) : 0;
    return cite('This month: net sales ' + kes(ctx.month.netRev) + (ctx.month.disc ? ' after ' + kes(ctx.month.disc) + ' discounts' : '') + ', COGS ' + kes(ctx.month.cogs) + ', gross profit ' + kes(ctx.month.profit) + ' (' + margin + '%). Operating expenses on books: ' + kes(ctx.exp) + '.', 'Calendar month · sales + product costs + expense journal');
  }
  if (/best product|top product|selling well|popular/.test(q)) {
    if (!ctx.topWeek.length) return cite('No sales this week yet, so there is no top product.', 'Week sales');
    const lines = ctx.topWeek.map((t, i) => (i + 1) + '. ' + t.name + ' — ' + kes(t.sales)).join('\n');
    return cite('Top products this week by sales value:\n' + lines, 'Week sales line items');
  }
  if (/low stock|out of stock|reorder|inventory level/.test(q)) {
    if (!ctx.lowStock.length) return cite('No products at 2 or fewer units. Inventory looks healthy by that rule.', 'Product quantities ≤ 2');
    return cite('Low stock (≤2 units):\n' + ctx.lowStock.map((p) => '• ' + p.name + ' — ' + p.qty + ' left').join('\n'), 'Product quantities');
  }
  if (/owe|credit|receivable|who owes|debtor/.test(q)) {
    if (!ctx.customersOwing.length) return cite('No customers currently owe you money on credit sales.', 'Customer balances');
    return cite('Money owed to you (' + kes(ctx.ar) + ' total):\n' + ctx.customersOwing.map((c) => '• ' + c.name + ' — ' + kes(c.balance)).join('\n'), 'Credit sales balances');
  }
  if (/unverified|clearing|mpesa.*pending|pending.*mpesa/.test(q)) {
    return cite(ctx.unverifiedPays + ' M-Pesa payment(s) not yet verified. ' + kes(ctx.clr) + ' sits in clearing until a statement line matches the code. A pasted SMS alone never marks money collected.', 'Payment confirmations + clearing account');
  }
  if (/cash position|how much cash|liquidity|money in/.test(q)) {
    return cite('Cash in hand ' + kes(ctx.cash) + ', verified M-Pesa Till ' + kes(ctx.till) + ', awaiting verification ' + kes(ctx.clr) + ', money owed to you ' + kes(ctx.ar) + '. Liquid (cash+till): ' + kes(ctx.cash + ctx.till) + '.', 'Ledger balances');
  }
  if (/margin|which product.*profit|most profitable/.test(q)) {
    const sorted = ctx.productsDetail.filter((p) => p.price > 0).sort((a, b) => b.margin - a.margin);
    if (!sorted.length) return cite('Add products with price and cost to see margins.', 'Products');
    return cite('Highest margin products:\n' + sorted.slice(0, 5).map((p) => '• ' + p.name + ' — ' + p.margin + '% (sell ' + kes(p.price) + ', cost ' + kes(p.cost) + ')').join('\n'), 'Current product price and cost');
  }
  if (/expense|spending|costs besides|operating/.test(q)) {
    return cite('Operating expenses on the books: ' + kes(ctx.exp) + '. This is from expense journal entries paid in cash, not cost of goods.', 'Expense account balance');
  }
  if (/attention|problem|risk|alert|issue|wrong/.test(q)) {
    const alerts = buildAlerts();
    if (!alerts.length) return cite('Nothing urgent. No flagged payments, no low stock under the 2-unit rule, no overdue credit, no unmatched statement lines.', 'Alert rules on your data');
    return cite('Needs attention:\n' + alerts.slice(0, 6).map((a) => '• ' + a.title + ' — ' + a.body).join('\n'), 'Alert rules');
  }
  if (/recommend|should i|advice|what next/.test(q)) {
    const tips = [];
    if (ctx.unverifiedPays) tips.push('Import your M-Pesa statement in Money to verify ' + ctx.unverifiedPays + ' payment(s).');
    if (ctx.lowStock.length) tips.push('Restock: ' + ctx.lowStock.map((p) => p.name).join(', ') + '.');
    if (ctx.ar) tips.push('Follow up on ' + kes(ctx.ar) + ' owed by customers.');
    if (!S.products.length) tips.push('Add products in Stock so you can sell quickly.');
    if (!tips.length) tips.push('Keep recording sales and verifying M-Pesa. Your books look orderly.');
    return cite(tips.join('\n'), 'Derived from your current gaps');
  }
  // product name match
  for (const p of S.products) {
    if (q.includes(p.name.toLowerCase())) {
      const margin = p.price ? Math.round((p.price - p.cost) / p.price * 100) : 0;
      let sold = 0, revenue = 0;
      S.sales.filter((s) => !s.refunded).forEach((s) => (s.items || []).forEach((it) => {
        if (it.id === p.id) { sold += it.q; revenue += it.q * (it.price || p.price); }
      }));
      return cite(p.name + ': sell ' + kes(p.price) + ', cost ' + kes(p.cost) + ', margin ' + margin + '%, stock ' + p.qty + '. Lifetime sold ' + sold + ' units for ' + kes(revenue) + '.', 'Product record + sales history');
    }
  }
  return cite(
    'I could not match that to a clear question. Try: “How is the business doing?”, “Best product this week”, “Who owes me?”, “Low stock”, “Cash position”, or a product name. Cloud AI can handle freer questions if you add an API key in Settings.',
    'Local pattern match'
  );
}

async function cloudAI(question) {
  const key = localStorage.getItem(AI_KEY) || '';
  const provider = localStorage.getItem(AI_PROVIDER) || 'xai';
  if (!key) return null;
  const ctx = businessContext();
  const system = 'You are MarginPilot AI for an East African SME. Answer only using the JSON business data provided. Use ' + cur().sym + ' amounts. Never invent sales, stock, or balances. If data is missing, say so. Be concise and practical. Data:\n' + JSON.stringify(ctx);
  try {
    if (provider === 'xai') {
      const res = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: 'grok-2-latest',
          messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
          temperature: 0.2
        })
      });
      if (!res.ok) throw new Error('API ' + res.status);
      const data = await res.json();
      return { text: data.choices?.[0]?.message?.content || 'No response', cite: 'Grok via xAI · grounded on your local snapshot' };
    }
    // OpenAI-compatible
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
        temperature: 0.2
      })
    });
    if (!res.ok) throw new Error('API ' + res.status);
    const data = await res.json();
    return { text: data.choices?.[0]?.message?.content || 'No response', cite: 'OpenAI · grounded on your local snapshot' };
  } catch (err) {
    return { text: 'Cloud AI request failed: ' + (err.message || 'network error') + '. Local answer is still available.', cite: 'Error' };
  }
}

async function askAI(question) {
  const local = localAI(question);
  const key = localStorage.getItem(AI_KEY);
  if (key) {
    const cloud = await cloudAI(question);
    if (cloud && cloud.cite !== 'Error') return cloud;
    if (cloud) return { text: local.text + '\n\n(' + cloud.text + ')', cite: local.cite };
  }
  return local;
}

/* ===== UI state ===== */
let tab = 'home';
let period = 'today';
let moneySub = 'overview';
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
let aiBusy = false;

function toast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3400);
}

const TABS = [
  { id: 'home', label: 'Home', icon: 'home', need: null, section: 'main' },
  { id: 'sell', label: 'Sell', icon: 'sell', need: 'sell', section: 'main' },
  { id: 'stock', label: 'Stock', icon: 'stock', need: 'stock', section: 'main' },
  { id: 'money', label: 'Money', icon: 'money', need: 'money', section: 'main' },
  { id: 'customers', label: 'Customers', icon: 'people', need: 'customers', section: 'more' },
  { id: 'reports', label: 'Reports', icon: 'chart', need: 'reports', section: 'more' },
  { id: 'ai', label: 'AI', icon: 'ai', need: null, section: 'more' },
  { id: 'more', label: 'More', icon: 'more', need: null, section: 'main' }
];
const MOBILE_TABS = ['home', 'sell', 'stock', 'money', 'more'];

function iconSvg(name) {
  const i = {
    home: '<path d="M3 12l9-9 9 9M5 10v10h5v-6h4v6h5V10"/>',
    sell: '<path d="M6 6h15l-1.5 9h-12zM6 6L5 3H2m4 15a1 1 0 100 2 1 1 0 000-2zm11 0a1 1 0 100 2 1 1 0 000-2z"/>',
    stock: '<path d="M3 7l9-4 9 4-9 4-9-4zm0 5l9 4 9-4m-18 5l9 4 9-4"/>',
    money: '<path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>',
    more: '<circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>',
    people: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>',
    chart: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
    ai: '<path d="M12 2a4 4 0 014 4v2h2a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8a2 2 0 012-2h2V6a4 4 0 014-4z"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/>'
  };
  return '<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">' + (i[name] || '') + '</svg>';
}

function setTab(id) {
  const t = TABS.find((x) => x.id === id);
  if (t && t.need && !can(t.need)) { toast('Your role cannot open ' + t.label + '.'); return; }
  tab = id;
  cart = []; parsedSms = null; customAmt = ''; discountPct = 0;
  stopScan();
  render();
}
window.setTab = setTab;

function lockedView(name) {
  return '<div class="card"><h2>' + esc(name) + '</h2><p>Your current role cannot open this section.</p><button type="button" class="btn btn-secondary" data-goto="more">Change role in More</button></div>';
}

/* ===== Views ===== */
function viewHome() {
  const { rev, cogs, profit, netRev, disc } = profitInPeriod(period);
  const sales = salesInPeriod(period);
  const alerts = buildAlerts();
  const periods = [['today','Today'],['week','Week'],['month','Month'],['quarter','Quarter'],['year','Year']];

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - i);
    const next = new Date(d); next.setDate(next.getDate() + 1);
    const tot = S.sales.filter((s) => s.ts >= d.getTime() && s.ts < next.getTime() && !s.refunded).reduce((a, s) => a + s.total, 0);
    days.push({ label: d.toLocaleDateString('en-KE', { weekday: 'short' }), v: tot });
  }
  const maxV = Math.max(...days.map((d) => d.v), 1);
  const chartH = 130, barW = 28, gap = 10;
  const bars = days.map((d, i) => {
    const h = Math.round((d.v / maxV) * (chartH - 24));
    const x = i * (barW + gap) + 8, y = chartH - h - 16;
    return '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + Math.max(h, 2) + '" rx="5" fill="var(--em)" opacity="' + (d.v ? 1 : 0.2) + '"/><text x="' + (x + barW / 2) + '" y="' + (chartH - 2) + '" text-anchor="middle" font-size="10" fill="var(--mu)">' + d.label + '</text>';
  }).join('');

  const prodSales = {};
  sales.forEach((s) => (s.items || []).forEach((it) => {
    prodSales[it.id] = (prodSales[it.id] || 0) + it.q * (it.price != null ? it.price : 0);
  }));
  const top = Object.entries(prodSales).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const margin = netRev ? Math.round((profit / netRev) * 100) : 0;

  return installBanner() + '<div class="page-title"><div><h1>Good ' + greet + '</h1><p class="muted" style="margin:0">' + esc(S.settings.businessName) + ' · ' + new Date().toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long' }) + '</p></div>' +
    '<div class="actions"><button type="button" class="btn btn-ai btn-sm" data-goto="ai">Ask AI</button></div></div>' +
    '<div class="period-switch" role="group">' + periods.map(([id, l]) => '<button type="button" aria-pressed="' + (period === id) + '" data-period="' + id + '">' + l + '</button>').join('') + '</div>' +
    '<div class="card"><div class="card-head"><h3>Briefing</h3><span class="tag">' + period + '</span></div><div class="grid" style="margin:0">' +
    '<button type="button" class="stat" data-goto="reports"><div class="lbl">Sales</div><div class="val">' + kes(netRev) + '</div><div class="sub">' + sales.length + ' sale(s)' + (disc ? ' · discounts ' + kes(disc) : '') + ' · actual</div></button>' +
    '<button type="button" class="stat" data-goto="reports"><div class="lbl">Gross profit</div><div class="val ' + (profit < 0 ? 'bad' : 'ok') + '">' + kes(profit) + '</div><div class="sub">' + margin + '% margin · after COGS · actual</div></button>' +
    '<button type="button" class="stat" data-goto="money"><div class="lbl">Cash + M-Pesa</div><div class="val">' + kes(bal('cash') + bal('till')) + '</div><div class="sub">Cash ' + kes(bal('cash')) + ' · Till ' + kes(bal('till')) + '</div></button>' +
    '<button type="button" class="stat" data-goto="money"><div class="lbl">Awaiting verification</div><div class="val est">' + kes(bal('clr')) + '</div><div class="sub">Unverified M-Pesa · estimated</div></button></div></div>' +
    (alerts.length
      ? '<div class="card gold"><div class="card-head"><h3>Needs attention</h3><button type="button" class="btn btn-ghost btn-sm" data-goto="alerts">All alerts</button></div>' +
        alerts.slice(0, 4).map((a) => '<div class="alert-item"><div class="alert-icon ' + (a.type === 'bad' ? 'bad' : '') + '">!</div><div><strong>' + esc(a.title) + '</strong><br><span class="muted">' + esc(a.body) + '</span></div></div>').join('') + '</div>'
      : '<div class="card"><p class="ok" style="margin:0"><strong>All clear.</strong> No flagged payments, low stock, or overdue credit right now.</p></div>') +
    '<div class="grid-2"><div class="card"><h3>Sales · 7 days</h3><div class="chart-wrap" role="img" aria-label="Daily sales chart"><svg viewBox="0 0 280 ' + chartH + '">' + bars + '</svg></div></div>' +
    '<div class="card"><h3>Top products · ' + period + '</h3>' +
    (top.length ? top.map(([id, v]) => { const p = S.products.find((x) => x.id === id); return '<div class="row"><span>' + esc(p ? p.name : id) + '</span><b class="mono">' + kes(v) + '</b></div>'; }).join('') : '<p class="muted">No sales in this period.</p>') +
    '</div></div>' +
    '<div class="card"><div class="card-head"><h3>Recent sales</h3><button type="button" class="btn btn-ghost btn-sm" data-goto="money">See all</button></div>' +
    (S.sales.filter((s) => !s.refunded).slice(-5).reverse().map((s) =>
      '<div class="row"><span>#' + s.id + ' · ' + esc(s.method) + '<br><small class="muted">' + fmtDate(s.ts) + '</small></span><b class="mono">' + kes(s.total) + '</b></div>'
    ).join('') || '<p class="muted">No sales yet. Tap + to record one.</p>') + '</div>' +
    (!S.products.length && !S.sales.length
      ? '<div class="card"><h3>Get started</h3><ol class="muted" style="margin:0;padding-left:18px"><li>Add products in <strong>Stock</strong></li><li>Record a sale from <strong>Sell</strong> or the + button</li><li>Paste M-Pesa SMS and import statements in <strong>Money</strong></li><li>Ask the <strong>AI</strong> tab how the business is doing</li></ol></div>'
      : '');
}

function viewSell() {
  if (!can('sell')) return lockedView('Sell');
  const lines = cart.map((c) => {
    const price = c.custom ? c.price : (S.products.find((x) => x.id === c.id)?.price || 0);
    const name = c.custom ? (c.name || 'Custom') : (S.products.find((x) => x.id === c.id)?.name || '?');
    return '<div class="row"><span>' + esc(name) + ' × ' + c.q +
      ' <button type="button" class="btn btn-sm btn-ghost" data-qty="' + c.id + '|-1">−</button>' +
      ' <button type="button" class="btn btn-sm btn-ghost" data-qty="' + c.id + '|1">+</button></span><b class="mono">' + kes(c.q * price) + '</b></div>';
  }).join('');
  let sub = 0;
  cart.forEach((c) => { sub += c.q * (c.custom ? c.price : (S.products.find((x) => x.id === c.id)?.price || 0)); });
  const discAmt = Math.round(sub * (discountPct / 100));
  const total = Math.max(0, sub - discAmt);
  const meth = (document.getElementById('meth') || {}).value || 'cash';

  let body = '<div class="page-title"><h1>New sale</h1></div><div class="period-switch">' +
    [['products','Products'],['custom','Custom'],['scan','Scan']].map(([id, l]) =>
      '<button type="button" aria-pressed="' + (sellMode === id) + '" data-sellmode="' + id + '">' + l + '</button>'
    ).join('') + '</div>';

  if (sellMode === 'products') {
    body += '<div class="card"><h3>Products</h3>' + (S.products.length
      ? '<div class="prod-grid">' + S.products.map((p) =>
        '<button type="button" class="prod-tile" data-add="' + p.id + '" ' + (p.qty < 1 ? 'disabled' : '') + '><b>' + esc(p.name) + '</b>' + kes(p.price) + '<br><small>' + p.qty + ' left</small></button>'
      ).join('') + '</div>'
      : '<div class="empty"><h3>No products</h3><p>Add products in Stock first.</p><button type="button" class="btn btn-primary" data-goto="stock">Go to Stock</button></div>') + '</div>';
  }
  if (sellMode === 'custom') {
    body += '<div class="card"><h3>Custom amount</h3><p class="muted">Services or items not in stock</p>' +
      '<div style="font-size:1.75rem;font-weight:700;text-align:center;margin:12px 0" class="mono">' + (customAmt ? kes(cents(customAmt) || 0) : kes(0)) + '</div>' +
      '<div class="keypad">' + [1,2,3,4,5,6,7,8,9,'.',0,'⌫'].map((k) => '<button type="button" data-key="' + k + '">' + k + '</button>').join('') +
      '<button type="button" class="wide" data-addcustom="1">Add to sale</button></div></div>';
  }
  if (sellMode === 'scan') {
    body += '<div class="card"><h3>Barcode</h3><video id="scan-video" playsinline style="width:100%;max-height:240px;border-radius:10px;background:#000;display:none"></video>' +
      '<p id="scan-status" class="muted">Checking camera…</p>' +
      '<button type="button" class="btn btn-primary" data-scanstart="1">Start camera</button> <button type="button" class="btn btn-secondary" data-scanstop="1">Stop</button>' +
      '<label class="field" style="margin-top:12px"><span>Or type barcode / SKU</span><input id="barcode-manual" inputmode="numeric"></label>' +
      '<button type="button" class="btn btn-secondary" data-manualbar="1">Add by code</button></div>';
  }

  body += '<div class="card"><h3>Cart</h3>' + (lines || '<p class="muted">Tap products or add a custom amount.</p>');
  if (sub) {
    body += '<div class="row"><span>Subtotal</span><b class="mono">' + kes(sub) + '</b></div>' +
      '<label class="field"><span>Discount %</span><input type="number" id="disc" min="0" max="100" value="' + discountPct + '" inputmode="numeric"></label>' +
      (discAmt ? '<div class="row"><span>Discount</span><b class="bad mono">−' + kes(discAmt) + '</b></div>' : '') +
      '<div class="row"><span><strong>Total</strong></span><b class="mono" style="font-size:1.25rem">' + kes(total) + '</b></div>' +
      '<label class="field"><span>Payment</span><select id="meth">' +
      ['cash','mpesa','split','credit'].map((m) => '<option value="' + m + '"' + (meth === m ? ' selected' : '') + '>' +
        ({ cash: 'Cash', mpesa: mm(), split: 'Split cash + ' + mm(), credit: 'Credit (pay later)' }[m]) + '</option>').join('') +
      '</select></label>';
    if (meth === 'mpesa' || meth === 'split') {
      body += '<label class="field"><span>Paste M-Pesa SMS</span><textarea id="sms">' + (parsedSms?.raw ? esc(parsedSms.raw) : '') + '</textarea></label>' +
        '<button type="button" class="btn btn-secondary" data-readsms="1">Read message</button>';
      if (parsedSms) {
        body += '<div class="help-panel"><strong>What was read</strong> (not saved yet)<br>Code: ' + esc(parsedSms.code || '—') +
          '<br>Amount: ' + (parsedSms.amountMinor != null ? kes(parsedSms.amountMinor) : '—') +
          '<br>From: ' + esc(parsedSms.counterparty || '—') + '<br>' +
          (parsedSms.issues?.length ? '<span class="bad">' + parsedSms.issues.map(esc).join('; ') + '</span>' : '<span class="ok">Looks complete</span>') +
          '<br><small>Stays unverified until statement match. SMS alone never completes payment.</small></div>';
      }
      body += '<label class="field"><span>M-Pesa code</span><input id="code" maxlength="16" style="text-transform:uppercase" value="' + esc(parsedSms?.code || '') + '"></label>';
    }
    if (meth === 'split') {
      body += '<div class="grid"><label class="field"><span>Cash (' + CC() + ')</span><input id="split-cash" inputmode="decimal"></label>' +
        '<label class="field"><span>M-Pesa (' + CC() + ')</span><input id="split-mpesa" inputmode="decimal"></label></div>';
    }
    if (meth === 'credit') {
      body += '<label class="field"><span>Customer name</span><input id="cust-name" list="cust-list" placeholder="Who owes this?"><datalist id="cust-list">' +
        S.customers.map((c) => '<option value="' + esc(c.name) + '">').join('') + '</datalist></label>';
    }
    body += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">' +
      '<button type="button" class="btn btn-primary" data-completesale="1"' + (cart.length ? '' : ' disabled') + '>Record sale</button>' +
      '<button type="button" class="btn btn-secondary" data-clearcart="1">Clear</button></div>';
  }
  return body + '</div>';
}

function viewStock() {
  if (!can('stock')) return lockedView('Stock');
  return '<div class="page-title"><h1>Stock</h1></div>' +
    '<div class="card"><h3>Add product</h3>' +
    '<label class="field"><span>Name</span><input id="pn"></label>' +
    '<div class="grid"><label class="field"><span>Selling price (' + CC() + ')</span><input id="pp" inputmode="decimal"></label>' +
    '<label class="field"><span>Cost (' + CC() + ')</span><input id="pc" inputmode="decimal"></label>' +
    '<label class="field"><span>Opening qty</span><input id="pq" inputmode="numeric" value="0"></label>' +
    '<label class="field"><span>Barcode / SKU</span><input id="pb" inputmode="numeric"></label></div>' +
    '<button type="button" class="btn btn-primary" data-addproduct="1">Add product</button></div>' +
    '<div class="card"><div class="card-head"><h3>Products</h3><span class="muted">' + S.products.length + ' items</span></div>' +
    (S.products.length ? S.products.map((p) => {
      const margin = p.price ? Math.round((p.price - p.cost) / p.price * 100) : 0;
      return '<div class="row"><span><strong>' + esc(p.name) + '</strong>' + (p.barcode ? ' · ' + esc(p.barcode) : '') +
        '<br><small class="muted">Sell ' + kes(p.price) + ' · cost ' + kes(p.cost) + ' · margin ' + margin + '%</small>' +
        (p.qty <= 2 ? '<br><span class="tag w">Low stock</span>' : '') + '</span>' +
        '<div style="text-align:right"><b>' + p.qty + '</b><br>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-adjust="' + p.id + '">Adjust</button></div></div>';
    }).join('') : '<div class="empty"><h3>No products</h3><p>Add your first product to start selling.</p></div>') + '</div>';
}

function viewMoney() {
  if (!can('money') && !can('ledger')) return lockedView('Money');
  const tag = (c) => ({ verified: '<span class="tag">Verified</span>', attested: '<span class="tag w">Attested</span>', flagged: '<span class="tag b">Flagged</span>' }[c] || '<span class="tag w">Unconfirmed</span>');
  const subs = [['overview','Overview'],['payments','M-Pesa'],['sales','Sales'],['ledger','Ledger']];
  let body = '<div class="page-title"><h1>Money</h1></div><div class="tabs-line">' +
    subs.map(([id, l]) => '<button type="button" aria-selected="' + (moneySub === id) + '" data-moneysub="' + id + '">' + l + '</button>').join('') + '</div>';

  if (moneySub === 'overview') {
    body += '<div class="grid">' +
      '<div class="stat" style="cursor:default"><div class="lbl">Cash</div><div class="val">' + kes(bal('cash')) + '</div><div class="sub">actual</div></div>' +
      '<div class="stat" style="cursor:default"><div class="lbl">M-Pesa Till</div><div class="val">' + kes(bal('till')) + '</div><div class="sub">verified · actual</div></div>' +
      '<div class="stat" style="cursor:default"><div class="lbl">Awaiting verification</div><div class="val est">' + kes(bal('clr')) + '</div><div class="sub">estimated</div></div>' +
      '<div class="stat" style="cursor:default"><div class="lbl">Money you are owed</div><div class="val">' + kes(bal('ar')) + '</div><div class="sub">credit</div></div></div>' +
      '<div class="card"><h3>Quick actions</h3><div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button type="button" class="btn btn-secondary" data-moneysub="payments">Import statement</button>' +
      '<button type="button" class="btn btn-secondary" data-moneysub="ledger">Record expense</button>' +
      '<button type="button" class="btn btn-secondary" data-goto="reports">Reports</button></div></div>';
  }
  if (moneySub === 'payments' && can('money')) {
    body += '<div class="card"><h3>Import M-Pesa statement</h3><p class="muted">One per line: code, amount — e.g. ABC1234567, 500.00</p>' +
      '<textarea id="stmt" placeholder="ABC1234567, 500.00"></textarea>' +
      '<button type="button" class="btn btn-primary" style="margin-top:8px" data-importstmt="1">Match payments</button></div>' +
      '<div class="card"><h3>Payments</h3>' +
      (S.pays.length ? S.pays.slice().reverse().map((p) =>
        '<div class="row"><span>' + esc(p.code) + ' · sale #' + p.sale + '<br><small class="muted">' + (p.src === 'manual' ? 'typed' : 'from SMS') + (p.note ? ' · ' + esc(p.note) : '') + '</small></span><span class="mono">' + kes(p.amt) + ' ' + tag(p.conf) + '</span></div>'
      ).join('') : '<p class="muted">No M-Pesa payments yet.</p>') + '</div>' +
      '<div class="card"><h3>Received, no sale</h3>' +
      (S.confs.filter((c) => !c.sale).map((c) => '<div class="row"><span>' + esc(c.code) + '</span><b class="mono">' + kes(c.amt) + '</b></div>').join('') || '<p class="muted">None.</p>') +
      '<p class="muted" style="font-size:0.8rem">Unmatched statement lines may be unrecorded sales or other income.</p></div>';
  }
  if (moneySub === 'sales') {
    body += '<div class="card"><h3>Sales history</h3>' +
      (S.sales.slice().reverse().map((s) =>
        '<div class="row"><span>#' + s.id + (s.refunded ? ' <span class="tag b">Refunded</span>' : '') + ' · ' + esc(s.method) +
        '<br><small class="muted">' + fmtDate(s.ts) + ' · ' + (s.items || []).length + ' item(s)</small></span>' +
        '<div style="text-align:right"><b class="mono">' + kes(s.total) + '</b><br>' +
        (!s.refunded && can('reverse') ? '<button type="button" class="btn btn-ghost btn-sm" data-refund="' + s.id + '">Refund</button>' : '') +
        '</div></div>'
      ).join('') || '<p class="muted">No sales yet.</p>') + '</div>';
  }
  if (moneySub === 'ledger' && can('ledger')) {
    const ks = Object.keys(ACC);
    let td = 0, tc = 0;
    const rows = ks.map((k) => {
      let d = 0, c = 0;
      S.entries.forEach((e) => e.lines.forEach((l) => { if (l.a === k) { d += l.dr; c += l.cr; } }));
      td += d; tc += c;
      return '<tr><td>' + ACC[k][0] + ' ' + ACC[k][1] + '</td><td class="n">' + kes(d) + '</td><td class="n">' + kes(c) + '</td></tr>';
    }).join('');
    body += '<div class="card"><h3>Trial balance</h3><div class="table-scroll"><table><thead><tr><th>Account</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead><tbody>' +
      rows + '<tr><th>Total</th><th class="n">' + kes(td) + '</th><th class="n">' + kes(tc) + '</th></tr></tbody></table></div>' +
      '<p class="' + (td === tc ? 'ok' : 'bad') + '"><strong>' + (td === tc ? 'Balanced.' : 'Out of balance.') + '</strong></p></div>' +
      '<div class="card"><h3>Expense (cash)</h3><label class="field"><span>Description</span><input id="ed"></label>' +
      '<label class="field"><span>Amount (' + CC() + ')</span><input id="ea" inputmode="decimal"></label>' +
      '<button type="button" class="btn btn-primary" data-addexpense="1">Save expense</button></div>' +
      '<div class="card"><h3>Journal</h3><p class="muted">Posted records cannot be edited — only reversed with a reason.</p>' +
      S.entries.slice().reverse().slice(0, 40).map((e) =>
        '<div class="row"><span>#' + e.id + ' ' + esc(e.memo) + '<br><small class="muted">' +
        e.lines.map((l) => ACC[l.a][1] + (l.dr ? ' Dr ' + kes(l.dr) : ' Cr ' + kes(l.cr))).join(' · ') +
        '</small></span>' + (e.reversed || e.isRev ? '<span class="tag w">' + (e.isRev ? 'Reversal' : 'Reversed') + '</span>' :
          (can('reverse') ? '<button type="button" class="btn btn-sm btn-secondary" data-reverse="' + e.id + '">Reverse</button>' : '')) + '</div>'
      ).join('') + '</div>';
    if (can('lock')) {
      body += '<div class="card"><h3>Period lock</h3><p class="muted">Locked through: <strong>' + (S.lockedThrough || 'nothing') + '</strong></p>' +
        '<label class="field"><span>Lock through (YYYY-MM-DD)</span><input id="lock-date"></label>' +
        '<button type="button" class="btn btn-secondary" data-dolock="1">Lock period</button></div>';
    }
  }
  return body;
}

function viewCustomers() {
  if (!can('customers')) return lockedView('Customers');
  return '<div class="page-title"><h1>Customers</h1></div>' +
    '<div class="card"><h3>Add customer</h3><label class="field"><span>Name</span><input id="new-cust"></label>' +
    '<label class="field"><span>Phone (optional)</span><input id="new-cust-phone" inputmode="tel"></label>' +
    '<button type="button" class="btn btn-primary" data-addcust="1">Add</button></div>' +
    '<div class="card"><div class="card-head"><h3>All customers</h3><span class="muted">' + S.customers.length + '</span></div>' +
    (S.customers.length ? S.customers.map((c) =>
      '<div class="row"><span><strong>' + esc(c.name) + '</strong>' + (c.phone ? '<br><small class="muted">' + esc(c.phone) + '</small>' : '') + '</span>' +
      '<div style="text-align:right">' + ((c.balance || 0) > 0
        ? '<b class="mono">' + kes(c.balance) + '</b><br><button type="button" class="btn btn-ghost btn-sm" data-paycredit="' + c.id + '">Record payment</button>'
        : '<span class="tag muted">Settled</span>') + '</div></div>'
    ).join('') : '<div class="empty"><h3>No customers yet</h3><p>Credit sales will add them automatically, or add one above.</p></div>') + '</div>' +
    '<div class="card"><p class="muted">Total money you are owed: <strong class="mono">' + kes(bal('ar')) + '</strong></p></div>';
}

function viewReports() {
  if (!can('reports')) return lockedView('Reports');
  const m = profitInPeriod('month'), w = profitInPeriod('week'), t = profitInPeriod('today');
  const exp = bal('exp');
  return '<div class="page-title"><h1>Reports</h1><button type="button" class="btn btn-ai btn-sm" data-goto="ai">Explain with AI</button></div>' +
    '<div class="card"><h3>Profit & loss snapshot</h3><div class="table-scroll"><table><thead><tr><th></th><th class="n">Today</th><th class="n">Week</th><th class="n">Month</th></tr></thead><tbody>' +
    '<tr><td>Sales</td><td class="n">' + kes(t.netRev) + '</td><td class="n">' + kes(w.netRev) + '</td><td class="n">' + kes(m.netRev) + '</td></tr>' +
    '<tr><td>Cost of goods</td><td class="n">' + kes(t.cogs) + '</td><td class="n">' + kes(w.cogs) + '</td><td class="n">' + kes(m.cogs) + '</td></tr>' +
    '<tr><td><strong>Gross profit</strong></td><td class="n"><strong>' + kes(t.profit) + '</strong></td><td class="n"><strong>' + kes(w.profit) + '</strong></td><td class="n"><strong>' + kes(m.profit) + '</strong></td></tr>' +
    '</tbody></table></div><p class="muted" style="margin-top:10px">Figures from recorded sales and product costs. Operating expenses (all time on books): ' + kes(exp) + '.</p></div>' +
    '<div class="card"><h3>Cash position</h3>' +
    '<div class="row"><span>Cash in hand</span><b class="mono">' + kes(bal('cash')) + '</b></div>' +
    '<div class="row"><span>M-Pesa verified</span><b class="mono">' + kes(bal('till')) + '</b></div>' +
    '<div class="row"><span>Awaiting verification</span><b class="mono">' + kes(bal('clr')) + '</b></div>' +
    '<div class="row"><span>Money you are owed</span><b class="mono">' + kes(bal('ar')) + '</b></div>' +
    '<div class="row"><span>Inventory value (at cost)</span><b class="mono">' + kes(bal('inv')) + '</b></div></div>' +
    '<div class="card"><h3>Product margins</h3>' +
    (S.products.length ? S.products.map((p) => {
      const margin = p.price ? Math.round((p.price - p.cost) / p.price * 100) : 0;
      return '<div class="row"><span>' + esc(p.name) + '<br><small class="muted">' + kes(p.price) + ' sell · ' + kes(p.cost) + ' cost</small></span>' +
        '<div style="min-width:80px;text-align:right"><b>' + margin + '%</b><div class="progress"><span style="width:' + Math.min(100, Math.max(0, margin)) + '%"></span></div></div></div>';
    }).join('') : '<p class="muted">No products.</p>') + '</div>';
}

function viewAI() {
  const hasKey = !!(localStorage.getItem(AI_KEY) || '');
  const provider = localStorage.getItem(AI_PROVIDER) || 'xai';
  return '<div class="page-title"><div><h1>AI Assistant</h1><p class="muted" style="margin:0">Answers from your records' + (hasKey ? ' · cloud connected' : ' · local') + '</p></div></div>' +
    '<div class="card">' +
    '<div class="pill-row">' +
    ['How is the business doing?', 'Best product this week', 'Who owes me?', 'Low stock', 'Cash position', 'What needs attention?'].map((q) =>
      '<button type="button" class="pill" data-aiq="' + esc(q) + '">' + esc(q) + '</button>'
    ).join('') + '</div>' +
    '<div class="chat" id="ai-chat">' +
    (S.aiChat.length ? S.aiChat.map((m) =>
      '<div class="bubble ' + m.role + '">' + esc(m.text).replace(/\n/g, '<br>') +
      (m.cite ? '<span class="cite">' + esc(m.cite) + '</span>' : '') + '</div>'
    ).join('') : '<div class="bubble ai">Hi — I read only your MarginPilot data. Ask about sales, profit, stock, customers, or M-Pesa. I will show the numbers and where they came from.' +
      (!hasKey ? '<span class="cite">Local mode · add an API key in Settings for Grok/OpenAI</span>' : '<span class="cite">Cloud AI key on file</span>') + '</div>') +
    '</div>' +
    '<div class="chat-input-row"><input id="ai-input" placeholder="Ask about your business…" autocomplete="off">' +
    '<button type="button" class="btn btn-ai" data-aisend="1"' + (aiBusy ? ' disabled' : '') + '>' + (aiBusy ? '…' : 'Ask') + '</button></div></div>' +
    '<div class="card"><h3>Cloud AI</h3>' +
    (hasKey
      ? '<p class="ok">API key saved in this browser (' + esc(provider) + '). Questions can use Grok or OpenAI with your data as context.</p><button type="button" class="btn btn-secondary btn-sm" data-clearkey="1">Remove key</button>'
      : '<p class="muted">Not connected yet. Local AI still works on your data. To enable cloud answers, paste an API key below.</p>' +
        '<label class="field"><span>Provider</span><select id="ai-provider"><option value="xai"' + (provider === 'xai' ? ' selected' : '') + '>xAI (Grok)</option><option value="openai"' + (provider === 'openai' ? ' selected' : '') + '>OpenAI</option></select></label>' +
        '<label class="field"><span>API key</span><input id="ai-key" type="password" placeholder="xai-… or sk-…" autocomplete="off"></label>' +
        '<button type="button" class="btn btn-secondary" data-savekey="1">Save key on this device</button>' +
        '<p class="lock-note">Key stays in localStorage only. Never sent to MarginPilot servers (there are none yet). Needed: xAI or OpenAI API access.</p>') +
    '</div>';
}

function viewAlerts() {
  const alerts = buildAlerts();
  return '<div class="page-title"><h1>Alerts</h1><button type="button" class="btn btn-secondary btn-sm" data-goto="more">Notification settings</button></div><div class="card">' +
    (alerts.length ? alerts.map((a) =>
      '<div class="alert-item"><div class="alert-icon ' + (a.type === 'bad' ? 'bad' : '') + '">!</div><div><strong>' + esc(a.title) + '</strong><br><span class="muted">' + esc(a.body) + '</span></div></div>'
    ).join('') : '<div class="empty"><h3>Nothing to fix</h3><p>No flagged payments, low stock, or overdue balances.</p></div>') + '</div>';
}

function viewMore() {
  const role = currentRole();
  return '<div class="page-title"><h1>More</h1></div>' +
    '<div class="card"><div class="card-head"><h3>Workspace</h3></div>' +
    '<button type="button" class="row row-click" data-goto="customers" style="width:100%;text-align:left"><span>Customers</span><span class="muted">›</span></button>' +
    '<button type="button" class="row row-click" data-goto="reports" style="width:100%;text-align:left"><span>Reports</span><span class="muted">›</span></button>' +
    '<button type="button" class="row row-click" data-goto="ai" style="width:100%;text-align:left"><span>AI Assistant</span><span class="muted">›</span></button>' +
    '<button type="button" class="row row-click" data-goto="alerts" style="width:100%;text-align:left"><span>Alerts</span>' + (buildAlerts().length ? '<span class="badge-count">' + buildAlerts().length + '</span>' : '<span class="muted">›</span>') + '</button></div>' +
    '<div class="card"><h3>Business</h3>' +
    '<label class="field"><span>Business name</span><input id="biz-name" value="' + esc(S.settings.businessName) + '"></label>' +
    '<label class="field"><span>Till number</span><input id="biz-till" value="' + esc(S.settings.till || '') + '" placeholder="Not connected yet"></label>' +
    '<label class="field"><span>Paybill</span><input id="biz-paybill" value="' + esc(S.settings.paybill || '') + '" placeholder="Not connected yet"></label>' +
    '<p class="muted" style="font-size:0.82rem">MarginPilot never holds customer money. Payments go to your Till or Paybill.</p></div>' +
    currencyCard() + '<div class="card"><h3>Role</h3><p>Acting as <strong>' + esc(ROLES[role].label) + '</strong></p>' +
    '<label class="field"><span>Switch role (demo)</span><select id="role-sel">' +
    Object.entries(ROLES).map(([k, v]) => '<option value="' + k + '"' + (k === role ? ' selected' : '') + '>' + esc(v.label) + '</option>').join('') +
    '</select></label><p class="lock-note">Staff accounts, PIN and biometrics need a server. Not connected yet.</p></div>' +
    '<div class="card"><h3>What-if simulator</h3><p class="muted">Never changes real records.</p>' +
    '<label class="field"><span>Product</span><select id="sim-prod">' + (S.products.map((p) => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('') || '<option value="">No products</option>') + '</select></label>' +
    '<div class="grid"><label class="field"><span>New price (' + CC() + ')</span><input id="sim-price" inputmode="decimal"></label>' +
    '<label class="field"><span>New cost (' + CC() + ')</span><input id="sim-cost" inputmode="decimal"></label></div>' +
    '<button type="button" class="btn btn-secondary" data-runsim="1">Simulate</button><div id="sim-out"></div></div>' +
    '<div class="card"><h3>Plans (KES)</h3><p class="muted">No hidden fees. Editable without code.</p><div class="grid">' +
    [{ k: 'small', n: 'Small Shop', d: 'Kiosks and individual traders' }, { k: 'big', n: 'Big Business', d: 'Supermarkets, wholesalers, restaurants' }].map((pl) =>
      '<div class="card flat" style="margin:0"><h3>' + pl.n + '</h3><div class="val" style="font-size:1.4rem">' + fmtIn('KES', S.plans[pl.k]) + '<small style="font-size:0.75rem;font-weight:500"> / mo</small></div>' +
      '<p class="muted" style="font-size:0.82rem">' + pl.d + '</p>' +
      (can('plans') ? '<label class="field"><span>Edit price</span><input id="pl' + pl.k + '" inputmode="decimal" value="' + (S.plans[pl.k] / 100) + '"><button type="button" class="btn btn-sm btn-secondary" style="margin-top:6px" data-setprice="' + pl.k + '">Save</button></label>' : '') + '</div>'
    ).join('') + '</div>' +
    '<div class="card gold" style="margin-top:12px"><h3>Not connected yet</h3><p>Billing, Daraja subscription payments and Super Admin need the server. <strong>Credentials:</strong> Safaricom Daraja production, hosted Postgres, SMS/WhatsApp provider.</p></div></div>' +
    '<div class="card"><h3>Activity</h3>' +
    (S.activity.slice(0, 15).map((a) => '<div class="row"><span><strong>' + esc(a.action) + '</strong> · ' + esc(a.role) + '<br><small class="muted">' + fmtDate(a.ts) + (a.detail ? ' · ' + esc(a.detail) : '') + '</small></span></div>').join('') || '<p class="muted">No activity yet.</p>') + '</div>' +
    notifCard() +
    '<div class="card"><h3>Install & data</h3>' + (isStandalone() ? '<p class="ok">Installed on this device.</p>' : '<button type="button" class="btn btn-primary" data-install="1">Install app on this device</button>') +
    '<p class="muted" style="margin-top:8px">Works on Android, iPhone/iPad, Windows, Mac and Chromebook. Data stays on this device (key <code>marginpilot.v1</code>).</p></div>';
}

/* ===== Actions ===== */
function addCart(id) {
  const p = S.products.find((x) => x.id === id);
  if (!p) return;
  const c = cart.find((x) => x.id === id);
  if ((c ? c.q : 0) + 1 > p.qty) { toast('Only ' + p.qty + ' of ' + p.name + ' in stock.'); return; }
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
  const cogs = items.reduce((a, it) => a + it.q * (it.cost || 0), 0);
  let pay = null, cashPart = 0, mpesaPart = 0;

  if (meth === 'mpesa' || meth === 'split') {
    const code = ((document.getElementById('code') || {}).value || '').trim().toUpperCase();
    if (!codeOk(code)) { toast('Enter a valid ' + mm() + ' transaction code.'); return; }
    if (S.pays.some((p) => p.code === code)) { toast('Code already used.'); return; }
    const fromSms = parsedSms && parsedSms.code === code && parsedSms.amountMinor != null;
    let conf = fromSms ? 'attested' : 'unconfirmed', note = '';
    const expected = meth === 'split' ? cents((document.getElementById('split-mpesa') || {}).value) : total;
    if (fromSms && parsedSms.amountMinor !== expected) { conf = 'flagged'; note = 'Message ' + kes(parsedSms.amountMinor) + ' ≠ expected ' + kes(expected || total); }
    pay = { code, amt: expected || total, conf, note, src: fromSms ? 'pasted_sms' : 'manual', pv: fromSms ? parsedSms.version : null, ts: Date.now() };
    mpesaPart = pay.amt;
  }
  if (meth === 'split') {
    cashPart = cents((document.getElementById('split-cash') || {}).value);
    if (isNaN(cashPart) || cashPart < 0) { toast('Enter cash portion.'); return; }
    if (cashPart + mpesaPart !== total) { toast('Cash + M-Pesa must equal ' + kes(total)); return; }
  }
  if (meth === 'cash') cashPart = total;
  if (meth === 'credit') {
    const name = ((document.getElementById('cust-name') || {}).value || '').trim();
    if (!name) { toast('Enter customer name.'); return; }
    let cust = S.customers.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!cust) { cust = { id: uid(), name, balance: 0 }; S.customers.push(cust); }
    cust.balance = (cust.balance || 0) + total;
  }
  try {
    const sid = S.n;
    const lines = [];
    if (meth === 'credit') { lines.push({ a: 'ar', dr: total, cr: 0 }, { a: 'sales', dr: 0, cr: total }); }
    else if (meth === 'split') {
      if (cashPart) lines.push({ a: 'cash', dr: cashPart, cr: 0 });
      if (mpesaPart) lines.push({ a: 'clr', dr: mpesaPart, cr: 0 });
      lines.push({ a: 'sales', dr: 0, cr: total });
    } else if (meth === 'mpesa') lines.push({ a: 'clr', dr: total, cr: 0 }, { a: 'sales', dr: 0, cr: total });
    else lines.push({ a: 'cash', dr: total, cr: 0 }, { a: 'sales', dr: 0, cr: total });
    post('Sale #' + sid + (pay ? ' (M-Pesa ' + pay.code + ')' : meth === 'credit' ? ' (credit)' : ' (cash)'), lines);
    if (cogs > 0) post('Cost of sale #' + sid, [{ a: 'cogs', dr: cogs, cr: 0 }, { a: 'inv', dr: 0, cr: cogs }]);
    items.forEach((it) => { if (!it.custom) { const p = S.products.find((x) => x.id === it.id); if (p) p.qty -= it.q; } });
    const sale = { id: sid, ts: Date.now(), total, method: meth, items, discount: discAmt, refunded: false };
    S.sales.push(sale);
    if (pay) { pay.sale = sid; S.pays.push(pay); matchCode(pay.code); }
    logActivity('sale', '#' + sid + ' ' + kes(total));
    if (!online) enqueue({ type: 'sale', saleId: sid });
    cart = []; parsedSms = null; discountPct = 0; customAmt = '';
    save(); toast('Sale recorded.'); showReceipt(sale, pay); checkNotifs();
  } catch (err) { toast(err.message || 'Could not record sale.'); }
}

function refundSale(saleId) {
  if (!can('reverse')) return;
  const sale = S.sales.find((s) => s.id === saleId);
  if (!sale || sale.refunded) { toast('Cannot refund.'); return; }
  const reason = prompt('Reason for refund (required):');
  if (reason === null) return;
  if (!reason.trim()) { toast('Reason required.'); return; }
  try {
    // Find sale journal entries by memo pattern and reverse
    const saleEntries = S.entries.filter((e) => !e.reversed && !e.isRev && e.memo && e.memo.indexOf('Sale #' + saleId) === 0);
    const cogsEntries = S.entries.filter((e) => !e.reversed && !e.isRev && e.memo && e.memo.indexOf('Cost of sale #' + saleId) === 0);
    [...saleEntries, ...cogsEntries].forEach((e) => {
      const r = post('Reversal of #' + e.id + ': ' + reason.trim(), e.lines.map((l) => ({ a: l.a, dr: l.cr, cr: l.dr })), e.ref);
      r.isRev = true; r.reverses = e.id; e.reversed = true;
    });
    // Restock
    (sale.items || []).forEach((it) => {
      if (it.custom) return;
      const p = S.products.find((x) => x.id === it.id);
      if (p) p.qty += it.q;
    });
    // Credit customer balance if credit sale
    if (sale.method === 'credit') {
      // reduce AR was already reversed via journal
    }
    sale.refunded = true;
    logActivity('refund', '#' + saleId + ' ' + reason.trim());
    save(); toast('Sale refunded.'); render();
  } catch (err) { toast(err.message); }
}

function showReceipt(sale, pay) {
  const items = (sale.items || []).map((it) => (it.name || 'Item') + ' x' + it.q + '  ' + kes(it.q * it.price)).join('\n');
  const text = S.settings.businessName + '\nSale #' + sale.id + '\n' + fmtDate(sale.ts) + '\n----------------\n' + items +
    (sale.discount ? '\nDiscount  -' + kes(sale.discount) : '') + '\nTOTAL  ' + kes(sale.total) + '\n' + sale.method.toUpperCase() +
    (pay ? '\nM-Pesa ' + pay.code + ' (' + pay.conf + ')' : '') + '\n----------------\nThank you';
  modal = { type: 'receipt', text }; renderOverlays();
}

async function startScan() {
  const status = document.getElementById('scan-status');
  const video = document.getElementById('scan-video');
  if (!window.BarcodeDetector) { if (status) status.textContent = 'BarcodeDetector not supported. Type the code.'; return; }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = scanStream; video.style.display = 'block'; await video.play();
    if (status) status.textContent = 'Scanning…';
    const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'qr_code', 'upc_a'] });
    const tick = async () => {
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          const raw = codes[0].rawValue; stopScan();
          const p = S.products.find((x) => x.barcode === raw);
          if (p) { addCart(p.id); toast('Added ' + p.name); } else toast('No product for ' + raw);
        }
      } catch (e) {}
      if (scanStream) scanTimer = requestAnimationFrame(tick);
    };
    scanTimer = requestAnimationFrame(tick);
  } catch (e) { if (status) status.textContent = 'Camera unavailable.'; }
}
function stopScan() {
  if (scanTimer) cancelAnimationFrame(scanTimer); scanTimer = null;
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  const video = document.getElementById('scan-video');
  if (video) { video.srcObject = null; video.style.display = 'none'; }
}

function openCmd() { cmdOpen = true; renderOverlays(); setTimeout(() => document.getElementById('cmd-input')?.focus(), 40); }
function closeCmd() { cmdOpen = false; renderOverlays(); }
function closeModal() { modal = null; renderOverlays(); }

function cmdResults(q) {
  q = (q || '').toLowerCase().trim();
  const items = [];
  TABS.forEach((t) => { if (!q || t.label.toLowerCase().includes(q)) items.push({ label: 'Go to ' + t.label, action: 'tab', arg: t.id, meta: 'Page' }); });
  if (!q || 'ai'.includes(q) || 'ask'.includes(q)) items.push({ label: 'Ask AI about the business', action: 'tab', arg: 'ai', meta: 'AI' });
  S.products.forEach((p) => {
    if (!q || p.name.toLowerCase().includes(q) || (p.barcode && p.barcode.includes(q)))
      items.push({ label: p.name + ' — ' + kes(p.price), action: 'product', arg: p.id, meta: 'Product' });
  });
  S.sales.slice(-15).reverse().forEach((s) => {
    if (!q || String(s.id).includes(q)) items.push({ label: 'Sale #' + s.id + ' · ' + kes(s.total), action: 'sale', arg: String(s.id), meta: 'Sale' });
  });
  S.customers.forEach((c) => {
    if (!q || c.name.toLowerCase().includes(q)) items.push({ label: c.name + ((c.balance || 0) ? ' · owes ' + kes(c.balance) : ''), action: 'tab', arg: 'customers', meta: 'Customer' });
  });
  return items.slice(0, 14);
}

function renderOverlays() {
  const root = document.getElementById('overlays');
  if (!root) return;
  let html = '';
  if (cmdOpen) {
    html += '<div class="overlay" id="cmd-overlay" role="dialog" aria-label="Command menu"><div class="cmd">' +
      '<input id="cmd-input" type="search" placeholder="Search products, sales, pages, or type a question…" autocomplete="off">' +
      '<div class="cmd-list" id="cmd-list"></div></div></div>';
  }
  if (modal?.type === 'receipt') {
    html += '<div class="modal-backdrop" role="dialog"><div class="modal"><h2>Receipt</h2><div class="receipt">' + esc(modal.text) + '</div>' +
      '<div class="modal-actions"><button type="button" class="btn btn-primary" data-sharereceipt="1">Share</button>' +
      '<button type="button" class="btn btn-secondary" data-printreceipt="1">Print</button>' +
      '<button type="button" class="btn btn-ghost" data-closemodal="1">Close</button></div>' +
      '<p class="muted" style="font-size:0.8rem;margin-top:8px">Uses your device share sheet or clipboard. No third-party API connected.</p></div></div>';
  }
  if (modal?.type === 'install') {
    html += '<div class="modal-backdrop" role="dialog"><div class="modal"><h2>Install MarginPilot</h2>' +
      (isIOS() ? '<ol><li>Open this page in <strong>Safari</strong>.</li><li>Tap the <strong>Share</strong> button.</li><li>Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li></ol>'
        : '<ol><li>Open the browser menu (⋮ or ⋯).</li><li>Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li><li>On desktop Chrome or Edge, use the install icon in the address bar.</li></ol>') +
      '<p class="muted">The app must be opened from a secure (https) address to install.</p><div class="modal-actions"><button type="button" class="btn btn-primary" data-closemodal="1">Got it</button></div></div></div>';
  }
  root.innerHTML = html;
  if (cmdOpen) {
    const list = document.getElementById('cmd-list');
    const fill = (q) => {
      const isQuestion = q.trim().length > 12 && /\s/.test(q);
      list.innerHTML = (isQuestion ? '<button type="button" class="cmd-item" aria-selected="true" data-cmd="aiask|' + esc(q) + '">Ask AI: “' + esc(q.slice(0, 60)) + '”</button>' : '') +
        cmdResults(q).map((it, i) => '<button type="button" class="cmd-item" aria-selected="' + (!isQuestion && i === 0) + '" data-cmd="' + it.action + '|' + esc(it.arg) + '">' + esc(it.label) + '<span class="cmd-meta">' + esc(it.meta || '') + '</span></button>').join('') ||
        '<div class="cmd-item" style="color:var(--mu)">No matches</div>';
    };
    fill('');
    document.getElementById('cmd-input').addEventListener('input', (e) => fill(e.target.value));
    document.getElementById('cmd-input').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeCmd();
      if (e.key === 'Enter') document.querySelector('.cmd-item[aria-selected="true"]')?.click();
    });
    document.getElementById('cmd-overlay').addEventListener('click', (e) => { if (e.target.id === 'cmd-overlay') closeCmd(); });
  }
}

function render() {
  const side = document.getElementById('side-nav');
  if (side) {
    const main = TABS.filter((t) => t.section === 'main' || t.id === 'customers' || t.id === 'reports' || t.id === 'ai');
    side.innerHTML = '<div class="nav-section">Menu</div>' + main.map((t) =>
      '<button type="button" ' + (tab === t.id ? 'aria-current="page"' : '') + ' data-tab="' + t.id + '">' + iconSvg(t.icon) + ' <span>' + t.label + '</span></button>'
    ).join('');
  }
  const bot = document.getElementById('bottom-nav');
  if (bot) {
    bot.innerHTML = MOBILE_TABS.map((id) => {
      const t = TABS.find((x) => x.id === id);
      return '<button type="button" ' + (tab === id || (id === 'more' && !MOBILE_TABS.includes(tab)) ? 'aria-current="page"' : '') + ' data-tab="' + id + '" aria-label="' + t.label + '">' + iconSvg(t.icon) + '<span>' + t.label + '</span></button>';
    }).join('');
  }
  const fab = document.getElementById('fab-sale');
  if (fab) fab.hidden = tab === 'sell' || !can('sell');
  const alerts = buildAlerts();
  const dot = document.getElementById('alert-dot');
  if (dot) dot.hidden = !alerts.length;

  const main = document.getElementById('main');
  if (!main) return;
  const views = { home: viewHome, sell: viewSell, stock: viewStock, money: viewMoney, customers: viewCustomers, reports: viewReports, ai: viewAI, alerts: viewAlerts, more: viewMore };
  main.innerHTML = (views[tab] || viewHome)();
  updateOnline();
  renderOverlays();
  bindMain(main);
}

function bindMain(main) {
  main.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => { period = b.getAttribute('data-period'); render(); }));
  main.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => setTab(b.getAttribute('data-goto'))));
  main.querySelectorAll('[data-moneysub]').forEach((b) => b.addEventListener('click', () => { moneySub = b.getAttribute('data-moneysub'); render(); }));
  main.querySelectorAll('[data-sellmode]').forEach((b) => b.addEventListener('click', () => { sellMode = b.getAttribute('data-sellmode'); render(); }));
  main.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => addCart(b.getAttribute('data-add'))));
  main.querySelectorAll('[data-qty]').forEach((b) => b.addEventListener('click', () => {
    const [id, d] = b.getAttribute('data-qty').split('|');
    const c = cart.find((x) => x.id === id); if (!c) return;
    const p = S.products.find((x) => x.id === id);
    const delta = parseInt(d, 10);
    if (delta > 0 && p && c.q + delta > p.qty) { toast('Not enough stock.'); return; }
    c.q += delta; if (c.q <= 0) cart = cart.filter((x) => x.id !== id); render();
  }));
  main.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => {
    const k = b.getAttribute('data-key');
    if (k === '⌫') customAmt = customAmt.slice(0, -1);
    else if (k === '.' && customAmt.includes('.')) return;
    else customAmt += k;
    render();
  }));
  main.querySelector('[data-addcustom]')?.addEventListener('click', () => {
    const amt = cents(customAmt);
    if (!amt || amt <= 0) { toast('Enter an amount.'); return; }
    cart.push({ id: 'custom-' + uid(), q: 1, custom: true, name: 'Custom amount', price: amt, cost: 0 });
    customAmt = ''; sellMode = 'products'; render();
  });
  const disc = document.getElementById('disc');
  if (disc) disc.addEventListener('change', () => { discountPct = Math.min(100, Math.max(0, parseFloat(disc.value) || 0)); render(); });
  document.getElementById('meth')?.addEventListener('change', () => render());
  main.querySelector('[data-readsms]')?.addEventListener('click', () => {
    const t = document.getElementById('sms')?.value || '';
    parsedSms = parseSms(t); parsedSms.raw = t;
    toast(parsedSms.ok ? 'Message read. Review before saving.' : 'Could not read fully.');
    render();
  });
  main.querySelector('[data-completesale]')?.addEventListener('click', completeSale);
  main.querySelector('[data-clearcart]')?.addEventListener('click', () => { cart = []; parsedSms = null; discountPct = 0; customAmt = ''; render(); });
  main.querySelector('[data-addproduct]')?.addEventListener('click', () => {
    if (!can('stock')) return;
    const name = document.getElementById('pn')?.value.trim();
    const price = cents(document.getElementById('pp')?.value);
    const cost = cents(document.getElementById('pc')?.value);
    const q = parseInt(document.getElementById('pq')?.value || '0', 10);
    const barcode = document.getElementById('pb')?.value.trim() || null;
    if (!name || isNaN(price) || isNaN(cost) || q < 0 || isNaN(q)) { toast('Enter name, prices and quantity.'); return; }
    const id = 'p' + Date.now();
    S.products.push({ id, name, price, cost, qty: q, barcode });
    if (q > 0) { try { post('Opening stock: ' + name, [{ a: 'inv', dr: q * cost, cr: 0 }, { a: 'eq', dr: 0, cr: q * cost }]); } catch (e) { toast(e.message); return; } }
    logActivity('add_product', name); save(); toast('Product added.'); render();
  });
  main.querySelectorAll('[data-adjust]').forEach((b) => b.addEventListener('click', () => {
    const p = S.products.find((x) => x.id === b.getAttribute('data-adjust'));
    if (!p) return;
    const raw = prompt('New quantity for ' + p.name + ' (currently ' + p.qty + '):', String(p.qty));
    if (raw === null) return;
    const nq = parseInt(raw, 10);
    if (isNaN(nq) || nq < 0) { toast('Invalid quantity.'); return; }
    const diff = nq - p.qty;
    if (diff === 0) return;
    try {
      if (diff > 0) post('Stock increase: ' + p.name, [{ a: 'inv', dr: diff * p.cost, cr: 0 }, { a: 'eq', dr: 0, cr: diff * p.cost }]);
      else post('Stock decrease: ' + p.name, [{ a: 'exp', dr: (-diff) * p.cost, cr: 0 }, { a: 'inv', dr: 0, cr: (-diff) * p.cost }]);
      p.qty = nq; logActivity('stock_adjust', p.name + ' → ' + nq); save(); toast('Stock updated.'); render();
    } catch (e) { toast(e.message); }
  }));
  main.querySelector('[data-importstmt]')?.addEventListener('click', importStatement);
  main.querySelector('[data-addexpense]')?.addEventListener('click', () => {
    if (!can('ledger')) return;
    const d = document.getElementById('ed')?.value.trim();
    const a = cents(document.getElementById('ea')?.value);
    if (!d || isNaN(a) || a <= 0) { toast('Enter description and amount.'); return; }
    try { post('Expense: ' + d, [{ a: 'exp', dr: a, cr: 0 }, { a: 'cash', dr: 0, cr: a }]); logActivity('expense', d); save(); toast('Expense saved.'); render(); }
    catch (e) { toast(e.message); }
  });
  main.querySelectorAll('[data-reverse]').forEach((b) => b.addEventListener('click', () => {
    const reason = prompt('Reason for reversal (required):');
    if (reason === null || !reason.trim()) { if (reason !== null) toast('Reason required.'); return; }
    reverseEntry(parseInt(b.getAttribute('data-reverse'), 10), reason.trim());
  }));
  main.querySelectorAll('[data-refund]').forEach((b) => b.addEventListener('click', () => refundSale(parseInt(b.getAttribute('data-refund'), 10))));
  main.querySelector('[data-dolock]')?.addEventListener('click', () => {
    if (!can('lock')) return;
    const d = document.getElementById('lock-date')?.value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { toast('Use YYYY-MM-DD.'); return; }
    if (S.lockedThrough && d < S.lockedThrough) {
      const reason = prompt('Reason to move lock back:');
      const approver = prompt('Approver name:');
      if (!reason || !approver) { toast('Need reason and approver.'); return; }
      logActivity('reopen', d + ' ' + reason + ' by ' + approver);
    } else logActivity('lock', d);
    S.lockedThrough = d; save(); toast('Locked through ' + d); render();
  });
  main.querySelectorAll('[data-setprice]').forEach((b) => b.addEventListener('click', () => {
    if (!can('plans')) return;
    const k = b.getAttribute('data-setprice');
    const v = cents(document.getElementById('pl' + k)?.value);
    if (isNaN(v) || v < 0) return;
    S.plans[k] = v; save(); toast('Price saved.'); render();
  }));
  main.querySelector('[data-runsim]')?.addEventListener('click', () => {
    const p = S.products.find((x) => x.id === document.getElementById('sim-prod')?.value);
    const out = document.getElementById('sim-out');
    if (!p || !out) return;
    const price = cents(document.getElementById('sim-price')?.value); const cost = cents(document.getElementById('sim-cost')?.value);
    const np = isNaN(price) ? p.price : price, nc = isNaN(cost) ? p.cost : cost;
    const oldM = p.price ? Math.round((p.price - p.cost) / p.price * 100) : 0;
    const newM = np ? Math.round((np - nc) / np * 100) : 0;
    out.innerHTML = '<div class="help-panel"><strong>Simulation only</strong><br>' + esc(p.name) + ': margin ' + oldM + '% → ' + newM + '%.<br>Profit/unit ' + kes(p.price - p.cost) + ' → ' + kes(np - nc) + '.</div>';
  });
  main.querySelector('[data-addcust]')?.addEventListener('click', () => {
    const name = document.getElementById('new-cust')?.value.trim();
    if (!name) { toast('Enter a name.'); return; }
    if (S.customers.some((c) => c.name.toLowerCase() === name.toLowerCase())) { toast('Already exists.'); return; }
    S.customers.push({ id: uid(), name, phone: document.getElementById('new-cust-phone')?.value.trim() || '', balance: 0 });
    save(); toast('Customer added.'); render();
  });
  main.querySelectorAll('[data-paycredit]').forEach((b) => b.addEventListener('click', () => {
    const c = S.customers.find((x) => x.id === b.getAttribute('data-paycredit'));
    if (!c || !(c.balance > 0)) return;
    const raw = prompt('Payment amount (' + CC() + ') from ' + c.name + ' (owes ' + (c.balance / 100).toFixed(2) + '):');
    if (raw === null) return;
    const amt = cents(raw);
    if (isNaN(amt) || amt <= 0 || amt > c.balance) { toast('Invalid amount.'); return; }
    try {
      post('Credit payment: ' + c.name, [{ a: 'cash', dr: amt, cr: 0 }, { a: 'ar', dr: 0, cr: amt }]);
      c.balance -= amt; logActivity('credit_payment', c.name + ' ' + kes(amt)); save(); toast('Payment recorded.'); render();
    } catch (e) { toast(e.message); }
  }));
  // AI
  main.querySelectorAll('[data-aiq]').forEach((b) => b.addEventListener('click', () => runAI(b.getAttribute('data-aiq'))));
  main.querySelector('[data-aisend]')?.addEventListener('click', () => {
    const q = document.getElementById('ai-input')?.value.trim();
    if (q) runAI(q);
  });
  document.getElementById('ai-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const q = e.target.value.trim(); if (q) runAI(q); }
  });
  main.querySelector('[data-savekey]')?.addEventListener('click', () => {
    const key = document.getElementById('ai-key')?.value.trim();
    const prov = document.getElementById('ai-provider')?.value || 'xai';
    if (!key) { toast('Paste an API key.'); return; }
    localStorage.setItem(AI_KEY, key);
    localStorage.setItem(AI_PROVIDER, prov);
    toast('API key saved on this device.'); render();
  });
  main.querySelector('[data-clearkey]')?.addEventListener('click', () => {
    localStorage.removeItem(AI_KEY); toast('Key removed.'); render();
  });
  main.querySelector('[data-scanstart]')?.addEventListener('click', startScan);
  main.querySelector('[data-scanstop]')?.addEventListener('click', stopScan);
  main.querySelector('[data-manualbar]')?.addEventListener('click', () => {
    const raw = document.getElementById('barcode-manual')?.value.trim();
    if (!raw) return;
    const p = S.products.find((x) => x.barcode === raw || x.id === raw);
    if (p) { addCart(p.id); toast('Added ' + p.name); } else toast('No match.');
  });
  if (sellMode === 'scan') {
    const status = document.getElementById('scan-status');
    if (status) status.textContent = window.BarcodeDetector ? 'Ready. Tap Start camera.' : 'Type the barcode — camera API not supported here.';
  }
  document.getElementById('role-sel')?.addEventListener('change', (e) => { localStorage.setItem(ROLE_KEY, e.target.value); logActivity('role_switch', e.target.value); render(); });
  document.getElementById('biz-name')?.addEventListener('change', (e) => { S.settings.businessName = e.target.value; save(); });
  document.getElementById('biz-till')?.addEventListener('change', (e) => { S.settings.till = e.target.value; save(); });
  document.getElementById('biz-paybill')?.addEventListener('change', (e) => { S.settings.paybill = e.target.value; save(); });
  document.getElementById('cur-sel')?.addEventListener('change', (e) => { S.settings.currency = e.target.value; logActivity('currency', e.target.value); save(); toast('Currency set to ' + e.target.value + '.'); render(); });
  ['TZS', 'UGX'].forEach((k) => document.getElementById('rate-' + k)?.addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (v > 0) { S.settings.rates = Object.assign({}, S.settings.rates, { [k]: v }); save(); toast('Rate saved.'); }
  }));
  main.querySelector('[data-convert]')?.addEventListener('click', () => {
    const a = parseFloat(String(document.getElementById('cv-amt')?.value || '').replace(/,/g, ''));
    const f = document.getElementById('cv-from')?.value, t = document.getElementById('cv-to')?.value, r = getRates();
    if (!(a >= 0) || !f || !t) { toast('Enter an amount.'); return; }
    document.getElementById('cv-out').innerHTML = '<div class="help-panel"><strong>' + fmtIn(f, Math.round(a * 100)) + ' ≈ ' + fmtIn(t, Math.round(a / r[f] * r[t] * 100)) + '</strong>Using your saved rates. Check today’s market rate before pricing.</div>';
  });
  main.querySelectorAll('[data-install]').forEach((b) => b.addEventListener('click', doInstall));
  main.querySelector('[data-dismissinstall]')?.addEventListener('click', () => { localStorage.setItem('marginpilot.installDismissed', '1'); render(); });
  main.querySelector('[data-notif-enable]')?.addEventListener('click', enableNotifs);
  main.querySelector('[data-notif-test]')?.addEventListener('click', () => notify('MarginPilot test', 'Notifications are working on this device.', 'test', 'home'));
  main.querySelectorAll('[data-ntoggle]').forEach((c) => c.addEventListener('change', () => {
    const p = nprefs(); const k = c.getAttribute('data-ntoggle');
    if (k === 'off') p.on = false; else p[k] = c.checked;
    nsave(p); render(); checkNotifs();
  }));
  document.getElementById('n-hour')?.addEventListener('change', (e) => { const p = nprefs(); p.hour = parseInt(e.target.value, 10); nsave(p); });
}

async function runAI(question) {
  if (aiBusy) return;
  aiBusy = true;
  S.aiChat.push({ role: 'user', text: question });
  if (S.aiChat.length > 40) S.aiChat = S.aiChat.slice(-40);
  save(); render();
  const ans = await askAI(question);
  S.aiChat.push({ role: 'ai', text: ans.text, cite: ans.cite });
  aiBusy = false; save(); render();
  const chat = document.getElementById('ai-chat');
  if (chat) chat.scrollTop = chat.scrollHeight;
}

document.getElementById('overlays').addEventListener('click', (e) => {
  const t = e.target.closest('[data-cmd],[data-sharereceipt],[data-printreceipt],[data-closemodal]');
  if (!t) return;
  if (t.hasAttribute('data-cmd')) {
    const [action, arg] = t.getAttribute('data-cmd').split('|');
    closeCmd();
    if (action === 'tab') setTab(arg);
    else if (action === 'product') { setTab('sell'); addCart(arg); }
    else if (action === 'sale') { moneySub = 'sales'; setTab('money'); }
    else if (action === 'aiask') { setTab('ai'); setTimeout(() => runAI(arg), 100); }
  }
  if (t.hasAttribute('data-sharereceipt') && modal?.type === 'receipt') {
    const text = modal.text;
    if (navigator.share) navigator.share({ text }).catch(() => navigator.clipboard?.writeText(text).then(() => toast('Copied.')));
    else navigator.clipboard?.writeText(text).then(() => toast('Copied. Paste into WhatsApp or SMS.'));
  }
  if (t.hasAttribute('data-printreceipt') && modal?.type === 'receipt') {
    const w = window.open('', '_blank');
    w.document.write('<pre style="font:14px monospace;padding:24px">' + esc(modal.text) + '</pre>');
    w.document.close(); w.print();
  }
  if (t.hasAttribute('data-closemodal')) closeModal();
});

document.getElementById('fab-sale').addEventListener('click', () => setTab('sell'));
document.getElementById('theme-btn').addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
document.getElementById('side-theme').addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
document.getElementById('side-ai').addEventListener('click', () => setTab('ai'));
document.getElementById('search-open').addEventListener('click', openCmd);
document.getElementById('side-cmd').addEventListener('click', openCmd);
document.getElementById('alerts-btn').addEventListener('click', () => setTab('alerts'));
document.getElementById('side-nav').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.getAttribute('data-tab')); });
document.getElementById('bottom-nav').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.getAttribute('data-tab')); });
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmd(); }
  if (e.key === 'Escape') { closeCmd(); closeModal(); }
});

/* ===== Currency card ===== */
function currencyCard() {
  const opts = (sel) => Object.keys(CURRENCIES).map((k, i) => '<option value="' + k + '"' + (sel === k ? ' selected' : '') + '>' + k + '</option>').join('');
  const r = getRates();
  return '<div class="card"><h3>Country & currency</h3><label class="field"><span>Business country</span><select id="cur-sel">' +
    Object.entries(CURRENCIES).map(([k, v]) => '<option value="' + k + '"' + (k === CC() ? ' selected' : '') + '>' + v.country + ' · ' + k + ' (' + v.sym + ')</option>').join('') + '</select></label>' +
    '<p class="lock-note">Mobile money: ' + esc(cur().mmFull) + ' · phone code ' + cur().dial + '. Changing country changes how amounts are shown; existing amounts are not converted.</p>' +
    '<h3 style="margin-top:14px">Currency converter</h3><div class="grid"><label class="field"><span>Amount</span><input id="cv-amt" inputmode="decimal"></label>' +
    '<label class="field"><span>From</span><select id="cv-from">' + opts(CC()) + '</select></label>' +
    '<label class="field"><span>To</span><select id="cv-to">' + opts(CC() === 'KES' ? 'TZS' : 'KES') + '</select></label></div>' +
    '<button type="button" class="btn btn-secondary" data-convert="1">Convert</button><div id="cv-out"></div>' +
    '<p class="lock-note">Your rates per 1 KES (edit to today’s rate):</p><div class="grid">' +
    '<label class="field"><span>TZS</span><input id="rate-TZS" inputmode="decimal" value="' + r.TZS + '"></label>' +
    '<label class="field"><span>UGX</span><input id="rate-UGX" inputmode="decimal" value="' + r.UGX + '"></label></div></div>';
}

/* ===== Install ===== */
let deferredInstall = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; render(); });
addEventListener('appinstalled', () => { deferredInstall = null; toast('MarginPilot installed.'); render(); });
function installBanner() {
  if (isStandalone() || localStorage.getItem('marginpilot.installDismissed')) return '';
  return '<div class="card gold"><div class="card-head"><h3>Install MarginPilot</h3></div><p class="muted" style="margin:0 0 10px">Add it to your home screen: opens full-screen, works offline and can send reminders.</p>' +
    '<div style="display:flex;gap:8px"><button type="button" class="btn btn-primary btn-sm" data-install="1">Install app</button><button type="button" class="btn btn-ghost btn-sm" data-dismissinstall="1">Not now</button></div></div>';
}
async function doInstall() {
  if (deferredInstall) { deferredInstall.prompt(); try { await deferredInstall.userChoice; } catch (e) {} deferredInstall = null; render(); return; }
  modal = { type: 'install' }; renderOverlays();
}

/* ===== Notifications (local; no server) ===== */
const NK = 'marginpilot.notif';
function nprefs() {
  const d = { on: false, low: true, owed: true, unver: true, daily: true, hour: 18, seen: {} };
  try { return Object.assign(d, JSON.parse(localStorage.getItem(NK) || '{}')); } catch (e) { return d; }
}
function nsave(p) { try { localStorage.setItem(NK, JSON.stringify(p)); } catch (e) {} }
async function notify(title, body, tag, tabId) {
  const o = { body, tag, icon: 'icon-192.png', badge: 'icon-192.png', data: { tab: tabId } };
  try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) { await reg.showNotification(title, o); return; } } catch (e) {}
  try { new Notification(title, o); } catch (e) {}
}
async function enableNotifs() {
  if (!('Notification' in window)) { toast('Notifications are not supported here.'); return; }
  let r; try { r = await Notification.requestPermission(); } catch (e) { r = 'denied'; }
  const p = nprefs(); p.on = r === 'granted'; nsave(p);
  toast(p.on ? 'Notifications on.' : 'Notifications not allowed.');
  if (p.on) notify('MarginPilot', 'Notifications are on: low stock, credit and daily summary reminders.', 'welcome', 'home');
  render();
}
function checkNotifs() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const p = nprefs(); if (!p.on) return;
  const day = todayISO(), fresh = (k) => { if (p.seen[k]) return false; p.seen[k] = 1; return true; };
  const low = S.products.filter((x) => x.qty <= 2);
  if (p.low && low.length && fresh('low-' + day + '-' + low.map((x) => x.id + ':' + x.qty).join(',')))
    notify('Low stock', low.slice(0, 4).map((x) => x.name + ' (' + x.qty + ')').join(', ') + (low.length > 4 ? ' +' + (low.length - 4) + ' more' : ''), 'low', 'stock');
  if (p.owed && S.customers.some((c) => (c.balance || 0) > 0) && fresh('owed-' + day))
    notify('Customers owe you ' + kes(bal('ar')), 'Follow up on unpaid credit sales.', 'owed', 'customers');
  const unv = S.pays.filter((x) => x.conf !== 'verified' && Date.now() - x.ts > 864e5);
  if (p.unver && unv.length && fresh('unver-' + day))
    notify(unv.length + ' unverified payment(s)', 'Import your statement in Money to match them.', 'unver', 'money');
  if (p.daily && new Date().getHours() >= p.hour && fresh('daily-' + day)) {
    const t = profitInPeriod('today');
    notify('Today’s summary', salesInPeriod('today').length + ' sale(s), ' + kes(t.netRev) + ' sales, ' + kes(t.profit) + ' gross profit.', 'daily', 'home');
  }
  Object.keys(p.seen).forEach((k) => { if (k.indexOf(day) === -1) delete p.seen[k]; });
  nsave(p);
}
function notifCard() {
  const p = nprefs(), sup = 'Notification' in window, perm = sup ? Notification.permission : 'unsupported';
  const tg = (k, label) => '<label class="row"><span>' + label + '</span><input type="checkbox" data-ntoggle="' + k + '"' + (p[k] ? ' checked' : '') + '></label>';
  let body;
  if (!sup) body = '<p class="muted">This browser does not support notifications. On iPhone or iPad, install the app to your Home Screen first (iOS 16.4+).</p>';
  else if (perm === 'denied') body = '<p class="bad">Blocked in browser settings. Allow notifications for this site, then reload.</p>';
  else if (p.on && perm === 'granted') body = tg('low', 'Low stock') + tg('owed', 'Unpaid credit') + tg('unver', 'Unverified payments') + tg('daily', 'Daily summary') +
    '<label class="field" style="margin-top:8px"><span>Daily summary after</span><select id="n-hour">' + [16, 17, 18, 19, 20, 21].map((h) => '<option value="' + h + '"' + (p.hour === h ? ' selected' : '') + '>' + h + ':00</option>').join('') + '</select></label>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn btn-secondary btn-sm" data-notif-test="1">Send test</button><button type="button" class="btn btn-ghost btn-sm" data-ntoggle="off">Turn off</button></div>';
  else body = '<p class="muted">Get reminders for low stock, unpaid credit, unmatched payments and an end-of-day summary.</p><button type="button" class="btn btn-primary" data-notif-enable="1">Turn on notifications</button>';
  return '<div class="card"><h3>Notifications</h3>' + body + '<p class="lock-note">Reminders appear while the app is open or recently used. Alerts when the app is fully closed need a push server, which is not built yet.</p></div>';
}
setInterval(checkNotifs, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkNotifs(); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.tab) setTab(e.data.tab); });
}
const qTab = new URLSearchParams(location.search).get('tab');
if (qTab && TABS.some((t) => t.id === qTab)) tab = qTab;
render();
setTimeout(checkNotifs, 2500);
})();
