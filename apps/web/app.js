(function () {
'use strict';

const KEY = 'marginpilot.v1';
const THEME_KEY = 'marginpilot.theme';
const ROLE_KEY = 'marginpilot.role';
const AI_KEY = 'marginpilot.aiKey';
const AI_PROVIDER = 'marginpilot.aiProvider';
const CLOUD_TOKEN_KEY = 'marginpilot.cloudToken';
const CLOUD_META_KEY = 'marginpilot.cloudMeta';
const CLOUD_REV_KEY = 'marginpilot.cloudRev';

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

let homePeriod = 'today';
let reportPeriod = 'month';
let S = {
  products: [], entries: [], sales: [], pays: [], confs: [],
  customers: [], suppliers: [], purchases: [], recurring: [],
  activity: [], plans: { small: 10000, big: 25000 },
  n: 1, offlineQueue: [], lockedThrough: null,
  settings: { businessName: 'My business', till: '', paybill: '', currency: 'KES', displayCurrency: null },
  aiChat: [], audit: []
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
    if (!S.suppliers) S.suppliers = [];
    if (!S.purchases) S.purchases = [];
    if (!S.recurring) S.recurring = [];
    if (!S.audit) S.audit = [];
    if (S.settings && !S.settings.displayCurrency) S.settings.displayCurrency = S.settings.currency || 'KES';
  }
} catch (e) {}

function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
function logActivity(action, detail) {
  S.activity.unshift({ ts: Date.now(), role: currentRole(), action, detail: detail || '' });
  if (S.activity.length > 300) S.activity.length = 300;
  save();
}
function auditLog(action, detail, meta) {
  S.audit = S.audit || [];
  S.audit.unshift({ ts: Date.now(), role: currentRole(), user: (sessionUser() || {}).name || 'local', action, detail: detail || '', meta: meta || null });
  if (S.audit.length > 500) S.audit.length = 500;
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
  UGX: { country: 'Uganda', sym: 'USh', loc: 'en-UG', dec: 0, dial: '+256', mm: 'Mobile money', mmFull: 'MTN MoMo, Airtel Money' },
  USD: { country: 'United States', sym: '$', loc: 'en-US', dec: 2, dial: '+1', mm: 'Card/transfer', mmFull: 'Card or bank transfer' },
  EUR: { country: 'Eurozone', sym: '€', loc: 'en-IE', dec: 2, dial: '', mm: 'Card/transfer', mmFull: 'Card or bank transfer' },
  GBP: { country: 'United Kingdom', sym: '£', loc: 'en-GB', dec: 2, dial: '+44', mm: 'Card/transfer', mmFull: 'Card or bank transfer' }
};
// Rates are units of foreign currency per 1 KES (base reference). Historical transactions keep original amount + currency.
const DEFAULT_RATES = { KES: 1, TZS: 19.5, UGX: 28, USD: 0.0077, EUR: 0.0071, GBP: 0.0061 };
const RATE_META_KEY = 'marginpilot.ratesMeta';
const CC = () => (S.settings && CURRENCIES[S.settings.currency] ? S.settings.currency : 'KES');
const cur = () => CURRENCIES[CC()];
const fmtIn = (code, n) => { const c = CURRENCIES[code]; return c.sym + ' ' + (Number(n) / 100).toLocaleString(c.loc, { minimumFractionDigits: c.dec, maximumFractionDigits: c.dec }); };
const kes = (n) => fmtIn(CC(), n);
const mm = () => cur().mm;
const codeOk = (c) => CC() === 'KES' ? /^[A-Z0-9]{10}$/.test(c) : /^[A-Z0-9]{6,16}$/.test(c);
const getRates = () => Object.assign({}, DEFAULT_RATES, (S.settings && S.settings.rates) || {});
function ratesMeta() {
  try { return JSON.parse(localStorage.getItem(RATE_META_KEY) || '{}'); } catch (e) { return {}; }
}
function setRatesMeta(m) { try { localStorage.setItem(RATE_META_KEY, JSON.stringify(m)); } catch (e) {} }
function convertAmount(amountMinor, fromCode, toCode) {
  if (fromCode === toCode) return amountMinor;
  const r = getRates();
  const from = r[fromCode] || 1, to = r[toCode] || 1;
  // amount is in fromCode minor units; convert via KES base
  const kesMajor = (amountMinor / 100) / from;
  return Math.round(kesMajor * to * 100);
}
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

/* ===== Advanced financial summary (Phase 2) ===== */
function entriesInPeriod(p) {
  const { start, end } = periodRange(p);
  return S.entries.filter((e) => {
    const ts = e.ts || (e.date ? Date.parse(e.date + 'T12:00:00') : 0);
    return ts >= start && ts <= end && !e.reversed && !e.isRev;
  });
}

function expensesInPeriod(p) {
  // Sum of expense account debits in the period (operating expenses, not COGS)
  let total = 0;
  entriesInPeriod(p).forEach((e) => {
    e.lines.forEach((l) => {
      if (l.a === 'exp') total += (l.dr || 0) - (l.cr || 0);
    });
  });
  return Math.max(0, total);
}

function inventoryValue() {
  // Current stock at cost (non-service products only)
  return S.products.reduce((sum, p) => {
    if (p.svc) return sum;
    const cost = Number.isFinite(p.cost) ? p.cost : 0;
    const qty = Number.isFinite(p.qty) ? p.qty : 0;
    return sum + Math.max(0, qty) * cost;
  }, 0);
}

function previousPeriodKey(p) {
  if (p === 'today') return 'yesterday';
  if (p === 'week') return 'prevweek';
  if (p === 'month') return 'prevmonth';
  return null;
}

function periodRangePrev(p) {
  const now = new Date();
  if (p === 'today') {
    const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 1);
    const end = new Date(start); end.setHours(23, 59, 59, 999);
    return { start: start.getTime(), end: end.getTime() };
  }
  if (p === 'week') {
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const day = start.getDay() || 7;
    start.setDate(start.getDate() - day + 1 - 7);
    const end = new Date(start); end.setDate(end.getDate() + 6); end.setHours(23, 59, 59, 999);
    return { start: start.getTime(), end: end.getTime() };
  }
  if (p === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { start: start.getTime(), end: end.getTime() };
  }
  return { start: 0, end: 0 };
}

function salesInPrevPeriod(p) {
  const { start, end } = periodRangePrev(p);
  return S.sales.filter((s) => s.ts >= start && s.ts <= end && !s.refunded);
}

function profitInPrevPeriod(p) {
  let rev = 0, cogs = 0, disc = 0;
  salesInPrevPeriod(p).forEach((s) => {
    rev += s.total + (s.discount || 0);
    disc += s.discount || 0;
    (s.items || []).forEach((it) => {
      const cost = it.cost != null ? it.cost : (S.products.find((x) => x.id === it.id)?.cost || 0);
      cogs += it.q * cost;
    });
  });
  return { rev, cogs, disc, profit: rev - disc - cogs, netRev: rev - disc };
}

function expensesInPrevPeriod(p) {
  const { start, end } = periodRangePrev(p);
  let total = 0;
  S.entries.filter((e) => {
    const ts = e.ts || (e.date ? Date.parse(e.date + 'T12:00:00') : 0);
    return ts >= start && ts <= end && !e.reversed && !e.isRev;
  }).forEach((e) => {
    e.lines.forEach((l) => {
      if (l.a === 'exp') total += (l.dr || 0) - (l.cr || 0);
    });
  });
  return Math.max(0, total);
}

function financialSummary(p) {
  const curP = profitInPeriod(p);
  const prevP = profitInPrevPeriod(p);
  const exp = expensesInPeriod(p);
  const prevExp = expensesInPrevPeriod(p);
  const netProfit = curP.profit - exp;
  const prevNet = prevP.profit - prevExp;
  const grossMargin = curP.netRev > 0 ? Math.round((curP.profit / curP.netRev) * 1000) / 10 : 0;
  const netMargin = curP.netRev > 0 ? Math.round((netProfit / curP.netRev) * 1000) / 10 : 0;
  const cash = bal('cash') + bal('till');
  const clearing = bal('clr');
  const ar = bal('ar');
  const invVal = inventoryValue();
  const salesCount = salesInPeriod(p).length;
  // Simple break-even: average daily fixed costs / contribution margin ratio
  // Contribution margin ≈ gross profit / net revenue
  // For simplicity we treat recorded operating expenses as period fixed costs
  let breakEven = null;
  if (curP.netRev > 0 && curP.profit > 0 && exp > 0) {
    const cmRatio = curP.profit / curP.netRev; // contribution margin ratio
    if (cmRatio > 0) {
      breakEven = Math.round(exp / cmRatio); // sales needed to cover these expenses
    }
  }
  // Health indicators (0-100 style signals)
  const health = [];
  if (grossMargin >= 30) health.push({ k: 'Gross margin', v: grossMargin + '%', s: 'ok', tip: 'Healthy product margin' });
  else if (grossMargin >= 15) health.push({ k: 'Gross margin', v: grossMargin + '%', s: 'warn', tip: 'Thin margins — review pricing or costs' });
  else health.push({ k: 'Gross margin', v: grossMargin + '%', s: 'bad', tip: 'Low or negative margin' });

  if (netProfit >= 0) health.push({ k: 'Net result', v: 'Profit', s: 'ok', tip: 'Covering operating costs' });
  else health.push({ k: 'Net result', v: 'Loss', s: 'bad', tip: 'Expenses exceed gross profit this period' });

  if (ar > 0 && ar > cash * 0.5) health.push({ k: 'Receivables', v: 'High', s: 'warn', tip: 'Significant money tied in credit' });
  else if (ar > 0) health.push({ k: 'Receivables', v: 'OK', s: 'ok', tip: 'Credit is manageable' });
  else health.push({ k: 'Receivables', v: 'None', s: 'ok', tip: 'No outstanding customer debt' });

  const lowCount = S.products.filter(isLow).length;
  if (lowCount > 3) health.push({ k: 'Stock', v: lowCount + ' low', s: 'bad', tip: 'Multiple items need reorder' });
  else if (lowCount > 0) health.push({ k: 'Stock', v: lowCount + ' low', s: 'warn', tip: 'Some items running low' });
  else health.push({ k: 'Stock', v: 'OK', s: 'ok', tip: 'No critical low-stock items' });

  if (cash < exp && exp > 0) health.push({ k: 'Cash cover', v: 'Tight', s: 'warn', tip: 'Cash may not cover recent expenses' });
  else health.push({ k: 'Cash cover', v: 'OK', s: 'ok', tip: 'Cash position relative to expenses' });

  function delta(cur, prev) {
    if (prev === 0) return cur === 0 ? null : (cur > 0 ? '+∞' : null);
    const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
    return (pct >= 0 ? '▲ ' : '▼ ') + Math.abs(pct) + '%';
  }

  return {
    period: p,
    rev: curP.rev,
    netRev: curP.netRev,
    disc: curP.disc,
    cogs: curP.cogs,
    grossProfit: curP.profit,
    grossMargin,
    expenses: exp,
    netProfit,
    netMargin,
    cash,
    clearing,
    ar,
    ap: 0, // no accounts payable tracking yet
    inventory: invVal,
    salesCount,
    breakEven,
    health,
    prev: {
      netRev: prevP.netRev,
      grossProfit: prevP.profit,
      expenses: prevExp,
      netProfit: prevNet,
      salesCount: salesInPrevPeriod(p).length
    },
    deltas: {
      netRev: delta(curP.netRev, prevP.netRev),
      grossProfit: delta(curP.profit, prevP.profit),
      expenses: delta(exp, prevExp),
      netProfit: delta(netProfit, prevNet)
    }
  };
}

function periodLabel(p) {
  return ({ today: 'Today', week: 'This week', month: 'This month', quarter: 'This quarter', year: 'This year', all: 'All time' })[p] || p;
}

/* ===== Phase 3 — Advanced Profit Intelligence ===== */
function productProfitability(period) {
  // Per-product: units sold, revenue, COGS, gross profit, margin %, markup %, contribution
  const map = {};
  salesInPeriod(period).forEach((s) => {
    (s.items || []).forEach((it) => {
      if (it.custom || !it.id) return;
      const p = S.products.find((x) => x.id === it.id);
      const cost = it.cost != null ? it.cost : (p ? p.cost : 0) || 0;
      const price = it.price || 0;
      const q = it.q || 0;
      if (!map[it.id]) {
        map[it.id] = {
          id: it.id,
          name: (p && p.name) || it.name || it.id,
          svc: !!(p && p.svc),
          qtySold: 0,
          revenue: 0,
          cogs: 0,
          listPrice: p ? p.price : price,
          listCost: p ? p.cost : cost,
          stock: p ? p.qty : 0
        };
      }
      const row = map[it.id];
      row.qtySold += q;
      row.revenue += q * price;
      row.cogs += q * cost;
    });
  });
  return Object.values(map).map((r) => {
    const gp = r.revenue - r.cogs;
    const margin = r.revenue > 0 ? Math.round((gp / r.revenue) * 1000) / 10 : 0;
    const markup = r.cogs > 0 ? Math.round((gp / r.cogs) * 1000) / 10 : (r.revenue > 0 ? null : 0);
    const unitMargin = r.qtySold > 0 ? Math.round(gp / r.qtySold) : 0;
    return Object.assign(r, {
      grossProfit: gp,
      margin,
      markup,
      unitMargin,
      contribution: gp // same as GP when no product-level variable overhead tracked
    });
  }).sort((a, b) => b.grossProfit - a.grossProfit);
}

function contributionMargin(period) {
  const fs = financialSummary(period);
  // Contribution margin = sales - variable costs. We treat COGS as the primary variable cost.
  // Operating expenses are treated as fixed for this model (typical for small retail/service).
  const cm = fs.netRev - fs.cogs; // = gross profit
  const cmRatio = fs.netRev > 0 ? Math.round((cm / fs.netRev) * 1000) / 10 : 0;
  return {
    sales: fs.netRev,
    variableCosts: fs.cogs,
    contribution: cm,
    contributionRatio: cmRatio,
    fixedCosts: fs.expenses,
    netProfit: fs.netProfit,
    explanation: 'Contribution margin = Net sales − Cost of goods sold. Operating expenses are treated as fixed costs for break-even analysis.'
  };
}

function markupVsMargin(price, cost) {
  if (!Number.isFinite(price) || !Number.isFinite(cost) || price < 0 || cost < 0) return null;
  const gp = price - cost;
  const margin = price > 0 ? Math.round((gp / price) * 1000) / 10 : 0;
  const markup = cost > 0 ? Math.round((gp / cost) * 1000) / 10 : null;
  return { price, cost, grossProfit: gp, margin, markup };
}

function pricingRecommendation(productId, targetMarginPct) {
  const p = S.products.find((x) => x.id === productId);
  if (!p || !Number.isFinite(p.cost) || p.cost < 0) return null;
  const target = Number.isFinite(targetMarginPct) ? targetMarginPct : 30;
  // price = cost / (1 - targetMargin)
  if (target >= 100) return null;
  const recommended = Math.round(p.cost / (1 - target / 100));
  const current = markupVsMargin(p.price, p.cost);
  return {
    product: p.name,
    cost: p.cost,
    currentPrice: p.price,
    currentMargin: current ? current.margin : null,
    currentMarkup: current ? current.markup : null,
    targetMargin: target,
    recommendedPrice: recommended,
    change: recommended - p.price,
    explanation: 'Recommended price = Cost ÷ (1 − target margin). At ' + target + '% margin, price should be ' + kes(recommended) + '.'
  };
}

function discountImpact(originalTotal, discountPct) {
  const pct = Math.max(0, Math.min(100, Number(discountPct) || 0));
  const discAmt = Math.round(originalTotal * pct / 100);
  const net = originalTotal - discAmt;
  // Approximate: assume average gross margin of recent sales
  const fs = financialSummary('month');
  const gm = fs.netRev > 0 ? fs.grossProfit / fs.netRev : 0.3;
  const approxCogs = Math.round(originalTotal * (1 - gm)); // rough
  const gpFull = originalTotal - approxCogs;
  const gpDisc = net - approxCogs;
  return {
    original: originalTotal,
    discountPct: pct,
    discountAmount: discAmt,
    netSales: net,
    approxGrossProfitFull: gpFull,
    approxGrossProfitAfter: gpDisc,
    profitImpact: gpDisc - gpFull,
    explanation: 'Discount of ' + pct + '% reduces revenue by ' + kes(discAmt) + '. Approximate gross profit impact assumes current month gross margin of ' + Math.round(gm * 100) + '%.'
  };
}

function salesTarget(period, targetNetProfit) {
  const fs = financialSummary(period);
  const cm = contributionMargin(period);
  const target = Number.isFinite(targetNetProfit) ? targetNetProfit : fs.netProfit;
  // Required sales = (Fixed costs + Target net profit) / Contribution margin ratio
  if (cm.contributionRatio <= 0) {
    return {
      achievable: false,
      message: 'Cannot compute sales target: contribution margin is zero or negative. Improve product margins first.',
      currentSales: fs.netRev,
      currentNetProfit: fs.netProfit
    };
  }
  const ratio = cm.contributionRatio / 100;
  const requiredSales = Math.round((cm.fixedCosts + target) / ratio);
  const gap = requiredSales - fs.netRev;
  return {
    achievable: true,
    targetNetProfit: target,
    requiredSales,
    currentSales: fs.netRev,
    gap,
    contributionRatio: cm.contributionRatio,
    fixedCosts: cm.fixedCosts,
    explanation: 'Required sales = (Operating expenses + Target net profit) ÷ Contribution margin ratio. At ' + cm.contributionRatio + '% contribution, you need ' + kes(requiredSales) + ' in sales to reach ' + kes(target) + ' net profit.'
  };
}

function cashFlowForecast(days) {
  days = Math.min(90, Math.max(7, days || 30));
  // Simple forward projection based on recent daily averages
  const fs = financialSummary('month');
  const dayCount = Math.max(1, Math.round((periodRange('month').end - periodRange('month').start) / 864e5));
  const avgDailySales = fs.netRev / dayCount;
  const avgDailyCogs = fs.cogs / dayCount;
  const avgDailyExp = fs.expenses / dayCount;
  const avgDailyNet = avgDailySales - avgDailyCogs - avgDailyExp;
  const cashNow = bal('cash') + bal('till');
  const ar = bal('ar');
  // Assume 40% of AR collects in the forecast window (conservative)
  const expectedCollections = Math.round(ar * 0.4);
  const projectedCash = cashNow + expectedCollections + Math.round(avgDailyNet * days);
  return {
    days,
    cashNow,
    receivables: ar,
    expectedCollections,
    avgDailySales: Math.round(avgDailySales),
    avgDailyExpenses: Math.round(avgDailyCogs + avgDailyExp),
    avgDailyNet: Math.round(avgDailyNet),
    projectedCash,
    explanation: 'Forecast uses this month’s average daily net cash generation, plus an estimated 40% collection of current receivables over ' + days + ' days. This is an estimate, not a guarantee.'
  };
}

function expenseAnalysis(period) {
  const entries = entriesInPeriod(period);
  const byMemo = {};
  let total = 0;
  entries.forEach((e) => {
    e.lines.forEach((l) => {
      if (l.a === 'exp' && (l.dr || 0) > 0) {
        const key = (e.memo || 'Expense').replace(/^Expense:\s*/i, '').slice(0, 60) || 'Expense';
        byMemo[key] = (byMemo[key] || 0) + l.dr;
        total += l.dr;
      }
    });
  });
  const list = Object.entries(byMemo).map(([name, amt]) => ({ name, amount: amt, pct: total > 0 ? Math.round(amt / total * 1000) / 10 : 0 }))
    .sort((a, b) => b.amount - a.amount);
  return { total, items: list, count: list.length };
}

function profitabilityComparisons(period) {
  const products = productProfitability(period);
  const profitable = products.filter((p) => p.grossProfit > 0);
  const unprofitable = products.filter((p) => p.grossProfit <= 0 && p.qtySold > 0);
  const top = products.slice(0, 5);
  const bottom = products.filter((p) => p.qtySold > 0).slice(-5).reverse();
  const fs = financialSummary(period);
  return {
    period,
    productCount: products.length,
    profitableCount: profitable.length,
    unprofitableCount: unprofitable.length,
    topByProfit: top,
    bottomByProfit: bottom,
    unprofitable,
    overallGrossMargin: fs.grossMargin,
    overallNetMargin: fs.netMargin
  };
}



/* ===== Alerts (real data only) ===== */
function buildAlerts() {
  const a = [];
  const flagged = S.pays.filter((p) => p.conf === 'flagged');
  const oldUnver = S.pays.filter((p) => p.conf !== 'verified' && Date.now() - p.ts > 864e5);
  const low = S.products.filter(isLow);
  const overdue = S.customers.filter((c) => (c.balance || 0) > 0);
  const unm = S.confs.filter((c) => !c.sale);
  flagged.forEach((p) => a.push({ type: 'bad', title: 'Flagged M-Pesa ' + p.code, body: p.note || 'Amount in message did not match sale.', ts: p.ts, cat: 'payment' }));
  if (oldUnver.length) a.push({ type: 'warn', title: oldUnver.length + ' unverified payment(s) > 24h', body: 'Still in M-Pesa clearing until matched to a statement.', ts: Date.now(), cat: 'payment' });
  low.forEach((p) => a.push({ type: 'warn', title: 'Low stock: ' + p.name, body: 'Only ' + p.qty + ' left. Reorder or adjust stock.', ts: Date.now(), cat: 'stock' }));
  overdue.forEach((c) => a.push({ type: 'warn', title: c.name + ' owes ' + kes(c.balance), body: 'Credit sale not fully paid.', ts: Date.now(), cat: 'ar' }));
  S.products.forEach((p) => { const d = expDays(p); if (d !== null && d <= 30) a.push({ type: d < 0 ? 'bad' : 'warn', title: (d < 0 ? 'Expired: ' : 'Expiring soon: ') + p.name, body: (d < 0 ? 'Expired ' + (-d) + ' day(s) ago.' : 'Expires in ' + d + ' day(s).') + ' Sell, discount or remove it.', ts: Date.now(), cat: 'stock' }); });
  if (unm.length) a.push({ type: 'warn', title: unm.length + ' statement payment(s) with no sale', body: 'Money received but no matching sale recorded.', ts: Date.now(), cat: 'payment' });

  // Declining profit (week vs prior week)
  const fsW = financialSummary('week');
  if (fsW.prev.grossProfit > 0 && fsW.grossProfit < fsW.prev.grossProfit * 0.7) {
    a.push({ type: 'warn', title: 'Gross profit down sharply', body: 'This week ' + kes(fsW.grossProfit) + ' vs prior ' + kes(fsW.prev.grossProfit) + '. Check sales mix and discounts.', ts: Date.now(), cat: 'profit' });
  }
  if (fsW.netProfit < 0 && fsW.prev.netProfit >= 0) {
    a.push({ type: 'bad', title: 'Week turned to a net loss', body: 'Net profit this week is ' + kes(fsW.netProfit) + '. Review expenses and margins.', ts: Date.now(), cat: 'profit' });
  }

  // Cash cover warning
  const cash = bal('cash') + bal('till');
  const monthExp = expensesInPeriod('month');
  if (monthExp > 0 && cash < monthExp * 0.25) {
    a.push({ type: 'warn', title: 'Cash cover is tight', body: 'Available cash ' + kes(cash) + ' is under 25% of this month\'s expenses (' + kes(monthExp) + ').', ts: Date.now(), cat: 'cash' });
  }

  // Recurring expenses due
  const today = todayISO();
  (S.recurring || []).forEach((r) => {
    if (r.nextDue && r.nextDue <= today && !r.paused) {
      a.push({ type: 'warn', title: 'Recurring due: ' + r.name, body: kes(r.amount) + ' scheduled. Record the expense when paid.', ts: Date.now(), cat: 'expense' });
    }
  });

  // Sales target reminder (if set)
  if (S.settings.salesTarget && fsW.netRev < S.settings.salesTarget * 0.5) {
    const day = new Date().getDay() || 7;
    if (day >= 4) {
      a.push({ type: 'warn', title: 'Sales target at risk', body: 'Week sales ' + kes(fsW.netRev) + ' vs target ' + kes(S.settings.salesTarget) + '.', ts: Date.now(), cat: 'sales' });
    }
  }

  return a;
}

/* ===== AI — local intelligence over real records ===== */
function businessContext() {
  const m = profitInPeriod('month');
  const w = profitInPeriod('week');
  const t = profitInPeriod('today');
  const fsM = financialSummary('month');
  const fsW = financialSummary('week');
  const fsT = financialSummary('today');
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
    currency: CC(),
    today: t, week: w, month: m,
    summaryToday: { netRev: fsT.netRev, cogs: fsT.cogs, grossProfit: fsT.grossProfit, grossMargin: fsT.grossMargin, expenses: fsT.expenses, netProfit: fsT.netProfit, netMargin: fsT.netMargin, breakEven: fsT.breakEven },
    summaryWeek: { netRev: fsW.netRev, cogs: fsW.cogs, grossProfit: fsW.grossProfit, grossMargin: fsW.grossMargin, expenses: fsW.expenses, netProfit: fsW.netProfit, netMargin: fsW.netMargin, breakEven: fsW.breakEven },
    summaryMonth: { netRev: fsM.netRev, cogs: fsM.cogs, grossProfit: fsM.grossProfit, grossMargin: fsM.grossMargin, expenses: fsM.expenses, netProfit: fsM.netProfit, netMargin: fsM.netMargin, breakEven: fsM.breakEven, inventory: fsM.inventory },
    cash: bal('cash'), till: bal('till'), clr: bal('clr'), ar: bal('ar'), inv: bal('inv'), exp: bal('exp'),
    inventoryValue: inventoryValue(),
    products: S.products.length, salesCount: S.sales.length,
    lowStock: S.products.filter(isLow).map((p) => ({ name: p.name, qty: p.qty })),
    unverifiedPays: S.pays.filter((p) => p.conf !== 'verified').length,
    customersOwing: S.customers.filter((c) => (c.balance || 0) > 0).map((c) => ({ name: c.name, balance: c.balance })),
    topWeek: topList,
    productsDetail: S.products.map((p) => ({
      name: p.name, price: p.price, cost: p.cost, qty: p.qty,
      margin: p.price ? Math.round((p.price - p.cost) / p.price * 100) : 0
    })),
    health: fsM.health,
    productProfitMonth: productProfitability('month').slice(0, 10).map((p) => ({
      name: p.name, qtySold: p.qtySold, revenue: p.revenue, cogs: p.cogs,
      grossProfit: p.grossProfit, margin: p.margin, markup: p.markup
    })),
    contributionMonth: contributionMargin('month'),
    cashForecast30: cashFlowForecast(30)
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
    const sm = ctx.summaryMonth || {};
    return cite('This month: net sales ' + kes(sm.netRev != null ? sm.netRev : ctx.month.netRev) + (ctx.month.disc ? ' after ' + kes(ctx.month.disc) + ' discounts' : '') + ', COGS ' + kes(sm.cogs != null ? sm.cogs : ctx.month.cogs) + ', gross profit ' + kes(sm.grossProfit != null ? sm.grossProfit : ctx.month.profit) + ' (' + (sm.grossMargin != null ? sm.grossMargin : margin) + '%). Operating expenses this month: ' + kes(sm.expenses != null ? sm.expenses : ctx.exp) + '. Net profit: ' + kes(sm.netProfit != null ? sm.netProfit : (ctx.month.profit - ctx.exp)) + ' (' + (sm.netMargin != null ? sm.netMargin : 0) + '% net margin).', 'Calendar month · sales + product costs + expense journal');
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
    const sm = ctx.summaryMonth || {};
    return cite('Operating expenses this month: ' + kes(sm.expenses != null ? sm.expenses : 0) + '. All-time expense account balance: ' + kes(ctx.exp) + '. These are from expense journal entries (not cost of goods sold).', 'Expense journal + account balance');
  }
  if (/break.?even|breakeven/.test(q)) {
    const sm = ctx.summaryMonth || {};
    if (sm.breakEven != null) {
      return cite('Break-even sales this month: about ' + kes(sm.breakEven) + '. That is the sales level needed to cover operating expenses of ' + kes(sm.expenses) + ' at your current ' + sm.grossMargin + '% gross margin. Current net sales: ' + kes(sm.netRev) + '.', 'Break-even ≈ expenses ÷ gross margin ratio');
    }
    return cite('Not enough data for break-even yet. Record sales with product costs and some operating expenses.', 'Break-even analysis');
  }
  if (/contribution/.test(q)) {
    const sm = ctx.summaryMonth || {};
    const cm = (sm.netRev || 0) - (sm.cogs || 0);
    const ratio = sm.netRev > 0 ? Math.round(cm / sm.netRev * 1000) / 10 : 0;
    return cite('Contribution margin this month: ' + kes(cm) + ' (' + ratio + '% of net sales). This is net sales minus cost of goods sold. Operating expenses are treated as fixed costs on top of that.', 'Contribution = net sales − COGS');
  }
  if (/sales target|target sales|how much.*sell/.test(q)) {
    const sm = ctx.summaryMonth || {};
    const t = salesTarget('month', sm.netProfit > 0 ? Math.round(sm.netProfit * 1.2) : Math.round((sm.expenses || 10000) * 0.5));
    if (t.achievable) {
      return cite('To reach about ' + kes(t.targetNetProfit) + ' net profit this month you need roughly ' + kes(t.requiredSales) + ' in sales (currently ' + kes(t.currentSales) + '). Gap: ' + (t.gap <= 0 ? 'on track' : kes(t.gap)) + '. Based on ' + t.contributionRatio + '% contribution margin.', 'Sales target formula');
    }
    return cite(t.message, 'Sales target');
  }
  if (/forecast|cash flow|will i have|projected cash/.test(q)) {
    const f = cashFlowForecast(30);
    return cite('30-day cash outlook: now ' + kes(f.cashNow) + ', plus ~' + kes(f.expectedCollections) + ' expected collections from receivables, plus about ' + kes(f.avgDailyNet) + '/day net run-rate → projected ~' + kes(f.projectedCash) + '. ' + f.explanation, 'Simple cash forecast from recent averages');
  }
  if (/pricing|recommend.*price|what.*charge|should i sell/.test(q)) {
    const low = (ctx.productsDetail || []).filter((p) => p.price > 0 && p.cost >= 0 && p.margin < 20).sort((a, b) => a.margin - b.margin).slice(0, 3);
    if (!low.length) return cite('No products currently under 20% margin. Check the Profit Intelligence page for full pricing recommendations.', 'Product margins');
    return cite('Low-margin products (under 20%):\n' + low.map((p) => {
      const rec = p.cost > 0 ? Math.round(p.cost / 0.7) : null;
      return '• ' + p.name + ' — now ' + kes(p.price) + ' (' + p.margin + '%). ' + (rec != null ? 'For ~30% margin suggest ~' + kes(rec) + '.' : '');
    }).join('\n'), 'Price and cost on product records');
  }
  if (/management summary|executive summary|summarise|summarize|status report|weekly summary|monthly summary/.test(q)) {
    const sm = ctx.summaryMonth || {};
    const sw = ctx.summaryWeek || {};
    const lines = [
      'Management summary for ' + (ctx.business || 'your business') + ' (' + (ctx.currency || '') + '):',
      '• This month: net sales ' + kes(sm.netRev || 0) + ', gross profit ' + kes(sm.grossProfit || 0) + ' (' + (sm.grossMargin || 0) + '%), expenses ' + kes(sm.expenses || 0) + ', net profit ' + kes(sm.netProfit || 0) + ' (' + (sm.netMargin || 0) + '%).',
      '• This week: net sales ' + kes(sw.netRev || 0) + ', net profit ' + kes(sw.netProfit || 0) + '.',
      '• Cash available: ' + kes((ctx.cash || 0) + (ctx.till || 0)) + '; receivables: ' + kes(ctx.ar || 0) + '; inventory value: ' + kes(ctx.inventoryValue || 0) + '.',
      '• Low stock items: ' + ((ctx.lowStock || []).length) + '; customers owing: ' + ((ctx.customersOwing || []).length) + '; unverified payments: ' + (ctx.unverifiedPays || 0) + '.'
    ];
    if (ctx.health && ctx.health.length) {
      lines.push('• Health: ' + ctx.health.map((h) => h.k + ' ' + h.v).join('; ') + '.');
    }
    lines.push('Figures are from your MarginPilot records only.');
    return cite(lines.join('\n'), 'Management summary from live records');
  }
  if (/unprofitable|losing money|loss.?making|which.*loss/.test(q)) {
    const bad = (ctx.productsDetail || []).filter((p) => p.price > 0 && p.margin <= 0);
    if (!bad.length) return cite('No products currently show zero or negative list margin. Check actual sold margins on the Profit Intelligence page — sale prices can differ from list price.', 'Product list margins');
    return cite('Products with zero or negative list margin:\n' + bad.map((p) => '• ' + p.name + ' — sell ' + kes(p.price) + ', cost ' + kes(p.cost)).join('\n'), 'Product price vs cost');
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
  const hour = new Date().getHours(), greet = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const head = subNudge() + installBanner() + backupNudge() + typeTip() + '<div class="page-title"><div><h1>Good ' + greet + '</h1><p class="muted" style="margin:0">' + esc(S.settings.businessName) + (bt() ? ' · ' + bt().i + ' ' + esc(bt().l) : '') + '</p></div></div>';
  if (!S.sales.length) {
    const has = S.products.length > 0, canSeed = bt() && bt().items.length && !has;
    return head + '<div class="card"><h3>Start in 2 steps</h3>' +
      '<div class="row"><span><strong>' + (has ? '✅ ' : '1. ') + 'Add what you sell</strong><br><small class="muted">' + (has ? S.products.length + ' item(s) ready. Edit prices in Stock.' : 'Your products or services, with their prices.') + '</small></span>' +
      (has ? '' : canSeed ? '<button type="button" class="btn btn-secondary btn-sm" data-seed="1">Add starter items</button>' : '<button type="button" class="btn btn-secondary btn-sm" data-goto="stock">Add items</button>') + '</div>' +
      '<div class="row"><span><strong>2. Record your first sale</strong><br><small class="muted">Then this page shows your real profit, cash and debts.</small></span></div>' +
      '<button type="button" class="btn btn-primary btn-block" style="margin-top:12px" data-goto="sell">＋ Record your first sale</button></div>';
  }

  // Period selector (session-persistent)
  const period = (typeof homePeriod !== 'undefined' && homePeriod) ? homePeriod : 'today';
  const fs = financialSummary(period);
  const alerts = buildAlerts();
  const closes = S.settings.closes || [], lc = closes[closes.length - 1];
  const owing = S.customers.filter((c) => (c.balance || 0) > 0).length;

  const periodPills = ['today', 'week', 'month'].map((p) =>
    '<button type="button" class="pill' + (period === p ? ' active' : '') + '" data-homeperiod="' + p + '">' + periodLabel(p) + '</button>'
  ).join('');

  // KPI helper
  function kpi(label, value, sub, cls, goto) {
    const tag = goto ? 'button type="button" class="stat" data-goto="' + goto + '"' : 'div class="stat"';
    const close = goto ? 'button' : 'div';
    return '<' + tag + '><div class="lbl">' + label + '</div><div class="val' + (cls ? ' ' + cls : '') + '">' + value + '</div>' +
      (sub ? '<div class="sub">' + sub + '</div>' : '') + '</' + close + '>';
  }

  const grossCls = fs.grossProfit < 0 ? 'bad' : 'ok';
  const netCls = fs.netProfit < 0 ? 'bad' : 'ok';
  const deltaRev = fs.deltas.netRev ? ' · ' + fs.deltas.netRev + ' vs prior' : '';
  const deltaNet = fs.deltas.netProfit ? ' · ' + fs.deltas.netProfit + ' vs prior' : '';

  let html = head +
    '<div class="card" style="padding-bottom:8px"><div class="pill-row" style="margin-bottom:8px">' + periodPills + '</div>' +
    '<div class="lbl">' + periodLabel(period) + ' net profit</div>' +
    '<div class="val ' + netCls + '" style="font-size:2.2rem;font-weight:700">' + kes(fs.netProfit) + '</div>' +
    '<div class="muted">' + fs.salesCount + ' sale(s) · gross ' + kes(fs.grossProfit) + ' · expenses ' + kes(fs.expenses) + deltaNet + '</div></div>';

  // Primary KPI grid
  html += '<div class="grid">' +
    kpi('Revenue (net)', kes(fs.netRev), (fs.disc ? 'after ' + kes(fs.disc) + ' discounts' : 'sales') + deltaRev, '', 'reports') +
    kpi('Cost of goods', kes(fs.cogs), 'from product costs', '', 'reports') +
    kpi('Gross profit', kes(fs.grossProfit), fs.grossMargin + '% margin', grossCls, 'reports') +
    kpi('Operating expenses', kes(fs.expenses), fs.deltas.expenses ? fs.deltas.expenses + ' vs prior' : 'from journal', fs.expenses > 0 ? '' : 'est', 'money') +
    '</div>';

  // Cash & balance sheet style
  html += '<div class="grid">' +
    kpi('Cash available', kes(fs.cash), 'Cash ' + kes(bal('cash')) + ' · M-Pesa ' + kes(bal('till')), '', 'money') +
    kpi('Receivables', kes(fs.ar), owing ? owing + ' customer(s) · collect' : 'Nobody owes you', fs.ar > 0 ? 'est' : '', 'customers') +
    kpi('Inventory value', kes(fs.inventory), 'at cost · stock on hand', '', 'stock') +
    kpi('Payables', kes(fs.ap), 'Not tracked yet', 'est', null) +
    '</div>';

  // Break-even + health
  html += '<div class="grid-2">';
  if (fs.breakEven != null) {
    html += '<div class="card"><div class="lbl">Break-even sales (this period)</div>' +
      '<div class="val">' + kes(fs.breakEven) + '</div>' +
      '<div class="sub">Sales needed to cover recorded operating expenses at current ' + fs.grossMargin + '% gross margin. Approximate.</div></div>';
  } else {
    html += '<div class="card"><div class="lbl">Break-even</div><div class="val est">—</div>' +
      '<div class="sub">Needs sales with positive gross margin and some operating expenses recorded.</div></div>';
  }
  html += '<div class="card"><div class="card-head"><h3 style="margin:0;font-size:0.95rem">Business health</h3></div>' +
    fs.health.map((h) => '<div class="row" style="padding:6px 0"><span>' + esc(h.k) + '<br><small class="muted">' + esc(h.tip) + '</small></span>' +
      '<span class="tag ' + (h.s === 'ok' ? '' : h.s === 'bad' ? 'bad' : 'w') + '">' + esc(h.v) + '</span></div>').join('') +
    '</div></div>';

  // Actions
  html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">' +
    '<button type="button" class="btn btn-primary" data-goto="sell">＋ Record a sale</button>' +
    (owing ? '<button type="button" class="btn btn-secondary" data-goto="customers">💬 Collect debts</button>' : '') +
    '<a class="btn btn-secondary" target="_blank" rel="noopener" href="' + reportLink() + '">📲 Send report</a>' +
    '<button type="button" class="btn btn-secondary" data-closeday="1">🧮 Close the day</button></div>';
  if (lc) {
    html += '<p class="lock-note">Last cash count ' + fmtDate(lc.ts) + ': ' + (lc.diff === 0 ? 'matched ✅' : (lc.diff < 0 ? 'short by ' : 'over by ') + kes(Math.abs(lc.diff))) + '</p>';
  }

  // Alerts
  if (alerts.length) {
    html += '<div class="card gold"><div class="card-head"><h3>Needs attention</h3><button type="button" class="btn btn-ghost btn-sm" data-goto="alerts">All alerts</button></div>' +
      alerts.slice(0, 4).map((a) => '<div class="alert-item"><div class="alert-icon ' + (a.type === 'bad' ? 'bad' : '') + '">!</div><div><strong>' + esc(a.title) + '</strong><br><span class="muted">' + esc(a.body) + '</span></div></div>').join('') + '</div>';
  } else {
    html += '<div class="card"><p class="ok" style="margin:0"><strong>All clear.</strong> No flagged payments, low stock, or overdue credit right now.</p></div>';
  }

  // Expandable detail (charts + trends)
  html += '<details class="card"><summary><strong>Trends, charts and top products</strong></summary>' + viewHomeDetail(period) + '</details>';

  return html;
}
function viewHomeDetail(period) {
  period = period || (typeof homePeriod !== 'undefined' && homePeriod) || 'week';
  const fs = financialSummary(period);
  const chartDays = 7;
  const dayTotals = [];
  const now = new Date(); now.setHours(0, 0, 0, 0);
  for (let i = chartDays - 1; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const start = d.getTime(), end = start + 864e5 - 1;
    const tot = S.sales.filter((s) => !s.refunded && s.ts >= start && s.ts <= end).reduce((a, s) => a + s.total, 0);
    dayTotals.push({ day: d, tot });
  }
  const maxBar = Math.max(1, ...dayTotals.map((x) => x.tot));
  const chartH = 120;
  const bars = dayTotals.map((x, i) => {
    const h = Math.round((x.tot / maxBar) * (chartH - 24));
    const xPos = 8 + i * 38;
    const label = x.day.toLocaleDateString('en-KE', { weekday: 'narrow' });
    return '<rect x="' + xPos + '" y="' + (chartH - h - 16) + '" width="28" height="' + h + '" rx="4" fill="var(--em)" opacity="' + (0.45 + 0.55 * (x.tot / maxBar)) + '"></rect>' +
      '<text x="' + (xPos + 14) + '" y="' + (chartH - 2) + '" text-anchor="middle" font-size="10" fill="var(--mu)">' + label + '</text>';
  }).join('');

  // Top products by net revenue in period
  const topMap = {};
  salesInPeriod(period).forEach((s) => (s.items || []).forEach((it) => {
    topMap[it.id] = (topMap[it.id] || 0) + it.q * (it.price || 0);
  }));
  const top = Object.entries(topMap).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // Comparison table
  let cmpRows = '';
  const rows = [
    ['Net sales', fs.netRev, fs.prev.netRev, fs.deltas.netRev],
    ['Gross profit', fs.grossProfit, fs.prev.grossProfit, fs.deltas.grossProfit],
    ['Operating expenses', fs.expenses, fs.prev.expenses, fs.deltas.expenses],
    ['Net profit', fs.netProfit, fs.prev.netProfit, fs.deltas.netProfit]
  ];
  rows.forEach(([label, cur, prev, dlt]) => {
    cmpRows += '<tr><td>' + label + '</td><td class="n">' + kes(cur) + '</td><td class="n">' + kes(prev) + '</td><td class="n">' + (dlt || '—') + '</td></tr>';
  });

  return '<div style="margin-top:12px">' +
    '<div class="grid">' +
    '<button type="button" class="stat" data-goto="reports"><div class="lbl">Sales</div><div class="val">' + kes(fs.netRev) + '</div><div class="sub">' + fs.salesCount + ' sale(s)' + (fs.disc ? ' · discounts ' + kes(fs.disc) : '') + ' · actual</div></button>' +
    '<button type="button" class="stat" data-goto="reports"><div class="lbl">Gross profit</div><div class="val ' + (fs.grossProfit < 0 ? 'bad' : 'ok') + '">' + kes(fs.grossProfit) + '</div><div class="sub">' + fs.grossMargin + '% margin · after COGS · actual</div></button>' +
    '<button type="button" class="stat" data-goto="money"><div class="lbl">Cash + M-Pesa</div><div class="val">' + kes(fs.cash) + '</div><div class="sub">Cash ' + kes(bal('cash')) + ' · Till ' + kes(bal('till')) + '</div></button>' +
    '<button type="button" class="stat" data-goto="money"><div class="lbl">Awaiting verification</div><div class="val est">' + kes(fs.clearing) + '</div><div class="sub">Unverified M-Pesa · estimated</div></button></div>' +
    '<div class="card" style="margin-top:12px"><h3>Period comparison</h3>' +
    '<table class="tbl"><thead><tr><th>Metric</th><th class="n">Current</th><th class="n">Prior</th><th class="n">Change</th></tr></thead><tbody>' + cmpRows + '</tbody></table>' +
    '<p class="muted" style="margin-top:8px;font-size:0.8rem">All figures from recorded sales, product costs and expense journal entries. Prior period is the matching previous day/week/month.</p></div>' +
    '<div class="grid-2" style="margin-top:12px"><div class="card"><h3>Sales · last 7 days</h3><div class="chart-wrap" role="img" aria-label="Daily sales chart"><svg viewBox="0 0 280 ' + chartH + '">' + bars + '</svg></div></div>' +
    '<div class="card"><h3>Top products · ' + periodLabel(period) + '</h3>' +
    (top.length ? top.map(([id, v]) => { const p = S.products.find((x) => x.id === id); return '<div class="row"><span>' + esc(p ? p.name : id) + '</span><b class="mono">' + kes(v) + '</b></div>'; }).join('') : '<p class="muted">No sales in this period.</p>') +
    '</div></div>' +
    '<div class="card" style="margin-top:12px"><div class="card-head"><h3>Recent sales</h3><button type="button" class="btn btn-ghost btn-sm" data-goto="money">See all</button></div>' +
    (S.sales.filter((s) => !s.refunded).slice(-5).reverse().map((s) =>
      '<div class="row"><span>#' + s.id + ' · ' + esc(s.method) + '<br><small class="muted">' + fmtDate(s.ts) + '</small></span><b class="mono">' + kes(s.total) + '</b></div>'
    ).join('') || '<p class="muted">No sales yet.</p>') + '</div></div>';
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
        '<button type="button" class="prod-tile" data-add="' + p.id + '" ' + (p.qty < 1 ? 'disabled' : '') + '><b>' + esc(p.name) + '</b>' + kes(p.price) + '<br><small>' + (p.svc ? 'Service' : p.qty + ' left') + '</small></button>'
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
    '<label class="field"><span>Expiry date (optional)</span><input id="pe" type="date"></label>' +
    '<label class="row"><span>This is a service (no stock), e.g. a haircut</span><input type="checkbox" id="psv"></label>' +
    '<button type="button" class="btn btn-primary" data-addproduct="1">Add product</button></div>' +
    orderCard() + '<div class="card"><div class="card-head"><h3>Products</h3><span class="muted">' + S.products.length + ' items</span></div>' +
    (S.products.length ? S.products.map((p) => {
      const margin = p.price ? Math.round((p.price - p.cost) / p.price * 100) : 0;
      return '<div class="row"><span><strong>' + esc(p.name) + '</strong>' + (p.barcode ? ' · ' + esc(p.barcode) : '') +
        '<br><small class="muted">Sell ' + kes(p.price) + ' · cost ' + kes(p.cost) + ' · margin ' + margin + '%</small>' +
        (isLow(p) ? '<br><span class="tag w">Low stock</span>' : '') + expTag(p) + '</span>' +
        '<div style="text-align:right"><b>' + (p.svc ? 'Service' : p.qty) + '</b><br>' +
        (p.svc ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-adjust="' + p.id + '">Adjust</button> <button type="button" class="btn btn-ghost btn-sm" data-setexp="' + p.id + '">Expiry</button>') + '</div></div>';
    }).join('') : '<div class="empty"><h3>No products</h3><p>Add your first product to start selling.</p></div>') + '</div>';
}


function viewSuppliersPanel() {
  return '<div class="card"><h3>Add supplier</h3>' +
    '<label class="field"><span>Name</span><input id="sup-name"></label>' +
    '<label class="field"><span>Phone (optional)</span><input id="sup-phone" inputmode="tel"></label>' +
    '<label class="field"><span>Notes</span><input id="sup-notes"></label>' +
    '<button type="button" class="btn btn-primary" data-addsupplier="1">Add supplier</button></div>' +
    '<div class="card"><div class="card-head"><h3>Suppliers</h3><span class="muted">' + (S.suppliers || []).length + '</span></div>' +
    ((S.suppliers || []).length ? (S.suppliers || []).map((s) =>
      '<div class="row"><span><strong>' + esc(s.name) + '</strong>' + (s.phone ? '<br><small class="muted">' + esc(s.phone) + '</small>' : '') +
      (s.notes ? '<br><small class="muted">' + esc(s.notes) + '</small>' : '') + '</span>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-rmsupplier="' + s.id + '">Remove</button></div>'
    ).join('') : '<p class="muted">No suppliers yet. Add the people or shops you buy from.</p>') + '</div>';
}

function viewPurchasesPanel() {
  const list = (S.purchases || []).slice().sort((a, b) => b.ts - a.ts).slice(0, 30);
  return '<div class="card"><h3>Record purchase</h3>' +
    '<label class="field"><span>Supplier</span><input id="pur-sup" list="sup-list" placeholder="Who did you buy from?"><datalist id="sup-list">' +
    (S.suppliers || []).map((s) => '<option value="' + esc(s.name) + '">').join('') + '</datalist></label>' +
    '<label class="field"><span>Description</span><input id="pur-desc" placeholder="Stock, materials…"></label>' +
    '<div class="grid"><label class="field"><span>Amount (' + CC() + ')</span><input id="pur-amt" inputmode="decimal"></label>' +
    '<label class="field"><span>Payment</span><select id="pur-pay"><option value="cash">Cash</option><option value="mpesa">M-Pesa / mobile money</option><option value="credit">On credit (payable)</option></select></label></div>' +
    '<button type="button" class="btn btn-primary" data-addpurchase="1">Save purchase</button>' +
    '<p class="muted" style="margin-top:8px;font-size:0.8rem">Cash/M-Pesa purchases reduce cash and increase inventory (or expense). Credit purchases track money you owe.</p></div>' +
    '<div class="card"><div class="card-head"><h3>Recent purchases</h3></div>' +
    (list.length ? list.map((p) =>
      '<div class="row"><span><strong>' + esc(p.desc) + '</strong><br><small class="muted">' + esc(p.supplier || '—') + ' · ' + esc(p.pay) + ' · ' + fmtDate(p.ts) + '</small></span>' +
      '<b class="mono">' + kes(p.amount) + '</b></div>'
    ).join('') : '<p class="muted">No purchases recorded yet.</p>') + '</div>' +
    '<div class="card"><h3>Recurring expenses</h3>' +
    '<label class="field"><span>Name</span><input id="rec-name" placeholder="Rent, internet…"></label>' +
    '<div class="grid"><label class="field"><span>Amount (' + CC() + ')</span><input id="rec-amt" inputmode="decimal"></label>' +
    '<label class="field"><span>Every (days)</span><input id="rec-days" inputmode="numeric" value="30"></label></div>' +
    '<button type="button" class="btn btn-secondary" data-addrecurring="1">Add recurring</button>' +
    ((S.recurring || []).length ? (S.recurring || []).map((r) =>
      '<div class="row" style="margin-top:8px"><span><strong>' + esc(r.name) + '</strong><br><small class="muted">' + kes(r.amount) + ' every ' + r.everyDays + ' days · next ' + esc(r.nextDue || '—') + (r.paused ? ' · paused' : '') + '</small></span>' +
      '<div><button type="button" class="btn btn-ghost btn-sm" data-postrecurring="' + r.id + '">Record now</button> <button type="button" class="btn btn-ghost btn-sm" data-rmrecurring="' + r.id + '">Remove</button></div></div>'
    ).join('') : '<p class="muted" style="margin-top:8px">Track rent, subscriptions and other regular costs.</p>') + '</div>';
}


function viewMoney() {
  if (!can('money') && !can('ledger')) return lockedView('Money');
  const tag = (c) => ({ verified: '<span class="tag">Verified</span>', attested: '<span class="tag w">Attested</span>', flagged: '<span class="tag b">Flagged</span>' }[c] || '<span class="tag w">Unconfirmed</span>');
  const subs = [['overview','Overview'],['payments','M-Pesa'],['sales','Sales'],['ledger','Ledger'],['suppliers','Suppliers'],['purchases','Purchases']];
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
  if (moneySub === 'suppliers' && can('money')) {
    body += viewSuppliersPanel();
  }
  if (moneySub === 'purchases' && can('money')) {
    body += viewPurchasesPanel();
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
    (S.customers.length ? S.customers.slice().sort((a, b) => (b.balance || 0) - (a.balance || 0)).map((c) =>
      '<div class="row"><span><strong>' + esc(c.name) + '</strong>' + (c.phone ? '<br><small class="muted">' + esc(c.phone) + '</small>' : '') + '</span>' +
      '<div style="text-align:right">' + ((c.balance || 0) > 0
        ? '<b class="mono">' + kes(c.balance) + '</b><br><button type="button" class="btn btn-ghost btn-sm" data-paycredit="' + c.id + '">Record payment</button> ' + remindBtn(c)
        : '<span class="tag muted">Settled</span>') + '</div></div>'
    ).join('') : '<div class="empty"><h3>No customers yet</h3><p>Credit sales will add them automatically, or add one above.</p></div>') + '</div>' +
    '<div class="card"><p class="muted">Total money you are owed: <strong class="mono">' + kes(bal('ar')) + '</strong></p>' +
    '<label class="field"><span>Reminder language</span><select id="msg-lang"><option value="en"' + (S.settings.msgLang !== 'sw' ? ' selected' : '') + '>English</option><option value="sw"' + (S.settings.msgLang === 'sw' ? ' selected' : '') + '>Kiswahili</option></select></label></div>';
}

function viewReports() {
  if (!can('reports')) return lockedView('Reports');
  const period = (typeof reportPeriod !== 'undefined' && reportPeriod) ? reportPeriod : 'month';
  const fs = financialSummary(period);
  const cm = contributionMargin(period);
  const products = productProfitability(period);
  const cmp = profitabilityComparisons(period);
  const expA = expenseAnalysis(period);
  const forecast = cashFlowForecast(30);
  const target = salesTarget(period, fs.netProfit > 0 ? Math.round(fs.netProfit * 1.2) : Math.round((fs.expenses || 10000) * 0.5));

  const periodPills = ['today', 'week', 'month'].map((p) =>
    '<button type="button" class="pill' + (period === p ? ' active' : '') + '" data-reportperiod="' + p + '">' + periodLabel(p) + '</button>'
  ).join('');

  let html = '<div class="page-title"><div><h1>Profit Intelligence</h1><p class="muted" style="margin:0">Real figures from your records · ' + periodLabel(period) + '</p></div>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" class="btn btn-ai btn-sm" data-goto="ai">Explain with AI</button> <a class="btn btn-secondary btn-sm" target="_blank" rel="noopener" href="' + reportLink() + '">📲 WhatsApp</a></div></div>';

  html += '<div class="pill-row">' + periodPills + '</div>';

  // === Summary KPIs ===
  html += '<div class="grid">' +
    '<div class="stat"><div class="lbl">Net sales</div><div class="val">' + kes(fs.netRev) + '</div><div class="sub">' + fs.salesCount + ' sale(s)' + (fs.deltas.netRev ? ' · ' + fs.deltas.netRev : '') + '</div></div>' +
    '<div class="stat"><div class="lbl">Gross profit</div><div class="val ' + (fs.grossProfit < 0 ? 'bad' : 'ok') + '">' + kes(fs.grossProfit) + '</div><div class="sub">' + fs.grossMargin + '% margin</div></div>' +
    '<div class="stat"><div class="lbl">Net profit</div><div class="val ' + (fs.netProfit < 0 ? 'bad' : 'ok') + '">' + kes(fs.netProfit) + '</div><div class="sub">' + fs.netMargin + '% net margin</div></div>' +
    '<div class="stat"><div class="lbl">Contribution margin</div><div class="val">' + cm.contributionRatio + '%</div><div class="sub">' + kes(cm.contribution) + ' after COGS</div></div>' +
    '</div>';

  // === P&L table ===
  html += '<div class="card"><h3>Profit & loss</h3><div class="table-scroll"><table class="tbl"><thead><tr><th>Line</th><th class="n">Amount</th><th class="n">% of sales</th></tr></thead><tbody>' +
    '<tr><td>Net sales</td><td class="n">' + kes(fs.netRev) + '</td><td class="n">100%</td></tr>' +
    (fs.disc ? '<tr><td class="muted">Discounts given</td><td class="n muted">' + kes(fs.disc) + '</td><td class="n muted">' + (fs.rev > 0 ? Math.round(fs.disc / fs.rev * 100) : 0) + '%</td></tr>' : '') +
    '<tr><td>Cost of goods sold</td><td class="n">' + kes(fs.cogs) + '</td><td class="n">' + (fs.netRev > 0 ? Math.round(fs.cogs / fs.netRev * 100) : 0) + '%</td></tr>' +
    '<tr><td><strong>Gross profit</strong></td><td class="n"><strong>' + kes(fs.grossProfit) + '</strong></td><td class="n"><strong>' + fs.grossMargin + '%</strong></td></tr>' +
    '<tr><td>Operating expenses</td><td class="n">' + kes(fs.expenses) + '</td><td class="n">' + (fs.netRev > 0 ? Math.round(fs.expenses / fs.netRev * 100) : 0) + '%</td></tr>' +
    '<tr><td><strong>Net profit</strong></td><td class="n ' + (fs.netProfit < 0 ? 'bad' : 'ok') + '"><strong>' + kes(fs.netProfit) + '</strong></td><td class="n"><strong>' + fs.netMargin + '%</strong></td></tr>' +
    '</tbody></table></div>' +
    '<p class="muted" style="margin-top:8px;font-size:0.8rem">Gross profit = Net sales − COGS. Net profit = Gross profit − Operating expenses. All from recorded transactions.</p></div>';

  // === Contribution & Break-even ===
  html += '<div class="grid-2"><div class="card"><h3>Contribution margin</h3>' +
    '<div class="row"><span>Net sales</span><b class="mono">' + kes(cm.sales) + '</b></div>' +
    '<div class="row"><span>− Variable costs (COGS)</span><b class="mono">' + kes(cm.variableCosts) + '</b></div>' +
    '<div class="row"><span><strong>Contribution</strong></span><b class="mono">' + kes(cm.contribution) + ' (' + cm.contributionRatio + '%)</b></div>' +
    '<div class="row"><span>− Fixed costs (expenses)</span><b class="mono">' + kes(cm.fixedCosts) + '</b></div>' +
    '<div class="row"><span><strong>Net profit</strong></span><b class="mono ' + (cm.netProfit < 0 ? 'bad' : 'ok') + '">' + kes(cm.netProfit) + '</b></div>' +
    '<p class="muted" style="margin-top:8px;font-size:0.8rem">' + esc(cm.explanation) + '</p></div>';

  html += '<div class="card"><h3>Break-even analysis</h3>';
  if (fs.breakEven != null) {
    html += '<div class="val">' + kes(fs.breakEven) + '</div>' +
      '<div class="sub">Sales needed to cover operating expenses at current ' + fs.grossMargin + '% gross margin.</div>' +
      '<div class="row" style="margin-top:10px"><span>Current sales</span><b class="mono">' + kes(fs.netRev) + '</b></div>' +
      '<div class="row"><span>Gap to break-even</span><b class="mono">' + (fs.netRev >= fs.breakEven ? '<span class="ok">Covered</span>' : kes(fs.breakEven - fs.netRev)) + '</b></div>';
  } else {
    html += '<div class="val est">—</div><div class="sub">Needs positive gross margin and some operating expenses recorded.</div>';
  }
  html += '<p class="muted" style="margin-top:8px;font-size:0.8rem">Break-even sales ≈ Operating expenses ÷ Gross margin ratio. Approximate; assumes expenses stay constant.</p></div></div>';

  // === Product profitability ===
  html += '<div class="card"><div class="card-head"><h3>Product & service profitability</h3><span class="muted">' + products.length + ' sold in period</span></div>';
  if (!products.length) {
    html += '<p class="muted">No product sales in this period. Record sales to see which items make money.</p>';
  } else {
    html += '<div class="table-scroll"><table class="tbl"><thead><tr><th>Product</th><th class="n">Sold</th><th class="n">Revenue</th><th class="n">COGS</th><th class="n">Gross profit</th><th class="n">Margin</th><th class="n">Markup</th></tr></thead><tbody>';
    products.slice(0, 15).forEach((r) => {
      const mCls = r.margin < 15 ? 'bad' : (r.margin < 30 ? '' : 'ok');
      html += '<tr><td>' + esc(r.name) + (r.svc ? ' <small class="muted">svc</small>' : '') + '</td>' +
        '<td class="n">' + r.qtySold + '</td>' +
        '<td class="n">' + kes(r.revenue) + '</td>' +
        '<td class="n">' + kes(r.cogs) + '</td>' +
        '<td class="n ' + (r.grossProfit < 0 ? 'bad' : '') + '">' + kes(r.grossProfit) + '</td>' +
        '<td class="n ' + mCls + '">' + r.margin + '%</td>' +
        '<td class="n">' + (r.markup != null ? r.markup + '%' : '—') + '</td></tr>';
    });
    html += '</tbody></table></div>';
    if (cmp.unprofitableCount > 0) {
      html += '<p class="muted" style="margin-top:8px"><strong class="bad">' + cmp.unprofitableCount + ' item(s) sold at a loss or zero margin.</strong> Review cost or price.</p>';
    }
    html += '<p class="muted" style="margin-top:6px;font-size:0.8rem">Margin % = Gross profit ÷ Revenue. Markup % = Gross profit ÷ Cost. Both use actual sale prices and costs recorded on each sale.</p>';
  }
  html += '</div>';

  // === Pricing recommendations ===
  const lowMargin = S.products.filter((p) => !p.svc && p.price > 0 && p.cost >= 0 && (p.price - p.cost) / p.price < 0.2).slice(0, 5);
  if (lowMargin.length) {
    html += '<div class="card"><h3>Pricing recommendations</h3><p class="muted">Items with current margin under 20%. Suggested price targets 30% margin.</p>';
    lowMargin.forEach((p) => {
      const rec = pricingRecommendation(p.id, 30);
      if (!rec) return;
      html += '<div class="row"><span><strong>' + esc(p.name) + '</strong><br><small class="muted">Cost ' + kes(p.cost) + ' · Now ' + kes(p.price) + ' (' + rec.currentMargin + '% margin)</small></span>' +
        '<span class="mono">Suggest ' + kes(rec.recommendedPrice) + '<br><small class="muted">' + (rec.change >= 0 ? '+' : '') + kes(rec.change) + '</small></span></div>';
    });
    html += '<p class="muted" style="margin-top:8px;font-size:0.8rem">Recommended price = Cost ÷ (1 − 0.30). Adjust for your market; this is a starting point, not a rule.</p></div>';
  }

  // === Discount impact helper ===
  html += '<div class="card"><h3>Discount impact calculator</h3>' +
    '<div class="grid"><label class="field"><span>Sale amount (' + CC() + ')</span><input id="di-amt" inputmode="decimal" placeholder="e.g. 5000"></label>' +
    '<label class="field"><span>Discount %</span><input id="di-pct" inputmode="decimal" placeholder="e.g. 10" value="10"></label></div>' +
    '<button type="button" class="btn btn-secondary" data-discimpact="1">Calculate impact</button>' +
    '<div id="di-out" style="margin-top:10px"></div>' +
    '<p class="muted" style="margin-top:8px;font-size:0.8rem">Shows approximate gross-profit reduction using this month’s average margin. Actual impact depends on which products are discounted.</p></div>';

  // === Sales target ===
  html += '<div class="card"><h3>Sales target</h3>';
  if (target.achievable) {
    html += '<div class="row"><span>Target net profit</span><b class="mono">' + kes(target.targetNetProfit) + '</b></div>' +
      '<div class="row"><span>Required sales</span><b class="mono">' + kes(target.requiredSales) + '</b></div>' +
      '<div class="row"><span>Current sales</span><b class="mono">' + kes(target.currentSales) + '</b></div>' +
      '<div class="row"><span>Gap</span><b class="mono">' + (target.gap <= 0 ? '<span class="ok">On track</span>' : kes(target.gap)) + '</b></div>' +
      '<p class="muted" style="margin-top:8px;font-size:0.8rem">' + esc(target.explanation) + '</p>';
  } else {
    html += '<p class="muted">' + esc(target.message) + '</p>';
  }
  html += '</div>';

  // === Expense analysis ===
  html += '<div class="card"><h3>Operating expense analysis</h3>';
  if (!expA.items.length) {
    html += '<p class="muted">No operating expenses recorded in this period. Add them under Money → Record expense.</p>';
  } else {
    html += '<div class="row"><span>Total expenses</span><b class="mono">' + kes(expA.total) + '</b></div>';
    expA.items.slice(0, 10).forEach((it) => {
      html += '<div class="row"><span>' + esc(it.name) + '</span><b class="mono">' + kes(it.amount) + ' <small class="muted">' + it.pct + '%</small></b></div>';
    });
  }
  html += '</div>';

  // === Cash flow forecast ===
  html += '<div class="card"><h3>Cash flow forecast (30 days)</h3>' +
    '<div class="grid">' +
    '<div class="stat"><div class="lbl">Cash now</div><div class="val">' + kes(forecast.cashNow) + '</div></div>' +
    '<div class="stat"><div class="lbl">Expected collections</div><div class="val est">' + kes(forecast.expectedCollections) + '</div><div class="sub">~40% of AR</div></div>' +
    '<div class="stat"><div class="lbl">Avg daily net</div><div class="val ' + (forecast.avgDailyNet < 0 ? 'bad' : '') + '">' + kes(forecast.avgDailyNet) + '</div></div>' +
    '<div class="stat"><div class="lbl">Projected cash</div><div class="val ' + (forecast.projectedCash < 0 ? 'bad' : 'ok') + '">' + kes(forecast.projectedCash) + '</div><div class="sub">in ' + forecast.days + ' days</div></div>' +
    '</div>' +
    '<p class="muted" style="margin-top:8px;font-size:0.8rem">' + esc(forecast.explanation) + '</p></div>';

  // === Comparisons / prior period ===
  html += '<div class="card"><h3>Period comparison</h3><div class="table-scroll"><table class="tbl"><thead><tr><th>Metric</th><th class="n">Current</th><th class="n">Prior</th><th class="n">Change</th></tr></thead><tbody>' +
    '<tr><td>Net sales</td><td class="n">' + kes(fs.netRev) + '</td><td class="n">' + kes(fs.prev.netRev) + '</td><td class="n">' + (fs.deltas.netRev || '—') + '</td></tr>' +
    '<tr><td>Gross profit</td><td class="n">' + kes(fs.grossProfit) + '</td><td class="n">' + kes(fs.prev.grossProfit) + '</td><td class="n">' + (fs.deltas.grossProfit || '—') + '</td></tr>' +
    '<tr><td>Operating expenses</td><td class="n">' + kes(fs.expenses) + '</td><td class="n">' + kes(fs.prev.expenses) + '</td><td class="n">' + (fs.deltas.expenses || '—') + '</td></tr>' +
    '<tr><td>Net profit</td><td class="n">' + kes(fs.netProfit) + '</td><td class="n">' + kes(fs.prev.netProfit) + '</td><td class="n">' + (fs.deltas.netProfit || '—') + '</td></tr>' +
    '</tbody></table></div></div>';

  // === Explanations ===
  html += '<div class="card"><h3>How these figures are calculated</h3><ul class="muted cap-list">' +
    '<li><strong>Net sales</strong> — Sale totals minus discounts; refunded sales excluded.</li>' +
    '<li><strong>COGS</strong> — Units sold × cost recorded on each sale line (or current product cost).</li>' +
    '<li><strong>Gross profit / margin</strong> — Net sales − COGS; margin = gross profit ÷ net sales.</li>' +
    '<li><strong>Markup</strong> — Gross profit ÷ cost (different from margin).</li>' +
    '<li><strong>Contribution margin</strong> — Net sales − variable costs (COGS). Operating expenses treated as fixed.</li>' +
    '<li><strong>Break-even</strong> — Operating expenses ÷ gross margin ratio.</li>' +
    '<li><strong>Sales target</strong> — (Expenses + desired net profit) ÷ contribution margin ratio.</li>' +
    '<li><strong>Cash forecast</strong> — Current cash + estimated AR collections + projected daily net × days.</li>' +
    '</ul><p class="muted" style="margin-top:8px">These are management figures from your MarginPilot records, not formal accounting statements or tax advice.</p></div>';

  html += staffCard() + insightsCard();
  return html;
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


/* ===== Cloud sync (optional API) ===== */
function cloudToken() { try { return localStorage.getItem(CLOUD_TOKEN_KEY) || ''; } catch (e) { return ''; } }
function cloudMeta() { try { return JSON.parse(localStorage.getItem(CLOUD_META_KEY) || 'null'); } catch (e) { return null; } }
function setCloudSession(token, meta) {
  if (token) localStorage.setItem(CLOUD_TOKEN_KEY, token); else localStorage.removeItem(CLOUD_TOKEN_KEY);
  if (meta) localStorage.setItem(CLOUD_META_KEY, JSON.stringify(meta)); else localStorage.removeItem(CLOUD_META_KEY);
}
async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const t = cloudToken();
  if (t) headers.Authorization = 'Bearer ' + t;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  if (!res.ok) {
    const err = new Error((body && body.message) || (body && body.error) || ('HTTP ' + res.status));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}
async function cloudRegister(email, password, businessName, currency) {
  const data = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password, businessName, currency: currency || CC() }) });
  setCloudSession(data.token, { email: data.user.email, tenant: data.tenant, role: data.role });
  localStorage.setItem(CLOUD_REV_KEY, '0');
  return data;
}
async function cloudLogin(email, password) {
  const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  setCloudSession(data.token, { email: data.user.email, tenant: data.tenant, role: data.role });
  return data;
}
async function cloudLogout() {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch (e) {}
  setCloudSession('', null);
  localStorage.removeItem(CLOUD_REV_KEY);
}
async function cloudForgotPassword(email) {
  return api('/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email, origin: location.origin })
  });
}
async function cloudResetPassword(token, password) {
  return api('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, password })
  });
}
function snapshotPayload() {
  return {
    products: S.products, entries: S.entries, sales: S.sales, pays: S.pays, confs: S.confs,
    customers: S.customers, suppliers: S.suppliers || [], purchases: S.purchases || [],
    recurring: S.recurring || [], activity: S.activity, plans: S.plans, n: S.n,
    lockedThrough: S.lockedThrough, settings: S.settings, audit: S.audit || []
  };
}
async function cloudPush() {
  const baseRevision = Number(localStorage.getItem(CLOUD_REV_KEY) || 0);
  const data = await api('/api/sync/snapshot', {
    method: 'PUT',
    body: JSON.stringify({ baseRevision, payload: snapshotPayload() })
  });
  localStorage.setItem(CLOUD_REV_KEY, String(data.revision));
  return data;
}
async function cloudPull() {
  const data = await api('/api/sync/snapshot');
  if (!data.payload) throw new Error('Empty snapshot');
  const p = data.payload;
  S.products = p.products || [];
  S.entries = p.entries || [];
  S.sales = p.sales || [];
  S.pays = p.pays || [];
  S.confs = p.confs || [];
  S.customers = p.customers || [];
  S.suppliers = p.suppliers || [];
  S.purchases = p.purchases || [];
  S.recurring = p.recurring || [];
  S.activity = p.activity || [];
  S.plans = p.plans || S.plans;
  S.n = p.n || S.n;
  S.lockedThrough = p.lockedThrough || null;
  S.settings = Object.assign(S.settings || {}, p.settings || {});
  S.audit = p.audit || [];
  localStorage.setItem(CLOUD_REV_KEY, String(data.revision));
  save();
  return data;
}
function cloudCard() {
  const meta = cloudMeta();
  const tok = cloudToken();
  if (tok && meta) {
    return '<div class="card"><h3>Cloud sync</h3>' +
      '<p class="ok">Signed in as <strong>' + esc(meta.email) + '</strong></p>' +
      '<p class="muted">Business: ' + esc(meta.tenant && meta.tenant.name) + ' · ' + esc(meta.tenant && meta.tenant.currency) +
      ' · revision ' + esc(localStorage.getItem(CLOUD_REV_KEY) || '0') + '</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button type="button" class="btn btn-primary btn-sm" data-cloudpush="1">Push this device</button>' +
      '<button type="button" class="btn btn-secondary btn-sm" data-cloudpull="1">Pull to this device</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-cloudlogout="1">Disconnect</button></div>' +
      '<p class="lock-note">Push uploads a snapshot of this browser\'s records. Pull replaces local data with the cloud snapshot. Resolve conflicts by pulling first if push fails.</p></div>';
  }
  return '<div class="card"><h3>Cloud sync</h3>' +
    '<p class="muted">Optional. Works when the server has PostgreSQL configured. Your data still lives on this device until you push.</p>' +
    '<div class="grid"><label class="field"><span>Email</span><input id="cloud-email" type="email" autocomplete="username"></label>' +
    '<label class="field"><span>Password (8+)</span><input id="cloud-pw" type="password" autocomplete="current-password"></label></div>' +
    '<label class="field"><span>Business name (register only)</span><input id="cloud-biz" placeholder="' + esc(S.settings.businessName || '') + '"></label>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button type="button" class="btn btn-primary btn-sm" data-cloudlogin="1">Log in</button>' +
    '<button type="button" class="btn btn-secondary btn-sm" data-cloudreg="1">Register &amp; connect</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-cloudforgot="1">Email password reset</button></div>' +
    '<p class="lock-note">Requires <code>DATABASE_URL</code> + migrations. Email reset also needs <code>RESEND_API_KEY</code> or SMTP env vars.</p></div>';
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
    '<label class="field"><span>Type of business</span><select id="biz-type">' + typeOptions(S.settings.bizType) + '</select></label>' +
    (S.settings.bizType && BIZ[S.settings.bizType].items.length ? '<button type="button" class="btn btn-secondary btn-sm" data-seed="1">Add starter items for this business</button>' : '') +
    '<label class="field"><span>Till number</span><input id="biz-till" value="' + esc(S.settings.till || '') + '" placeholder="Not connected yet"></label>' +
    '<label class="field"><span>Paybill</span><input id="biz-paybill" value="' + esc(S.settings.paybill || '') + '" placeholder="Not connected yet"></label>' +
    '<p class="muted" style="font-size:0.82rem">MarginPilot never holds customer money. Payments go to your Till or Paybill.</p></div>' +
    currencyCard() + accountCard() +
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
    subCard() + cloudCard() + backupCard() + notifCard() +
    '<div class="card"><h3>Install & data</h3>' + (isStandalone() ? '<p class="ok">Installed on this device.</p>' : '<button type="button" class="btn btn-primary" data-install="1">Install app on this device</button>') +
    '<p class="muted" style="margin-top:8px">Works on Android, iPhone/iPad, Windows, Mac and Chromebook. Data stays on this device (key <code>marginpilot.v1</code>). <a href="privacy.html" target="_blank">Privacy & terms</a></p></div>';
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
    const sale = { id: sid, ts: Date.now(), total, method: meth, items, discount: discAmt, refunded: false, by: (sessionUser() || {}).name || '' };
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
      '<a class="btn btn-secondary" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent(modal.text) + '">WhatsApp</a>' +
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
  if (renderAuth()) return;
  if (renderSubLock()) return;
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
  try {
    main.innerHTML = (views[tab] || viewHome)();
  } catch (err) {
    console.error('View render error', tab, err);
    main.innerHTML = '<div class="card"><h2>Something went wrong on this screen</h2><p class="muted">' +
      String(err && err.message || err) + '</p><button type="button" class="btn btn-primary" data-goto="home">Go to Home</button>' +
      '<button type="button" class="btn btn-secondary" data-goto="more" style="margin-left:8px">More</button></div>';
  }
  try { updateOnline(); } catch (e) {}
  try { renderOverlays(); } catch (e) { console.error(e); }
  try { bindMain(main); } catch (e) { console.error(e); }
}

function bindMain(main) {
  main.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => { period = b.getAttribute('data-period'); render(); }));
  main.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => setTab(b.getAttribute('data-goto'))));
  main.querySelectorAll('[data-homeperiod]').forEach((b) => b.addEventListener('click', () => {
    homePeriod = b.getAttribute('data-homeperiod') || 'today';
    render();
  }));
  main.querySelectorAll('[data-reportperiod]').forEach((b) => b.addEventListener('click', () => {
    reportPeriod = b.getAttribute('data-reportperiod') || 'month';
    render();
  }));
  main.querySelector('[data-discimpact]')?.addEventListener('click', () => {
    const amt = cents(document.getElementById('di-amt')?.value);
    const pct = parseFloat(document.getElementById('di-pct')?.value);
    const out = document.getElementById('di-out');
    if (!out) return;
    if (!Number.isFinite(amt) || amt <= 0) { out.innerHTML = '<p class="bad">Enter a valid sale amount.</p>'; return; }
    if (!Number.isFinite(pct) || pct < 0) { out.innerHTML = '<p class="bad">Enter a valid discount %.</p>'; return; }
    const r = discountImpact(amt, pct);
    out.innerHTML = '<div class="row"><span>Discount amount</span><b class="mono">' + kes(r.discountAmount) + '</b></div>' +
      '<div class="row"><span>Net sales after discount</span><b class="mono">' + kes(r.netSales) + '</b></div>' +
      '<div class="row"><span>Approx. gross profit impact</span><b class="mono ' + (r.profitImpact < 0 ? 'bad' : '') + '">' + kes(r.profitImpact) + '</b></div>' +
      '<p class="muted" style="margin-top:6px;font-size:0.8rem">' + esc(r.explanation) + '</p>';
  });
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
    const id = 'p' + Date.now(), svc = !!document.getElementById('psv')?.checked;
    S.products.push({ id, name, price, cost: svc ? 0 : cost, qty: svc ? 99999 : q, barcode, svc, exp: document.getElementById('pe')?.value || null });
    if (q > 0 && !svc) { try { post('Opening stock: ' + name, [{ a: 'inv', dr: q * cost, cr: 0 }, { a: 'eq', dr: 0, cr: q * cost }]); } catch (e) { toast(e.message); return; } }
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
      p.qty = nq; p.starter = false; logActivity('stock_adjust', p.name + ' → ' + nq); save(); toast('Stock updated.'); render();
    } catch (e) { toast(e.message); }
  }));
  main.querySelector('[data-importstmt]')?.addEventListener('click', importStatement);
  main.querySelector('[data-addexpense]')?.addEventListener('click', () => {
    if (!can('ledger')) return;
    const d = document.getElementById('ed')?.value.trim();
    const a = cents(document.getElementById('ea')?.value);
    if (!d || isNaN(a) || a <= 0) { toast('Enter description and amount.'); return; }
    try { post('Expense: ' + d, [{ a: 'exp', dr: a, cr: 0 }, { a: 'cash', dr: 0, cr: a }]); logActivity('expense', d); auditLog('expense', d, { amount: a }); save(); toast('Expense saved.'); render(); }
    catch (e) { toast(e.message); }
  });
  main.querySelector('[data-addsupplier]')?.addEventListener('click', () => {
    if (!can('money')) return;
    const name = document.getElementById('sup-name')?.value.trim();
    if (!name) { toast('Enter supplier name.'); return; }
    S.suppliers = S.suppliers || [];
    S.suppliers.push({ id: uid(), name, phone: (document.getElementById('sup-phone')?.value || '').trim(), notes: (document.getElementById('sup-notes')?.value || '').trim(), ts: Date.now() });
    logActivity('supplier_add', name); auditLog('supplier_add', name); save(); toast('Supplier added.'); render();
  });
  main.querySelectorAll('[data-rmsupplier]').forEach((b) => b.addEventListener('click', () => {
    if (!can('money')) return;
    const id = b.getAttribute('data-rmsupplier');
    const s = (S.suppliers || []).find((x) => x.id === id);
    S.suppliers = (S.suppliers || []).filter((x) => x.id !== id);
    logActivity('supplier_rm', s ? s.name : id); save(); toast('Supplier removed.'); render();
  }));
  main.querySelector('[data-addpurchase]')?.addEventListener('click', () => {
    if (!can('money')) return;
    const desc = document.getElementById('pur-desc')?.value.trim();
    const amt = cents(document.getElementById('pur-amt')?.value);
    const pay = document.getElementById('pur-pay')?.value || 'cash';
    const supplier = (document.getElementById('pur-sup')?.value || '').trim();
    if (!desc || isNaN(amt) || amt <= 0) { toast('Enter description and amount.'); return; }
    try {
      if (pay === 'cash') post('Purchase: ' + desc, [{ a: 'inv', dr: amt, cr: 0 }, { a: 'cash', dr: 0, cr: amt }]);
      else if (pay === 'mpesa') post('Purchase: ' + desc, [{ a: 'inv', dr: amt, cr: 0 }, { a: 'till', dr: 0, cr: amt }]);
      else {
        // credit purchase — we don't have AP account yet; record as equity reduction note via expense+memo pattern
        // Use inv debit and equity credit as "owner funded payable" placeholder is wrong.
        // Record purchase on credit as inventory increase funded by a memo payable using eq (documented limitation).
        post('Purchase on credit: ' + desc, [{ a: 'inv', dr: amt, cr: 0 }, { a: 'eq', dr: 0, cr: amt }]);
      }
      S.purchases = S.purchases || [];
      S.purchases.push({ id: uid(), desc, amount: amt, pay, supplier, currency: CC(), originalAmount: amt, ts: Date.now() });
      // auto-add supplier name if new
      if (supplier && !(S.suppliers || []).some((s) => s.name.toLowerCase() === supplier.toLowerCase())) {
        S.suppliers = S.suppliers || [];
        S.suppliers.push({ id: uid(), name: supplier, phone: '', notes: '', ts: Date.now() });
      }
      logActivity('purchase', desc); auditLog('purchase', desc, { amount: amt, pay }); save(); toast('Purchase saved.'); render();
    } catch (e) { toast(e.message); }
  });
  main.querySelector('[data-addrecurring]')?.addEventListener('click', () => {
    if (!can('ledger') && !can('money')) return;
    const name = document.getElementById('rec-name')?.value.trim();
    const amt = cents(document.getElementById('rec-amt')?.value);
    const days = parseInt(document.getElementById('rec-days')?.value, 10) || 30;
    if (!name || isNaN(amt) || amt <= 0) { toast('Enter name and amount.'); return; }
    const next = new Date(); next.setDate(next.getDate() + days);
    S.recurring = S.recurring || [];
    S.recurring.push({ id: uid(), name, amount: amt, everyDays: days, nextDue: next.toISOString().slice(0, 10), paused: false, currency: CC() });
    logActivity('recurring_add', name); save(); toast('Recurring expense added.'); render();
  });
  main.querySelectorAll('[data-postrecurring]').forEach((b) => b.addEventListener('click', () => {
    const id = b.getAttribute('data-postrecurring');
    const r = (S.recurring || []).find((x) => x.id === id);
    if (!r) return;
    try {
      post('Expense: ' + r.name + ' (recurring)', [{ a: 'exp', dr: r.amount, cr: 0 }, { a: 'cash', dr: 0, cr: r.amount }]);
      const next = new Date(); next.setDate(next.getDate() + (r.everyDays || 30));
      r.nextDue = next.toISOString().slice(0, 10);
      logActivity('recurring_post', r.name); auditLog('recurring_post', r.name, { amount: r.amount }); save(); toast('Expense recorded; next due ' + r.nextDue); render();
    } catch (e) { toast(e.message); }
  }));
  main.querySelectorAll('[data-rmrecurring]').forEach((b) => b.addEventListener('click', () => {
    const id = b.getAttribute('data-rmrecurring');
    S.recurring = (S.recurring || []).filter((x) => x.id !== id);
    save(); toast('Recurring removed.'); render();
  }));
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
  document.getElementById('msg-lang')?.addEventListener('change', (e) => { S.settings.msgLang = e.target.value; save(); render(); });
  main.querySelectorAll('[data-setphone]').forEach((b) => b.addEventListener('click', () => {
    const c = S.customers.find((x) => x.id === b.getAttribute('data-setphone')); if (!c) return;
    const v = prompt('WhatsApp number for ' + c.name + ' (e.g. 0712345678):', c.phone || ''); if (v === null) return;
    if (v.trim() && !waNum(v)) { toast('That number looks too short.'); return; }
    c.phone = v.trim(); save(); render();
  }));
  main.querySelector('[data-closeday]')?.addEventListener('click', () => {
    const v = prompt('Count the cash in your drawer. How much is there (' + CC() + ')?'); if (v === null) return;
    const counted = cents(v); if (isNaN(counted) || counted < 0) { toast('Enter a valid amount.'); return; }
    const expected = bal('cash'), diff = counted - expected;
    S.settings.closes = (S.settings.closes || []).concat([{ ts: Date.now(), expected, counted, diff }]).slice(-60); logActivity('close_day', String(diff)); save();
    toast(diff === 0 ? 'Cash matches. Well done!' : (diff < 0 ? 'Cash is SHORT by ' : 'Cash is OVER by ') + kes(Math.abs(diff))); render();
  });
  main.querySelectorAll('[data-setexp]').forEach((b) => b.addEventListener('click', () => {
    const p = S.products.find((x) => x.id === b.getAttribute('data-setexp')); if (!p) return;
    const v = prompt('Expiry date for ' + p.name + ' (YYYY-MM-DD, leave blank to clear):', p.exp || ''); if (v === null) return;
    if (v.trim() && !(/^\d{4}-\d{2}-\d{2}$/.test(v.trim()) && !isNaN(Date.parse(v.trim())))) { toast('Use the format YYYY-MM-DD, e.g. 2027-03-31.'); return; }
    p.exp = v.trim() || null; save(); render();
  }));
  main.querySelector('[data-setsupplier]')?.addEventListener('click', () => {
    const v = prompt('Supplier WhatsApp number (e.g. 0712345678):', S.settings.supplier || ''); if (v === null) return;
    if (v.trim() && !waNum(v)) { toast('That number looks too short.'); return; }
    S.settings.supplier = v.trim(); save(); render();
  });
  document.getElementById('biz-type')?.addEventListener('change', (e) => { S.settings.bizType = e.target.value; save(); render(); });
  main.querySelector('[data-seed]')?.addEventListener('click', () => { const n = seedStarter(S.settings.bizType); save(); toast(n ? n + ' starter items added. Edit prices to match yours.' : 'Starter items already added.'); render(); });
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
  main.querySelector('[data-lic]')?.addEventListener('click', async () => {
    const err = await applyLicense(document.getElementById('lic-code2').value);
    toast(err || 'Subscription extended. Thank you!'); if (!err) render();
  });
  main.querySelectorAll('[data-backup]').forEach((b) => b.addEventListener('click', downloadBackup));
  main.querySelector('[data-csv]')?.addEventListener('click', downloadCsv);
  main.querySelector('[data-exportcsv]')?.addEventListener('click', downloadCsv);
  main.querySelector('[data-profitreport]')?.addEventListener('click', downloadProfitReport);
  document.getElementById('restore-file')?.addEventListener('change', restoreBackup);
  main.querySelector('[data-cloudlogin]')?.addEventListener('click', async () => {
    const email = document.getElementById('cloud-email')?.value.trim();
    const pw = document.getElementById('cloud-pw')?.value || '';
    if (!email || !pw) { toast('Enter email and password.'); return; }
    try { await cloudLogin(email, pw); toast('Connected to cloud.'); render(); }
    catch (e) { toast(e.body && e.body.error === 'database_unavailable' ? 'Server has no database yet.' : (e.message || 'Login failed')); }
  });
  main.querySelector('[data-cloudforgot]')?.addEventListener('click', async () => {
    const email = document.getElementById('cloud-email')?.value.trim();
    if (!email || !email.includes('@')) { toast('Enter your cloud account email first.'); return; }
    try {
      const r = await cloudForgotPassword(email);
      toast(r.message || 'If registered, a reset link was sent.');
    } catch (e) {
      toast(e.body && e.body.error === 'database_unavailable'
        ? 'Server database required for email reset.'
        : (e.message || 'Request failed'));
    }
  });
  main.querySelector('[data-cloudreg]')?.addEventListener('click', async () => {
    const email = document.getElementById('cloud-email')?.value.trim();
    const pw = document.getElementById('cloud-pw')?.value || '';
    const biz = document.getElementById('cloud-biz')?.value.trim() || S.settings.businessName || 'My business';
    if (!email || pw.length < 8) { toast('Email and password (8+) required.'); return; }
    try { await cloudRegister(email, pw, biz, CC()); toast('Registered and connected.'); render(); }
    catch (e) { toast(e.body && e.body.error === 'email_taken' ? 'Email already registered.' : (e.message || 'Register failed')); }
  });
  main.querySelector('[data-cloudlogout]')?.addEventListener('click', async () => {
    await cloudLogout(); toast('Cloud disconnected.'); render();
  });
  main.querySelector('[data-cloudpush]')?.addEventListener('click', async () => {
    try { const d = await cloudPush(); toast('Pushed revision ' + d.revision); render(); }
    catch (e) {
      if (e.status === 409) toast('Conflict — pull first, then push again.');
      else toast(e.message || 'Push failed');
    }
  });
  main.querySelector('[data-cloudpull]')?.addEventListener('click', async () => {
    if (!confirm('Pull replaces data on THIS device with the cloud snapshot. Continue?')) return;
    try { const d = await cloudPull(); toast('Pulled revision ' + d.revision); render(); }
    catch (e) { toast(e.status === 404 ? 'No cloud snapshot yet — push first.' : (e.message || 'Pull failed')); }
  });
  main.querySelector('[data-logout]')?.addEventListener('click', () => { logActivity('logout', ''); localStorage.removeItem(SESS_KEY); authMode = null; render(); });
  main.querySelector('[data-gotoauth]')?.addEventListener('click', () => {
    disableGuestMode();
    authMode = (authGet().users || []).length ? 'login' : 'signup';
    render();
  });
  main.querySelector('[data-rotate-recovery]')?.addEventListener('click', async () => {
    const u = sessionUser();
    if (!u || u.id === 'guest' || u.id === 'open') return;
    if (!window.crypto || !crypto.subtle) { toast('Needs HTTPS or localhost.'); return; }
    const a = authGet();
    const real = a.users.find((x) => x.id === u.id);
    if (!real) return;
    if (real.recoveryHash && !confirm('This replaces your old recovery code. Continue?')) return;
    const code = generateRecoveryCode();
    real.recoverySalt = uid();
    real.recoveryHash = await hashRecoveryCode(code, real.recoverySalt);
    authSet(a);
    logActivity('recovery_code_rotated', real.name);
    auditLog('recovery_code_rotated', real.name);
    pendingRecoveryCode = code;
    render();
  });
  main.querySelector('[data-addstaff]')?.addEventListener('click', async () => {
    if (!can('roles')) return;
    const n = document.getElementById('st-name')?.value.trim(), r = document.getElementById('st-role')?.value, pw = document.getElementById('st-pw')?.value || '';
    if (!n || pw.length < 4) { toast('Enter a name and a password of 4+ characters.'); return; }
    const a = authGet();
    if (a.users.some((u) => u.name.toLowerCase() === n.toLowerCase())) { toast('That name is already used.'); return; }
    const salt = uid(); a.users.push({ id: uid(), name: n, role: r, salt, hash: await hashPw(pw, salt) });
    authSet(a); logActivity('add_staff', n + ' (' + r + ')'); toast('Staff added.'); render();
  });
  main.querySelectorAll('[data-rmstaff]').forEach((b) => b.addEventListener('click', () => {
    if (!can('roles')) return;
    const a = authGet(); a.users = a.users.filter((u) => u.id !== b.getAttribute('data-rmstaff')); authSet(a); logActivity('remove_staff', ''); render();
  }));
  document.getElementById('n-hour')?.addEventListener('change', (e) => { const p = nprefs(); p.hour = parseInt(e.target.value, 10); nsave(p); });
  document.getElementById('n-qstart')?.addEventListener('change', (e) => { const p = nprefs(); p.quietStart = parseInt(e.target.value, 10); nsave(p); });
  document.getElementById('n-qend')?.addEventListener('change', (e) => { const p = nprefs(); p.quietEnd = parseInt(e.target.value, 10); nsave(p); });
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

/* ===== Accounts (stored on this device) ===== */
const AUTH_KEY = 'marginpilot.auth', SESS_KEY = 'marginpilot.session', SESS_ACT_KEY = 'marginpilot.sessAct', SESSION_TIMEOUT_MS = 8 * 3600e3;
let authMode = null, authFails = 0, authBlockUntil = 0;
function authGet() { try { return JSON.parse(localStorage.getItem(AUTH_KEY)) || { users: [] }; } catch (e) { return { users: [] }; } }
function authSet(a) { localStorage.setItem(AUTH_KEY, JSON.stringify(a)); }
function authRequired() {
  // Local accounts are optional. Only require login when users exist AND guest mode is off.
  try {
    if (localStorage.getItem('marginpilot.guest') === '1') return false;
  } catch (e) {}
  return (authGet().users || []).length > 0;
}
function enableGuestMode() {
  try {
    localStorage.setItem('marginpilot.guest', '1');
    localStorage.removeItem(SESS_KEY);
    localStorage.setItem(ROLE_KEY, 'owner');
  } catch (e) {}
}
function disableGuestMode() {
  try { localStorage.removeItem('marginpilot.guest'); } catch (e) {}
}
function sessionUser() {
  // Guest / open mode: treat as local owner so the app is usable with no login.
  try {
    if (localStorage.getItem('marginpilot.guest') === '1') {
      return { id: 'guest', name: 'Local user', role: 'owner' };
    }
  } catch (e) {}
  const id = localStorage.getItem(SESS_KEY);
  const u = authGet().users.find((x) => x.id === id) || null;
  if (u) {
    localStorage.setItem(ROLE_KEY, u.role);
    const last = Number(localStorage.getItem(SESS_ACT_KEY) || 0);
    if (last && Date.now() - last > SESSION_TIMEOUT_MS) {
      localStorage.removeItem(SESS_KEY);
      logActivity('session_timeout', u.name || '');
      return null;
    }
    localStorage.setItem(SESS_ACT_KEY, String(Date.now()));
  }
  // No accounts configured → open access as owner
  if (!(authGet().users || []).length) {
    return { id: 'open', name: 'Owner', role: 'owner' };
  }
  return u;
}
async function hashPw(pw, salt) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 150000, hash: 'SHA-256' }, k, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}
function generateRecoveryCode() {
  // 12-char code in groups: XXXX-XXXX-XXXX (uppercase alphanumeric, no ambiguous chars)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let raw = '';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 12; i++) raw += alphabet[bytes[i] % alphabet.length];
  return raw.slice(0, 4) + '-' + raw.slice(4, 8) + '-' + raw.slice(8, 12);
}
function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
async function hashRecoveryCode(code, salt) {
  return hashPw(normalizeRecoveryCode(code), salt);
}
async function verifyRecoveryCode(user, code) {
  if (!user || !user.recoveryHash || !user.recoverySalt) return false;
  const h = await hashRecoveryCode(code, user.recoverySalt);
  return h === user.recoveryHash;
}
let pendingRecoveryCode = null; // shown once after signup or rotate
function renderAuth() {
  const el = document.getElementById('auth'); if (!el) return false;
  const a = authGet();
  const mustLogin = authRequired() && !sessionUser();
  const showRecoveryOnce = !!pendingRecoveryCode;
  const forceAuthUi = mustLogin || showRecoveryOnce || authMode === 'email_reset' || authMode === 'email_forgot';
  document.body.classList.toggle('locked', forceAuthUi);
  el.hidden = !forceAuthUi;
  if (!forceAuthUi) return false;

  const mode = authMode || (a.users.length ? 'login' : 'signup');
  const f = (id, l, t, extra) => '<label class="field"><span>' + l + '</span><input id="' + id + '" type="' + t + '" ' + (extra || '') + '></label>';
  const secure = !!(window.crypto && crypto.subtle);
  const head = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;color:var(--em);font-weight:700;font-size:1.1rem"><svg width="28" height="28" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="currentColor"/><path d="M8 24V8h3.5l4.5 8 4.5-8H24v16h-3.2V13.5L16.8 21h-1.6L11.2 13.5V24H8z" fill="#fff"/></svg>MarginPilot</div>';
  let body;

  if (showRecoveryOnce) {
    body = '<h2>Save your recovery code</h2>' +
      '<p class="muted">This is the <strong>only</strong> way to reset your password if you forget it. Store it somewhere safe (not only on this phone).</p>' +
      '<div class="card" style="background:var(--surface-2);text-align:center;font-size:1.25rem;font-weight:700;letter-spacing:0.06em;padding:16px;margin:12px 0">' + esc(pendingRecoveryCode) + '</div>' +
      '<button type="button" class="btn btn-secondary btn-block" id="au-copy-recovery">Copy code</button>' +
      '<button type="button" class="btn btn-primary btn-block" id="au-recovery-done" style="margin-top:8px">I saved it — continue</button>' +
      '<p class="lock-note">You will not see this code again.</p>';
    el.innerHTML = '<div class="card" style="width:100%;max-width:400px;margin:auto">' + head + body + '</div>';
    document.getElementById('au-copy-recovery')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pendingRecoveryCode);
        toast('Recovery code copied.');
      } catch (e) {
        toast('Copy failed — write the code down.');
      }
    });
    document.getElementById('au-recovery-done')?.addEventListener('click', () => {
      pendingRecoveryCode = null;
      authMode = null;
      tab = 'home';
      render();
    });
    return true;
  }

  if (!secure) {
    body = '<h2>Open in a secure browser</h2><p class="muted">Password accounts need HTTPS (or localhost). You can continue without an account — your data stays on this device.</p>' +
      '<button type="button" class="btn btn-primary btn-block" id="au-guest">Continue without account</button>';
  } else if (mode === 'signup') {
    body = '<h2>Create an account (optional)</h2><p class="muted">Protect this device with a password, or skip and use the app immediately. You will get a recovery code to reset the password later.</p>' +
      f('au-biz', 'Business name', 'text', 'value="' + esc(S.settings.businessName || '') + '" autocomplete="organization"') +
      f('au-name', 'Your name', 'text', 'autocomplete="name"') +
      '<label class="field"><span>Currency</span><select id="au-cc">' +
      Object.keys(CURRENCIES).map((c) => '<option value="' + c + '"' + (CC() === c ? ' selected' : '') + '>' + c + ' — ' + CURRENCIES[c].country + '</option>').join('') +
      '</select></label>' +
      f('au-pw', 'Password (6+)', 'password', 'autocomplete="new-password"') +
      f('au-pw2', 'Confirm password', 'password', 'autocomplete="new-password"') +
      '<button type="button" class="btn btn-primary btn-block" id="au-go">Create account</button>' +
      '<button type="button" class="btn btn-secondary btn-block" id="au-guest" style="margin-top:8px">Continue without account</button>' +
      (a.users.length ? '<p style="text-align:center;margin-top:10px"><button type="button" class="btn btn-ghost btn-sm" id="au-switch">I already have an account</button></p>' : '');
  } else if (mode === 'email_forgot') {
    body = '<h2>Reset via email</h2>' +
      '<p class="muted">For <strong>cloud accounts</strong> registered on the server. We will email a one-hour reset link if the address is registered.</p>' +
      f('au-email', 'Email', 'email', 'autocomplete="username"') +
      '<button type="button" class="btn btn-primary btn-block" id="au-go">Send reset link</button>' +
      '<button type="button" class="btn btn-ghost btn-block" id="au-switch" style="margin-top:8px">Back</button>' +
      '<p class="lock-note">Local device accounts cannot use email reset — use a recovery code instead, or Continue without account.</p>';
  } else if (mode === 'email_reset') {
    body = '<h2>Choose a new password</h2>' +
      '<p class="muted">Enter a new password for your cloud account. This uses the link from your email.</p>' +
      f('au-pw', 'New password (8+)', 'password', 'autocomplete="new-password"') +
      f('au-pw2', 'Confirm password', 'password', 'autocomplete="new-password"') +
      '<button type="button" class="btn btn-primary btn-block" id="au-go">Update password</button>' +
      '<button type="button" class="btn btn-ghost btn-block" id="au-switch" style="margin-top:8px">Back to log in</button>';
  } else if (mode === 'reset') {
    const owners = a.users.filter((u) => u.role === 'owner' || u.recoveryHash);
    body = '<h2>Reset with recovery code</h2>' +
      '<p class="muted">For <strong>local device accounts</strong>. Enter the recovery code saved at signup, then a new password. Data is not deleted.</p>' +
      '<label class="field"><span>Account</span><select id="au-user">' +
      (owners.length ? owners : a.users).map((u) => '<option value="' + u.id + '">' + esc(u.name) + (u.recoveryHash ? '' : ' · no recovery code') + '</option>').join('') +
      '</select></label>' +
      f('au-recovery', 'Recovery code', 'text', 'placeholder="XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false"') +
      f('au-pw', 'New password (6+)', 'password', 'autocomplete="new-password"') +
      f('au-pw2', 'Confirm new password', 'password', 'autocomplete="new-password"') +
      '<button type="button" class="btn btn-primary btn-block" id="au-go">Reset password</button>' +
      '<button type="button" class="btn btn-ghost btn-block" id="au-email-forgot" style="margin-top:8px">Use email instead (cloud)</button>' +
      '<button type="button" class="btn btn-ghost btn-block" id="au-switch" style="margin-top:4px">Back to log in</button>' +
      '<button type="button" class="btn btn-secondary btn-block" id="au-guest" style="margin-top:8px">Continue without account</button>';
  } else {
    body = '<h2>Log in</h2>' +
      '<label class="field"><span>Account</span><select id="au-user">' + a.users.map((u) => '<option value="' + u.id + '">' + esc(u.name) + ' · ' + esc((ROLES[u.role] || {}).label || u.role) + '</option>').join('') + '</select></label>' +
      f('au-pw', 'Password', 'password', 'autocomplete="current-password"') +
      '<button type="button" class="btn btn-primary btn-block" id="au-go">Log in</button>' +
      '<p style="text-align:center;margin-top:10px">' +
      '<button type="button" class="btn btn-ghost btn-sm" id="au-forgot">Recovery code</button> · ' +
      '<button type="button" class="btn btn-ghost btn-sm" id="au-email-forgot">Email reset</button></p>' +
      '<button type="button" class="btn btn-secondary btn-block" id="au-guest" style="margin-top:4px">Continue without account</button>' +
      '<p class="lock-note">Local accounts: recovery code. Cloud accounts: email reset (server + email provider required).</p>';
  }

  el.innerHTML = '<div class="card" style="width:100%;max-width:400px;margin:auto">' + head + body + '</div>';

  const goGuest = () => {
    enableGuestMode();
    authMode = null;
    pendingRecoveryCode = null;
    tab = 'home';
    toast('Continuing without account — data stays on this device.');
    render();
  };
  document.getElementById('au-guest')?.addEventListener('click', goGuest);
  document.getElementById('au-switch')?.addEventListener('click', () => { authMode = 'login'; render(); });
  document.getElementById('au-forgot')?.addEventListener('click', () => { authMode = 'reset'; render(); });
  document.getElementById('au-email-forgot')?.addEventListener('click', () => { authMode = 'email_forgot'; render(); });

  const go = async () => {
    if (mode === 'email_forgot') {
      const email = document.getElementById('au-email')?.value.trim() || '';
      if (!email || !email.includes('@')) { toast('Enter a valid email.'); return; }
      try {
        const r = await cloudForgotPassword(email);
        toast(r.message || 'If registered, a reset link was sent.');
        authMode = 'login';
        render();
      } catch (e) {
        toast(e.body && e.body.error === 'database_unavailable'
          ? 'Email reset needs the server database. Use a recovery code for local accounts.'
          : (e.message || 'Could not send reset email'));
      }
      return;
    }
    if (mode === 'email_reset') {
      const token = sessionStorage.getItem('marginpilot.resetToken') || '';
      const pw = document.getElementById('au-pw')?.value || '';
      if (!token) { toast('Missing reset token. Open the link from your email again.'); return; }
      if (pw.length < 8) { toast('Password needs 8+ characters.'); return; }
      if (pw !== (document.getElementById('au-pw2')?.value || '')) { toast('Passwords do not match.'); return; }
      try {
        const r = await cloudResetPassword(token, pw);
        sessionStorage.removeItem('marginpilot.resetToken');
        toast(r.message || 'Password updated. Log in with your new password.');
        authMode = 'login';
        // Prefer cloud login card - stay on local login if only local users
        render();
      } catch (e) {
        toast((e.body && e.body.message) || e.message || 'Reset failed');
      }
      return;
    }
    if (!secure) { toast('Open the app from https:// or localhost to use passwords.'); return; }
    const pw = document.getElementById('au-pw')?.value || '';

    if (mode === 'signup') {
      const biz = document.getElementById('au-biz')?.value.trim();
      const nm = document.getElementById('au-name')?.value.trim();
      if (!biz || !nm) { toast('Enter business and your name.'); return; }
      if (pw.length < 6) { toast('Password needs 6+ characters.'); return; }
      if (pw !== (document.getElementById('au-pw2')?.value || '')) { toast('Passwords do not match.'); return; }
      if ((a.users || []).length) { toast('An account already exists. Log in or reset password.'); authMode = 'login'; render(); return; }
      const salt = uid();
      const recoveryCode = generateRecoveryCode();
      const recoverySalt = uid();
      const u = {
        id: uid(), name: nm, role: 'owner', salt,
        hash: await hashPw(pw, salt),
        recoverySalt,
        recoveryHash: await hashRecoveryCode(recoveryCode, recoverySalt)
      };
      a.users = [u];
      authSet(a);
      disableGuestMode();
      S.settings.businessName = biz;
      S.settings.currency = document.getElementById('au-cc')?.value || CC();
      localStorage.setItem(SESS_KEY, u.id);
      localStorage.setItem(ROLE_KEY, 'owner');
      localStorage.setItem(SESS_ACT_KEY, String(Date.now()));
      logActivity('signup', nm);
      auditLog('signup', nm);
      save();
      pendingRecoveryCode = recoveryCode;
      authMode = null;
      render();
      return;
    }

    if (mode === 'reset') {
      const id = document.getElementById('au-user')?.value;
      const u = a.users.find((x) => x.id === id);
      const code = document.getElementById('au-recovery')?.value || '';
      if (!u) { toast('Select an account.'); return; }
      if (!u.recoveryHash) {
        toast('This account has no recovery code. Continue without account, then create a new optional login under Account.');
        return;
      }
      if (pw.length < 6) { toast('Password needs 6+ characters.'); return; }
      if (pw !== (document.getElementById('au-pw2')?.value || '')) { toast('Passwords do not match.'); return; }
      if (!(await verifyRecoveryCode(u, code))) {
        authFails++;
        if (authFails >= 5) {
          authBlockUntil = Date.now() + 30000;
          authFails = 0;
          toast('Too many attempts. Wait 30s.');
        } else toast('Recovery code not recognised.');
        return;
      }
      if (Date.now() < authBlockUntil) {
        toast('Too many attempts. Wait ' + Math.ceil((authBlockUntil - Date.now()) / 1000) + 's.');
        return;
      }
      const salt = uid();
      u.salt = salt;
      u.hash = await hashPw(pw, salt);
      // rotate recovery code after successful reset
      const recoveryCode = generateRecoveryCode();
      u.recoverySalt = uid();
      u.recoveryHash = await hashRecoveryCode(recoveryCode, u.recoverySalt);
      authSet(a);
      disableGuestMode();
      localStorage.setItem(SESS_KEY, u.id);
      localStorage.setItem(ROLE_KEY, u.role);
      localStorage.setItem(SESS_ACT_KEY, String(Date.now()));
      logActivity('password_reset', u.name);
      auditLog('password_reset', u.name);
      authFails = 0;
      pendingRecoveryCode = recoveryCode;
      authMode = null;
      toast('Password updated. Save your new recovery code.');
      render();
      return;
    }

    // login
    if (Date.now() < authBlockUntil) {
      toast('Too many attempts. Wait ' + Math.ceil((authBlockUntil - Date.now()) / 1000) + 's.');
      return;
    }
    const id = document.getElementById('au-user')?.value;
    const u = a.users.find((x) => x.id === id);
    if (u && (await hashPw(pw, u.salt)) === u.hash) {
      authFails = 0;
      disableGuestMode();
      localStorage.setItem(SESS_KEY, u.id);
      localStorage.setItem(ROLE_KEY, u.role);
      localStorage.setItem(SESS_ACT_KEY, String(Date.now()));
      logActivity('login', '');
      authMode = null;
      tab = 'home';
      render();
    } else {
      authFails++;
      if (authFails >= 5) {
        authBlockUntil = Date.now() + 30000;
        authFails = 0;
        toast('Too many attempts. Wait 30s, reset password, or continue without account.');
      } else toast('Wrong password.');
    }
  };
  document.getElementById('au-go')?.addEventListener('click', go);
  document.getElementById('au-pw')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  document.getElementById('au-recovery')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  return true;
}

function accountCard() {
  const u = sessionUser(); if (!u) return '';
  const guest = u.id === 'guest' || u.id === 'open';
  const real = !guest ? authGet().users.find((x) => x.id === u.id) : null;
  let h = '<div class="card"><h3>Account</h3><p>' + (guest
    ? 'Using this device <strong>without a password</strong>. Optional accounts protect the app if others use this browser.'
    : 'Signed in as <strong>' + esc(u.name) + '</strong> · ' + esc((ROLES[u.role] || {}).label || u.role)) + '</p>' +
    (guest
      ? '<button type="button" class="btn btn-secondary btn-sm" data-gotoauth="1">Set up optional account</button>'
      : '<button type="button" class="btn btn-secondary btn-sm" data-logout="1">Log out</button>');
  if (!guest && real) {
    h += '<h3 style="margin-top:14px">Password recovery</h3>';
    if (real.recoveryHash) {
      h += '<p class="muted">A recovery code is set on this account. Use <strong>Forgot password?</strong> on the login screen if you need to reset.</p>' +
        '<button type="button" class="btn btn-secondary btn-sm" data-rotate-recovery="1">Generate new recovery code</button>';
    } else {
      h += '<p class="muted">No recovery code on this account (created before this feature). Generate one so you can reset your password later.</p>' +
        '<button type="button" class="btn btn-primary btn-sm" data-rotate-recovery="1">Create recovery code</button>';
    }
  }
  if (can('roles') && !guest) {
    h += '<h3 style="margin-top:14px">Staff</h3>' + authGet().users.filter((x) => x.id !== u.id).map((x) => '<div class="row"><span>' + esc(x.name) + ' · ' + esc((ROLES[x.role] || {}).label || x.role) + '</span><button type="button" class="btn btn-ghost btn-sm" data-rmstaff="' + x.id + '">Remove</button></div>').join('') +
      '<label class="field" style="margin-top:8px"><span>Staff name</span><input id="st-name" type="text"></label>' +
      '<div class="grid"><label class="field"><span>Role</span><select id="st-role">' + Object.entries(ROLES).filter(([k]) => k !== 'owner').map(([k, v]) => '<option value="' + k + '">' + esc(v.label) + '</option>').join('') + '</select></label>' +
      '<label class="field"><span>Password (4+)</span><input id="st-pw" type="password" autocomplete="new-password"></label></div>' +
      '<button type="button" class="btn btn-primary btn-sm" data-addstaff="1">Add staff</button>';
  }
  return h + '</div>';
}

/* ===== Expiry, supplier orders, staff and insights ===== */
function expDays(p) { if (!p.exp || p.svc || p.qty <= 0) return null; return Math.ceil((Date.parse(p.exp) - Date.now()) / 864e5); }
function expTag(p) { const d = expDays(p); if (d === null || d > 30) return ''; return '<br><span class="tag w">' + (d < 0 ? 'Expired' : 'Expires in ' + d + ' day(s)') + '</span>'; }
function orderCard() {
  if (!can('stock')) return '';
  const low = S.products.filter(isLow); if (!low.length) return '';
  const txt = 'Hello, this is ' + S.settings.businessName + '. I need to restock:\n' + low.map((p) => '• ' + p.name + ' (have ' + p.qty + ', need 10)').join('\n') + '\nPlease confirm the price and delivery time. Thank you.';
  const n = waNum(S.settings.supplier);
  return '<div class="card gold"><h3>📦 ' + low.length + ' item(s) to reorder</h3><p class="muted" style="margin:0 0 10px">' + esc(low.slice(0, 4).map((p) => p.name).join(', ')) + (low.length > 4 ? '…' : '') + '</p>' +
    '<a class="btn btn-primary btn-sm" target="_blank" rel="noopener" href="https://wa.me/' + n + '?text=' + encodeURIComponent(txt) + '">Order on WhatsApp</a> ' +
    '<button type="button" class="btn btn-ghost btn-sm" data-setsupplier="1">' + (n ? 'Change supplier' : 'Set supplier number') + '</button></div>';
}
function staffCard() {
  const from = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime(), g = {};
  S.sales.filter((x) => !x.refunded && x.ts >= from).forEach((x) => { const k = x.by || 'Unassigned'; g[k] = g[k] || { n: 0, t: 0 }; g[k].n++; g[k].t += x.total; });
  const rows = Object.entries(g).sort((a, b) => b[1].t - a[1].t); if (!rows.length) return '';
  return '<div class="card"><h3>Sales by staff (this month)</h3>' + rows.map(([k, v]) => '<div class="row"><span>' + esc(k) + ' <small class="muted">' + v.n + ' sale(s)</small></span><b class="mono">' + kes(v.t) + '</b></div>').join('') + '</div>';
}
function insightsCard() {
  const from = Date.now() - 30 * 864e5, sold = {};
  S.sales.filter((x) => !x.refunded && x.ts >= from).forEach((x) => (x.items || []).forEach((it) => { if (it.custom || !it.id) return; const o = sold[it.id] = sold[it.id] || { name: it.name, q: 0, r: 0, c: 0 }; o.q += it.q; o.r += it.q * it.price; o.c += it.q * (it.cost != null ? it.cost : 0); }));
  const top = Object.values(sold).map((o) => Object.assign(o, { gp: o.r - o.c, margin: o.r > 0 ? Math.round((o.r - o.c) / o.r * 100) : 0 })).sort((a, b) => b.gp - a.gp).slice(0, 5);
  const dead = S.products.filter((p) => !p.svc && !p.starter && p.qty > 0 && !sold[p.id]).sort((a, b) => b.qty * b.cost - a.qty * a.cost).slice(0, 5);
  if (!top.length && !dead.length) return '';
  const tied = dead.reduce((t, p) => t + p.qty * p.cost, 0);
  let html = '<div class="card"><h3>Most profitable (30 days)</h3>' + (top.length ? top.map((o, i) => '<div class="row"><span>' + (i + 1) + '. ' + esc(o.name) + ' <small class="muted">' + o.q + ' sold · ' + o.margin + '% margin</small></span><b class="mono">' + kes(o.gp) + '</b></div>').join('') : '<p class="muted">No sales yet.</p>') + '</div>';
  if (dead.length) {
    html += '<div class="card"><h3>Not selling (30 days)</h3><p class="muted">About ' + kes(tied) + ' of your money is sitting on these shelves. Discount or stop reordering.</p>' + dead.map((p) => '<div class="row"><span>' + esc(p.name) + ' <small class="muted">' + p.qty + ' in stock</small></span><b class="mono">' + kes(p.qty * p.cost) + '</b></div>').join('') + '</div>';
  }
  return html;
}

/* ===== WhatsApp: debt reminders and reports ===== */
function waNum(ph) {
  let d = String(ph || '').replace(/\D/g, ''); const dc = cur().dial.replace('+', '');
  if (d.startsWith('00')) d = d.slice(2); else if (d.startsWith('0')) d = dc + d.slice(1); else if (d.length <= 9) d = dc + d;
  return d.length >= 10 ? d : '';
}
function remindText(c) {
  const sw = S.settings.msgLang === 'sw', biz = S.settings.businessName, amt = kes(c.balance);
  let pay = ''; if (S.settings.till) pay = (sw ? ' Lipa kupitia Till ' : ' Pay via Till ') + S.settings.till + '.'; else if (S.settings.paybill) pay = (sw ? ' Lipa kupitia Paybill ' : ' Pay via Paybill ') + S.settings.paybill + '.';
  return sw ? 'Habari ' + c.name + ', ni ' + biz + '. Tunakukumbusha kuwa una deni la ' + amt + '.' + pay + ' Asante sana!'
    : 'Hello ' + c.name + ', this is ' + biz + '. A friendly reminder that you have an outstanding balance of ' + amt + '.' + pay + ' Thank you!';
}
function remindBtn(c) {
  const n = waNum(c.phone);
  return n ? '<a class="btn btn-secondary btn-sm" target="_blank" rel="noopener" href="https://wa.me/' + n + '?text=' + encodeURIComponent(remindText(c)) + '">💬 Remind</a>'
    : '<button type="button" class="btn btn-ghost btn-sm" data-setphone="' + c.id + '">+ Add phone</button>';
}
function reportLink() {
  const t = profitInPeriod('today'), n = salesInPeriod('today').length, low = S.products.filter(isLow);
  const txt = '📊 ' + S.settings.businessName + ' · ' + new Date().toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'short' }) +
    '\nSales: ' + n + ' (' + kes(t.netRev) + ')\nGross profit: ' + kes(t.profit) + '\nCash in hand: ' + kes(bal('cash')) + '\nOwed to you: ' + kes(bal('ar')) +
    (low.length ? '\nLow stock: ' + low.slice(0, 5).map((p) => p.name + ' (' + p.qty + ')').join(', ') : '') + '\n— MarginPilot';
  return 'https://wa.me/?text=' + encodeURIComponent(txt);
}

/* ===== Business types ===== */
// items: 'Name|price in KES' = service (no stock); 'Name|price|cost' = stock item
const BIZ = {
  kinyozi: { i: '✂️', l: 'Kinyozi / Barbershop', tip: 'Record every cut as a service, even cash ones, to see your busiest days.', items: ['Haircut|150', 'Kids haircut|100', 'Shave|80', 'Haircut + beard|220', 'Hair wash|100', 'Hair dye|400', 'Hair gel|100|60'] },
  salon: { i: '💇', l: 'Salon / Beauty', tip: 'Add each style as a service and track products like relaxers as stock.', items: ['Braids (medium)|1500', 'Weave fitting|800', 'Wash & blow-dry|500', 'Manicure|500', 'Pedicure|700', 'Relaxer|1200', 'Eyebrow shaping|200', 'Hair food 250g|350|220'] },
  boutique: { i: '👗', l: 'Boutique / Clothes', tip: 'Add each item as stock with its buying price to see your real margin.', items: ['Dress|1500|900', 'T-shirt|600|350', 'Jeans|1800|1100', 'Blouse|900|500', 'Shoes|2000|1300', 'Handbag|1500|900', 'Belt|500|250', 'Socks (pair)|150|80'] },
  chemist: { i: '💊', l: 'Chemist / Pharmacy', tip: 'Check expiry dates by hand for now. Prescription items need a pharmacist.', items: ['Paracetamol (strip)|20|12', 'ORS sachet|40|25', 'Vitamin C (strip)|50|30', 'Antacid (strip)|60|35', 'Cough syrup|250|160', 'Plasters (box)|150|90', 'Hand sanitizer|100|60', 'Malaria test kit|200|120', 'Pregnancy test|150|90'] },
  butchery: { i: '🥩', l: 'Butchery', tip: 'Sell in fixed packs (½kg, 1kg) for now. Decimal weights are coming.', items: ['Beef 1kg|700|580', 'Beef ½kg|350|290', 'Goat meat 1kg|800|680', 'Mutton 1kg|850|700', 'Chicken (whole)|700|550', 'Liver 1kg|600|480', 'Tripe (matumbo) 1kg|400|300', 'Sausages (pack)|400|300'] },
  hardware: { i: '🔧', l: 'Hardware', tip: 'Track fast movers like cement and nails so you never run out.', items: ['Cement 50kg|750|680', 'Nails 1kg|200|150', 'Paint 4L|1200|900', 'Iron sheet|800|700', 'Padlock|250|150', 'PVC pipe|450|330', 'Hammer|450|300', 'Bulb|150|90'] },
  mboga: { i: '🥬', l: 'Mama Mboga / Greengrocer', tip: 'Count what you buy each morning and what is left at night to see true profit.', items: ['Tomatoes (heap)|20|12', 'Onions (heap)|20|12', 'Sukuma wiki (bunch)|10|5', 'Potatoes 1kg|80|55', 'Cabbage|50|30', 'Carrots 1kg|80|55', 'Bananas (bunch)|150|100', 'Avocado|20|10'] },
  duka: { i: '🏪', l: 'Duka / Kiosk / Supermarket', tip: 'Scan or add your top 20 items first. They bring most of your sales.', items: ['Sugar 1kg|190|165', 'Maize flour 2kg|150|135', 'Cooking oil 1L|300|265', 'Bread|65|55', 'Milk 500ml|60|50', 'Rice 1kg|160|135', 'Soap bar|50|38', 'Eggs (each)|20|16'] },
  kibanda: { i: '🍛', l: 'Hotel / Kibanda / Restaurant', tip: 'Enter how many portions you cooked, then see what is left and your margin.', items: ['Tea|30|8', 'Chapati|20|8', 'Mandazi|10|4', 'Ugali + sukuma|120|60', 'Rice + beans|150|70', 'Nyama choma plate|400|260', 'Chips|150|70', 'Soda|50|32'] },
  bar: { i: '🍺', l: 'Bar / Wines & Spirits', tip: 'Count stock at closing. Missing bottles show up as lost profit.', items: ['Beer 500ml|250|190', 'Soda|60|42', 'Water 500ml|50|30', 'Tusker (cold)|300|210', 'Vodka tot|150|90', 'Wine glass|300|180'] },
  electronics: { i: '📱', l: 'Electronics / Phone shop', tip: 'Note serial numbers in the barcode field for phones and chargers.', items: ['Phone charger|400|220', 'Earphones|300|150', 'Phone case|350|150', 'Screen guard|200|80', 'Power bank|1500|1000', 'USB cable|250|120'] },
  agrovet: { i: '🌾', l: 'Agrovet / Farm supplies', tip: 'Keep a close eye on stock that expires, like chemicals and feeds.', items: ['Dairy meal 70kg|2800|2500', 'Layers mash 70kg|3100|2800', 'Fertilizer 50kg|4200|3800', 'Maize seed 2kg|600|500', 'Dewormer|350|220', 'Acaricide|450|300'] },
  cyber: { i: '🖨️', l: 'Cyber / Printing / M-Pesa shop', tip: 'Add each job as a service: printing, copies, typing, photos, internet time.', items: ['Black & white print|10', 'Photocopy|5', 'Colour print|30', 'Scan|20', 'Passport photos|200', 'Lamination|50', 'Internet (per hour)|50', 'Typing (per page)|100'] },
  carwash: { i: '🚗', l: 'Car wash / Garage', tip: 'List every service and record each vehicle to see your best earners.', items: ['Saloon car wash|300', 'SUV wash|500', 'Motorbike wash|100', 'Interior cleaning|600', 'Engine wash|800', 'Puncture repair|200'] },
  other: { i: '🏢', l: 'Other business', tip: 'Add your products or services in Stock to get started.', items: [] }
};
const bt = () => (S.settings && BIZ[S.settings.bizType]) || null;
const typeOptions = (sel) => '<option value="other"' + (!sel ? ' selected' : '') + '>Choose your business…</option>' + Object.entries(BIZ).filter(([k]) => k !== 'other').map(([k, v]) => '<option value="' + k + '"' + (sel === k ? ' selected' : '') + '>' + v.i + ' ' + v.l + '</option>').join('') + '<option value="other">🏢 Other business</option>';
const isLow = (p) => !p.svc && p.qty <= 2 && !(p.starter && p.qty === 0);
function scaleKes(v, code) {
  if (code === 'KES') return v;
  const r = getRates(), x = v * r[code] / r.KES, step = x < 5000 ? 100 : 500;
  return Math.max(step, Math.round(x / step) * step);
}
function seedStarter(type) {
  const b = BIZ[type]; if (!b) return 0; let n = 0;
  b.items.forEach((it, k) => {
    const [name, pr, co] = it.split('|');
    if (S.products.some((p) => p.name.toLowerCase() === name.toLowerCase())) return;
    const svc = co === undefined;
    S.products.push({ id: 'p' + Date.now() + k, name, price: cents(String(scaleKes(+pr, CC()))), cost: svc ? 0 : cents(String(scaleKes(+co, CC()))), qty: svc ? 99999 : 0, barcode: null, svc, starter: !svc });
    n++;
  });
  return n;
}
function typeTip() {
  const b = bt(); if (!b || S.sales.length >= 5) return '';
  return '<div class="card"><h3>' + b.i + ' ' + esc(b.l) + '</h3><p class="muted" style="margin:0">' + esc(b.tip) + '</p></div>';
}

/* ===== Subscription (offline-verified license codes) ===== */
// EDIT THIS: how shops pay you. Prices are in KES major units.
const SELLER = { name: 'MarginPilot', till: '', paybill: '', whatsapp: '', prices: { small: 100, big: 250 } };
const TRIAL_DAYS = 365;
const SUB_PUBKEY = {"kty":"EC","crv":"P-256","x":"yuKJWYJNM7t0z-5rtzCbGhNRHNY4VUBxgKSVlAJd9cY","y":"-bLsYDRkg3FcyGF0CDn9ES4vV3LC6HFdsNxrvVPowN4"};
const SUB_KEY = 'marginpilot.sub';
let lastSubLocked = null;
function subGet() {
  let x; try { x = JSON.parse(localStorage.getItem(SUB_KEY)); } catch (e) {}
  if (!x || !x.expires) {
    x = { bid: 'MP-' + Math.random().toString(36).slice(2, 8).toUpperCase(), trialStart: Date.now(), expires: Date.now() + TRIAL_DAYS * 864e5, lastSeen: Date.now(), used: [], plan: 'trial' };
    localStorage.setItem(SUB_KEY, JSON.stringify(x));
  }
  return x;
}
function subNow() { const x = subGet(); const t = Math.max(Date.now(), x.lastSeen || 0); if (t > (x.lastSeen || 0) + 4000) { x.lastSeen = t; localStorage.setItem(SUB_KEY, JSON.stringify(x)); } return t; }
// Hard lock disabled: expired trial must not block the product (license sales can re-enable later).
const subLocked = () => false;
const subExpired = () => subNow() > subGet().expires;
const subDaysLeft = () => Math.ceil((subGet().expires - subNow()) / 864e5);
const b64u8 = (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function applyLicense(code) {
  if (!window.crypto || !crypto.subtle) return 'Open the app from an https address to activate.';
  try {
    const [p, sg] = String(code || '').trim().split('.');
    const key = await crypto.subtle.importKey('jwk', SUB_PUBKEY, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64u8(sg), new TextEncoder().encode(p));
    if (!ok) return 'That code is not valid.';
    const [v, bid, plan, days, nonce] = atob(p.replace(/-/g, '+').replace(/_/g, '/')).split('|');
    const x = subGet();
    if (v !== 'v1' || bid !== x.bid) return 'This code was made for a different business ID.';
    if (x.used.includes(nonce)) return 'This code was already used.';
    const d = parseInt(days, 10); if (!(d > 0)) return 'Invalid code.';
    x.expires = Math.max(subNow(), x.expires) + d * 864e5; x.plan = plan; x.used.push(nonce); localStorage.setItem(SUB_KEY, JSON.stringify(x));
    logActivity('license', plan + ' +' + d + 'd'); return null;
  } catch (e) { return 'That code is not valid.'; }
}
function subStatus() {
  const x = subGet(), left = subDaysLeft();
  return (x.plan === 'trial' ? 'Free trial' : 'Active (' + x.plan + ')') + ' · ' + (left > 0 ? left + ' day(s) left' : 'expired') + ' · until ' + new Date(x.expires).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}
function payInfo() {
  const bits = [];
  if (SELLER.till) bits.push('Till <strong>' + esc(SELLER.till) + '</strong>');
  if (SELLER.paybill) bits.push('Paybill <strong>' + esc(SELLER.paybill) + '</strong>');
  const bid = subGet().bid;
  const wa = SELLER.whatsapp ? ' <a href="https://wa.me/' + SELLER.whatsapp.replace(/\D/g, '') + '?text=' + encodeURIComponent('Hello, I paid for MarginPilot. Business ID: ' + bid + '. M-Pesa code: ') + '" target="_blank" rel="noopener">Send proof on WhatsApp</a>' : '';
  return (bits.length ? '<p>Pay to ' + bits.join(' or ') + ', then send your Business ID and payment code.' + wa + '</p>' : '<p>Contact ' + esc(SELLER.name) + ' to renew.</p>') +
    '<p class="muted">Small Shop ' + fmtIn('KES', SELLER.prices.small * 100) + ' / month · Big Business ' + fmtIn('KES', SELLER.prices.big * 100) + ' / month</p>';
}
function renderSubLock() {
  const el = document.getElementById('sublock'); if (!el) return false;
  const locked = subLocked(); lastSubLocked = locked;
  el.hidden = !locked;
  if (!locked) {
    // Do not leave body stuck in locked state from a previous session
    if (!document.getElementById('auth') || document.getElementById('auth').hidden) {
      document.body.classList.remove('locked');
    }
    return false;
  }
  document.body.classList.add('locked');
  const u = sessionUser(), owner = u && can('plans'), bid = subGet().bid;
  el.innerHTML = '<div class="card" style="width:100%;max-width:420px;margin:auto"><h2>Subscription expired</h2>' +
    '<p>Your MarginPilot subscription has ended, so the app is locked. Your records are safe on this device and nothing was deleted.</p>' + payInfo() +
    '<div class="help-panel"><strong>Your Business ID</strong><span class="mono" style="font-size:1.1rem">' + esc(bid) + '</span></div>' +
    (owner ? '<label class="field"><span>Enter license code</span><textarea id="lic-code" placeholder="Paste the code you received"></textarea></label><button type="button" class="btn btn-primary btn-block" id="lic-go">Unlock</button>' +
      '<p style="margin-top:10px"><button type="button" class="btn btn-secondary btn-sm" id="lic-backup">Download my data backup</button></p>'
      : '<p class="muted">Ask the business owner to renew.</p>') +
    '<p style="margin-top:8px"><button type="button" class="btn btn-ghost btn-sm" id="lic-logout">Log out</button></p></div>';
  document.getElementById('lic-go')?.addEventListener('click', async () => {
    const err = await applyLicense(document.getElementById('lic-code').value);
    if (err) { toast(err); return; } toast('Subscription active. Thank you!'); render();
  });
  document.getElementById('lic-backup')?.addEventListener('click', downloadBackup);
  document.getElementById('lic-logout')?.addEventListener('click', () => { localStorage.removeItem(SESS_KEY); render(); });
  return true;
}
function subNudge() {
  const left = subDaysLeft(); if (left > 3 || left < 0) return '';
  return '<div class="card gold"><h3>Subscription ends in ' + left + ' day(s)</h3>' + payInfo() + '<p class="muted" style="margin:0">Your Business ID: <strong>' + esc(subGet().bid) + '</strong>. Enter the new code in More → Subscription.</p></div>';
}
function subCard() {
  return '<div class="card"><h3>Subscription</h3><p>' + esc(subStatus()) + '</p>' + payInfo() + '<p class="muted">Business ID: <strong class="mono">' + esc(subGet().bid) + '</strong></p>' +
    (can('plans') ? '<label class="field"><span>Enter license code to renew</span><input id="lic-code2" type="text" autocomplete="off"></label><button type="button" class="btn btn-secondary btn-sm" data-lic="1">Apply code</button>' : '') + '</div>';
}
setInterval(() => { if (subLocked() !== lastSubLocked) render(); }, 5000);

/* ===== Backup & restore ===== */
function saveBlob(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}
function downloadBackup() {
  if (!can('roles')) { toast('Only the owner can back up.'); return; }
  const data = { app: 'marginpilot', version: 3, exportedAt: Date.now(), S, auth: authGet() };
  saveBlob('marginpilot-backup-' + todayISO() + '.json', JSON.stringify(data), 'application/json');
  localStorage.setItem('marginpilot.lastBackup', String(Date.now())); toast('Backup downloaded. Keep it somewhere safe.'); render();
}
function downloadCsv() {
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [];
  lines.push('MarginPilot export')
  lines.push('Business,' + q(S.settings.businessName))
  lines.push('Currency,' + CC())
  lines.push('Exported,' + new Date().toISOString())
  lines.push('')
  lines.push('SALES')
  lines.push(['Sale','Date','Payment','Total','Discount','Items','Refunded'].map(q).join(','))
  S.sales.forEach((x) => {
    lines.push([x.id, new Date(x.ts).toISOString(), x.method, (x.total/100).toFixed(2), ((x.discount||0)/100).toFixed(2), (x.items||[]).map((it)=>it.q+'x '+(it.name||it.id)).join('; '), x.refunded?'yes':'no'].map(q).join(','))
  })
  lines.push('')
  lines.push('PRODUCTS')
  lines.push(['Name','Price','Cost','Qty','Service','Margin%'].map(q).join(','))
  S.products.forEach((p) => {
    const m = p.price > 0 ? (((p.price-p.cost)/p.price)*100).toFixed(1) : ''
    lines.push([p.name, (p.price/100).toFixed(2), (p.cost/100).toFixed(2), p.qty, p.svc?'yes':'no', m].map(q).join(','))
  })
  lines.push('')
  lines.push('CUSTOMERS')
  lines.push(['Name','Phone','Balance'].map(q).join(','))
  ;(S.customers||[]).forEach((c) => lines.push([c.name, c.phone||'', ((c.balance||0)/100).toFixed(2)].map(q).join(',')))
  lines.push('')
  lines.push('SUPPLIERS')
  lines.push(['Name','Phone','Notes'].map(q).join(','))
  ;(S.suppliers||[]).forEach((s) => lines.push([s.name, s.phone||'', s.notes||''].map(q).join(',')))
  lines.push('')
  lines.push('PURCHASES')
  lines.push(['Date','Supplier','Description','Amount','Payment','Currency'].map(q).join(','))
  ;(S.purchases||[]).forEach((p) => lines.push([new Date(p.ts).toISOString(), p.supplier||'', p.desc, (p.amount/100).toFixed(2), p.pay, p.currency||CC()].map(q).join(',')))
  lines.push('')
  lines.push('EXPENSES_JOURNAL')
  lines.push(['Id','Date','Memo','Amount'].map(q).join(','))
  S.entries.filter((e)=>!e.isRev && e.lines.some((l)=>l.a==='exp'&&l.dr>0)).forEach((e) => {
    const amt = e.lines.filter((l)=>l.a==='exp').reduce((s,l)=>s+l.dr,0)
    lines.push([e.id, e.date||new Date(e.ts).toISOString().slice(0,10), e.memo, (amt/100).toFixed(2)].map(q).join(','))
  })
  saveBlob('marginpilot-export-' + todayISO() + '.csv', lines.join('\n'), 'text/csv')
  toast('CSV exported (sales, products, customers, suppliers, purchases, expenses).')
}

function downloadProfitReport() {
  const fs = financialSummary('month')
  const products = productProfitability('month')
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>Profit report — ' + esc(S.settings.businessName) + '</title>' +
    '<style>body{font:14px/1.45 system-ui,sans-serif;max-width:800px;margin:24px auto;color:#101828;padding:0 16px}h1{font-size:1.4rem}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eaecf0}th{color:#667085;font-size:12px}.n{text-align:right;font-variant-numeric:tabular-nums}.muted{color:#667085}@.media print{body{margin:0}}</style></head><body>' +
    '<h1>' + esc(S.settings.businessName) + ' — Monthly profit report</h1>' +
    '<p class="muted">Generated ' + new Date().toLocaleString() + ' · Currency ' + CC() + ' · From MarginPilot records</p>' +
    '<h2>Summary</h2><table><tr><td>Net sales</td><td class="n">' + kes(fs.netRev) + '</td></tr>' +
    '<tr><td>COGS</td><td class="n">' + kes(fs.cogs) + '</td></tr>' +
    '<tr><td>Gross profit</td><td class="n">' + kes(fs.grossProfit) + ' (' + fs.grossMargin + '%)</td></tr>' +
    '<tr><td>Operating expenses</td><td class="n">' + kes(fs.expenses) + '</td></tr>' +
    '<tr><td><strong>Net profit</strong></td><td class="n"><strong>' + kes(fs.netProfit) + ' (' + fs.netMargin + '%)</strong></td></tr></table>' +
    '<h2>Product profitability</h2><table><thead><tr><th>Product</th><th class="n">Sold</th><th class="n">Revenue</th><th class="n">Gross profit</th><th class="n">Margin</th></tr></thead><tbody>' +
    products.slice(0, 30).map((p) => '<tr><td>' + esc(p.name) + '</td><td class="n">' + p.qtySold + '</td><td class="n">' + kes(p.revenue) + '</td><td class="n">' + kes(p.grossProfit) + '</td><td class="n">' + p.margin + '%</td></tr>').join('') +
    '</tbody></table><p class="muted">Not formal tax or statutory accounts. Print or Save as PDF from your browser.</p></body></html>'
  const w = window.open('', '_blank')
  if (!w) { toast('Allow pop-ups to open the printable report.'); return }
  w.document.write(html); w.document.close(); w.focus()
  setTimeout(() => { try { w.print() } catch (e) {} }, 300)
}

function restoreBackup(e) {
  const f = e.target.files && e.target.files[0]; if (!f || !can('roles')) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!d || d.app !== 'marginpilot' || !d.S || !Array.isArray(d.S.entries) || !Array.isArray(d.S.products)) throw new Error('bad');
      if (!confirm('Replace ALL data on this device with this backup (' + d.S.sales.length + ' sales, ' + d.S.products.length + ' products)? This cannot be undone.')) { e.target.value = ''; return; }
      localStorage.setItem(KEY, JSON.stringify(d.S)); if (d.auth && d.auth.users && d.auth.users.length) authSet(d.auth);
      localStorage.removeItem(SESS_KEY); location.reload();
    } catch (err) { toast('That is not a valid MarginPilot backup.'); }
  };
  r.readAsText(f);
}
function backupCard() {
  const last = localStorage.getItem('marginpilot.lastBackup');
  return '<div class="card"><h3>Backup & export</h3>' +
    '<p class="muted">Data lives on this device. Download backups regularly.</p>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button type="button" class="btn btn-primary btn-sm" data-backup="1">Download backup (JSON)</button>' +
    '<button type="button" class="btn btn-secondary btn-sm" data-exportcsv="1">Export CSV</button>' +
    '<button type="button" class="btn btn-secondary btn-sm" data-profitreport="1">Printable profit report</button>' +
    '</div>' +
    '<label class="field" style="margin-top:10px"><span>Restore backup</span><input type="file" id="restore-file" accept="application/json,.json"></label>' +
    (last ? '<p class="lock-note">Last backup: ' + fmtDate(Number(last)) + '</p>' : '<p class="lock-note">No backup recorded on this device yet.</p>') +
    '</div>';
}
function backupNudge() {
  const last = +(localStorage.getItem('marginpilot.lastBackup') || 0);
  if (!can('roles') || !S.sales.length || Date.now() - last < 7 * 864e5) return '';
  return '<div class="card gold"><h3>Back up your records</h3><p class="muted" style="margin:0 0 10px">Your sales are only stored on this device. Save a backup copy now.</p><button type="button" class="btn btn-primary btn-sm" data-backup="1">Download backup</button></div>';
}

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
  const d = { on: false, low: true, owed: true, unver: true, daily: true, hour: 18, quietStart: 22, quietEnd: 7, seen: {} };
  try { return Object.assign(d, JSON.parse(localStorage.getItem(NK) || '{}')); } catch (e) { return d; }
}
function inQuietHours(p) {
  const h = new Date().getHours();
  const qs = p.quietStart != null ? p.quietStart : 22;
  const qe = p.quietEnd != null ? p.quietEnd : 7;
  if (qs === qe) return false;
  if (qs < qe) return h >= qs && h < qe;
  return h >= qs || h < qe;
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
  const _p = nprefs(); if (_p.on && inQuietHours(_p)) return;
  if (!('Notification' in window) || Notification.permission !== 'granted' || !sessionUser()) return;
  const p = nprefs(); if (!p.on) return;
  const day = todayISO(), fresh = (k) => { if (p.seen[k]) return false; p.seen[k] = 1; return true; };
  const low = S.products.filter(isLow);
  if (p.low && low.length && fresh('low-' + day + '-' + low.map((x) => x.id + ':' + x.qty).join(',')))
    notify('Low stock', low.slice(0, 4).map((x) => x.name + ' (' + x.qty + ')').join(', ') + (low.length > 4 ? ' +' + (low.length - 4) + ' more' : ''), 'low', 'stock');
  const ex = S.products.filter((x) => { const d = expDays(x); return d !== null && d <= 30; });
  if (p.low && ex.length && fresh('exp-' + day)) notify('Expiring stock', ex.slice(0, 4).map((x) => x.name).join(', ') + (ex.length > 4 ? ' +' + (ex.length - 4) + ' more' : ''), 'exp', 'stock');
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
    '<div class="grid"><label class="field"><span>Quiet hours start</span><select id="n-qstart">' + Array.from({length:24},(_,h)=>'<option value="'+h+'"'+(p.quietStart===h?' selected':'')+'>'+String(h).padStart(2,'0')+':00</option>').join('') + '</select></label>' +
    '<label class="field"><span>Quiet hours end</span><select id="n-qend">' + Array.from({length:24},(_,h)=>'<option value="'+h+'"'+(p.quietEnd===h?' selected':'')+'>'+String(h).padStart(2,'0')+':00</option>').join('') + '</select></label></div>' +
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
const qParams = new URLSearchParams(location.search);
const qTab = qParams.get('tab');
if (qTab && TABS.some((t) => t.id === qTab)) tab = qTab;
const qReset = qParams.get('reset_token');
if (qReset) {
  try {
    sessionStorage.setItem('marginpilot.resetToken', qReset);
    authMode = 'email_reset';
    qParams.delete('reset_token');
    const qs = qParams.toString();
    history.replaceState({}, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  } catch (e) {}
}
// Always allow the app shell to open: no accounts => open mode; never leave body locked on boot
try {
  if (!(authGet().users || []).length) {
    localStorage.setItem('marginpilot.guest', '1');
    localStorage.setItem(ROLE_KEY, 'owner');
  }
  document.body.classList.remove('locked');
  const authEl = document.getElementById('auth'); if (authEl) authEl.hidden = true;
  const subEl = document.getElementById('sublock'); if (subEl) subEl.hidden = true;
} catch (e) {}
try {
  render();
} catch (err) {
  console.error('Boot render failed', err);
  const main = document.getElementById('main');
  if (main) {
    main.innerHTML = '<div class="card" style="margin:16px"><h2>MarginPilot failed to start</h2><p class="muted">' +
      String(err && err.message || err) + '</p><p class="muted">Try a hard refresh. If it keeps failing, clear site data for this page and reload.</p></div>';
  }
}
setTimeout(checkNotifs, 2500);
})();
