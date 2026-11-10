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

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

/** A normalized contact, or null when it is neither an email address nor a valid npub. */
export function parseContact(input: unknown): { contact: string; kind: 'email' | 'npub' } | null {
  const s = String(input ?? '').trim();
  if (/^npub1/i.test(s)) return decodeNpub(s.toLowerCase()) ? { contact: s.toLowerCase(), kind: 'npub' } : null;
  if (s.length <= 254 && EMAIL.test(s)) return { contact: s.toLowerCase(), kind: 'email' };
  return null;
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
