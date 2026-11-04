// M-Pesa confirmation SMS parser. Parser version is stored with every payment.
// NOTE: patterns are written from typical wording, not verified against real messages.
// Add each real format as a fixture in mpesa-parser.test.mjs before trusting it.
export const PARSER_VERSION = 'v1-unverified';

const toMinor = (s) => Math.round(parseFloat(String(s).replace(/,/g, '')) * 100);

export function parseMpesaSms(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const out = { ok: false, version: PARSER_VERSION, code: null, amountMinor: null,
    direction: null, counterparty: null, date: null, time: null, issues: [] };
  const code = t.match(/\b([A-Z0-9]{10})\s+Confirmed/i);
  if (!code) out.issues.push('No transaction code followed by "Confirmed"');
  else out.code = code[1].toUpperCase();
  const amt = t.match(/Ksh\.?\s?([\d,]+(?:\.\d{1,2})?)/i);
  if (!amt) out.issues.push('No amount found');
  else out.amountMinor = toMinor(amt[1]);
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
