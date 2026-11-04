// Reference ledger: integer minor units, balanced entries, append-only, period locks.
// The PostgreSQL schema in db/migrations enforces the same rules in the database.
const sum = (ls, k) => ls.reduce((a, l) => a + l[k], 0);
export class Ledger {
  constructor() { this.entries = []; this.lockedThrough = null; this.log = []; this.seq = 1; }
  post({ date, memo, lines, reverses = null }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date');
    if (!Array.isArray(lines) || lines.length < 2) throw new Error('Entry needs at least two lines');
    for (const l of lines) {
      if (!Number.isSafeInteger(l.debit) || !Number.isSafeInteger(l.credit) || l.debit < 0 || l.credit < 0)
        throw new Error('Amounts must be non-negative integers (minor units)');
      if ((l.debit > 0) === (l.credit > 0)) throw new Error('Each line needs exactly one of debit or credit');
    }
    if (sum(lines, 'debit') !== sum(lines, 'credit')) throw new Error('Entry is not balanced');
    if (this.lockedThrough && date <= this.lockedThrough) throw new Error('Period is locked through ' + this.lockedThrough);
    const e = Object.freeze({ id: this.seq++, date, memo, reverses,
      lines: Object.freeze(lines.map((l) => Object.freeze({ ...l }))) });
    this.entries.push(e); return e;
  }
  reverse(id, date, memo) {
    const e = this.entries.find((x) => x.id === id);
    if (!e) throw new Error('Entry not found');
    if (e.reverses) throw new Error('A reversal cannot be reversed; post a new adjustment');
    if (this.entries.some((x) => x.reverses === id)) throw new Error('Entry already reversed');
    return this.post({ date, memo: memo ?? `Reversal of #${id}: ${e.memo}`, reverses: id,
      lines: e.lines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit })) });
  }
  lock(date) {
    if (this.lockedThrough && date < this.lockedThrough) throw new Error('Use reopen() to move the lock back');
    this.lockedThrough = date; this.log.push({ action: 'lock', date });
  }
  reopen(date, reason, approver) {
    if (!reason || !approver) throw new Error('Reopening needs a reason and an approver');
    this.log.push({ action: 'reopen', from: this.lockedThrough, to: date, reason, approver });
    this.lockedThrough = date;
  }
  trialBalance() {
    const t = {};
    for (const e of this.entries) for (const l of e.lines) {
      t[l.account] ??= { debit: 0, credit: 0 };
      t[l.account].debit += l.debit; t[l.account].credit += l.credit;
    }
    const d = Object.values(t).reduce((a, x) => a + x.debit, 0), c = Object.values(t).reduce((a, x) => a + x.credit, 0);
    return { accounts: t, debit: d, credit: c, balanced: d === c };
  }
}
