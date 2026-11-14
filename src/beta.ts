import { randomUUID } from 'node:crypto';
import { decodeNpub } from './cashu/lock.ts';
import { type DB, now } from './db.ts';

export interface BetaSignup {
  id: string;
  contact: string;
  kind: 'email' | 'npub';
  note: string | null;
  created_at: number;
  invited_at: number | null;
}

/**
 * A plain address only: a dot-atom local part from letters, digits and `_ + -`, then a hostname with
 * a letter (or punycode) top-level label. Nothing a URI reads as a delimiter or escape (`? & # % , ;`
 * and the rest) and no whitespace, so a contact can never add a header or a recipient to the
 * `mailto:` link an operator opens. Quoted local parts and IP-literal domains are refused on purpose.
 */
const EMAIL_LOCAL = /^[a-z0-9_+-]+(?:\.[a-z0-9_+-]+)*$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

function isEmail(s: string): boolean {
  if (s.length > 254) return false;
  const at = s.indexOf('@');
  if (at < 1 || at !== s.lastIndexOf('@')) return false;
  const local = s.slice(0, at);
  const labels = s.slice(at + 1).split('.');
  if (local.length > 64 || !EMAIL_LOCAL.test(local)) return false;
  if (labels.length < 2 || !labels.every((l) => DOMAIN_LABEL.test(l))) return false;
  return TLD.test(labels.at(-1)!);
}

/** A normalized contact, or null when it is neither an email address nor a valid npub. */
export function parseContact(input: unknown): { contact: string; kind: 'email' | 'npub' } | null {
  const s = String(input ?? '').trim();
  if (/^npub1/i.test(s)) return decodeNpub(s.toLowerCase()) ? { contact: s.toLowerCase(), kind: 'npub' } : null;
  const lower = s.toLowerCase();
  if (isEmail(lower)) return { contact: lower, kind: 'email' };
  return null;
}

/**
 * A `mailto:` link to one waitlist contact, or null when the stored contact is not an address
 * `parseContact` accepts today (a row written under the older, looser rule). The recipient is
 * percent-encoded either side of its `@` so nothing in it can start a query or a second recipient.
 */
export function mailtoLink(contact: string, subject: string, body: string): string | null {
  const parsed = parseContact(contact);
  if (parsed?.kind !== 'email' || parsed.contact !== contact) return null;
  const at = contact.indexOf('@');
  const to = `${encodeURIComponent(contact.slice(0, at))}@${encodeURIComponent(contact.slice(at + 1))}`;
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export class BetaWaitlist {
  private readonly db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  /** Adds a signup; a contact already on the list is accepted again without a second row. */
  add(contact: string, kind: 'email' | 'npub', note: string | null): { created: boolean } {
    const r = this.db
      .prepare('INSERT INTO beta_signups (id, contact, kind, note, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (contact) DO NOTHING')
      .run('beta_' + randomUUID().replaceAll('-', ''), contact, kind, note, now());
    return { created: Number(r.changes) > 0 };
  }

  list(): BetaSignup[] {
    return this.db.prepare('SELECT * FROM beta_signups ORDER BY created_at').all() as unknown as BetaSignup[];
  }

  get(id: string): BetaSignup | undefined {
    return this.db.prepare('SELECT * FROM beta_signups WHERE id = ?').get(id) as BetaSignup | undefined;
  }

  /** Removes a signup entirely (on request). */
  delete(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM beta_signups WHERE id = ?').run(id).changes) > 0;
  }

  markInvited(id: string): boolean {
    return Number(this.db.prepare('UPDATE beta_signups SET invited_at = ? WHERE id = ? AND invited_at IS NULL').run(now(), id).changes) > 0;
  }
}
