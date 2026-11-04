// Extra checks that mirror browser sale paths: credit (AR), split not needed in core,
// integer money, reversal after sale-like post.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from './ledger.mjs';
import { parseMpesaSms, PARSER_VERSION } from './mpesa-parser.mjs';

test('credit sale style: AR debit and sales credit balance', () => {
  const L = new Ledger();
  const e = L.post({
    date: '2026-11-04',
    memo: 'Sale #1 (credit)',
    lines: [
      { account: 'ar', debit: 50000, credit: 0 },
      { account: 'sales', debit: 0, credit: 50000 },
    ],
  });
  assert.equal(e.id, 1);
  const tb = L.trialBalance();
  assert.equal(tb.balanced, true);
  assert.equal(tb.accounts.ar.debit - tb.accounts.ar.credit, 50000);
});

test('mpesa clearing then verify moves to till', () => {
  const L = new Ledger();
  L.post({
    date: '2026-11-04',
    memo: 'Sale M-Pesa',
    lines: [
      { account: 'clr', debit: 10000, credit: 0 },
      { account: 'sales', debit: 0, credit: 10000 },
    ],
  });
  L.post({
    date: '2026-11-04',
    memo: 'Verify M-Pesa ABC1234567',
    lines: [
      { account: 'till', debit: 10000, credit: 0 },
      { account: 'clr', debit: 0, credit: 10000 },
    ],
  });
  const tb = L.trialBalance();
  assert.equal(tb.balanced, true);
  assert.equal(tb.accounts.clr.debit - tb.accounts.clr.credit, 0);
  assert.equal(tb.accounts.till.debit - tb.accounts.till.credit, 10000);
});

test('parser version is stable string', () => {
  assert.match(PARSER_VERSION, /^v\d/);
  const r = parseMpesaSms('ABC1234567 Confirmed. Ksh 1,250.00 received from JOHN DOE 254712345678 on 4/11/26 at 9:15 AM');
  assert.equal(r.version, PARSER_VERSION);
});
