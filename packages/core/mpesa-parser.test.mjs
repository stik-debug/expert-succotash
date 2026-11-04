import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMpesaSms } from './mpesa-parser.mjs';
// SYNTHETIC fixtures (invented codes and names). Replace/add real formats when available.
const till = 'ABC1D2E3F4 Confirmed. Ksh500.00 received from JOHN DOE 0700000000 on 4/11/26 at 2:30 PM. New balance is Ksh9,500.00.';
const recv = 'QWE9R8T7Y6 Confirmed. You have received Ksh1,250.50 from JANE W 0711111111 on 4/11/26 at 10:05 AM.';
test('till payment', () => { const r = parseMpesaSms(till);
  assert.equal(r.ok, true); assert.equal(r.code, 'ABC1D2E3F4'); assert.equal(r.amountMinor, 50000);
  assert.equal(r.direction, 'in'); assert.equal(r.time, '2:30 PM'); });
test('amount with comma and cents', () => { assert.equal(parseMpesaSms(recv).amountMinor, 125050); });
test('outgoing message is not accepted', () => {
  const r = parseMpesaSms('ZXC1V2B3N4 Confirmed. Ksh300.00 sent to SHOP LTD on 4/11/26 at 1:00 PM.');
  assert.equal(r.ok, false); assert.equal(r.direction, 'out'); });
test('garbage never parses', () => { const r = parseMpesaSms('hello there'); assert.equal(r.ok, false); assert.equal(r.code, null); });
test('empty input', () => assert.equal(parseMpesaSms(undefined).ok, false));
