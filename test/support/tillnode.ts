// The till transport core/till.js takes, in Node: what the Android app's ForgeTill plugin does, with
// fetch for the pay routes and Node's WebSocket (which can send the bearer) for the card link. The
// pairing (address and token) is held here, as the plugin holds it in the Keystore.
const T: any = await import('../../public/v2/core/till.js' as string);

export interface NodeTill {
  supported(): boolean;
  status(): Promise<{ paired: boolean; url: string | null }>;
  pair(text: string): Promise<{ url: string }>;
  forget(): Promise<void>;
  request(r: { method: string; path: string; link?: string | null; body?: unknown; timeoutMs?: number }): Promise<{ status: number; body: any }>;
  openLink(o: { onApdu: (m: { id: number; apdu: string }) => Promise<object> }): Promise<{ id: string; close(): void }>;
  /** The paths sent, for the tests. */
  sent: string[];
}

const err = (code: string, message = code) => Object.assign(new Error(message), { code });

export function nodeTill(pairing: { url: string; token: string } | null = null): NodeTill {
  let p = pairing;
  const sent: string[] = [];
  return {
    sent,
    supported: () => true,
    status: async () => ({ paired: !!p, url: p?.url ?? null }),
    async pair(text) {
      const r = T.parsePairing(text);
      if (!r.ok) throw err(r.why);
      p = { url: r.url, token: r.token };
      return { url: r.url };
    },
    async forget() {
      p = null;
    },
    async request({ method, path, link = null, body, timeoutMs = 20_000 }) {
      if (!p) throw err('not_paired');
      sent.push(`${method} ${path}`);
      const headers: Record<string, string> = { authorization: `Bearer ${p.token}`, accept: 'application/json' };
      if (link) headers['x-card-link'] = link;
      if (body !== undefined && body !== null) headers['content-type'] = 'application/json';
      let res: Response;
      try {
        res = await fetch(p.url + path, { method, headers, body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      } catch (e: any) {
        throw err(e?.name === 'TimeoutError' ? 'timeout' : 'unreachable');
      }
      const text = await res.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      return { status: res.status, body: parsed };
    },
    async openLink({ onApdu }) {
      if (!p) throw err('not_paired');
      const pair = p;
      const ws = new WebSocket(T.linkUrl(pair.url), { headers: { authorization: `Bearer ${pair.token}` } } as any);
      const id = await new Promise<string>((resolve, reject) => {
        ws.onmessage = async (ev) => {
          const m = JSON.parse(String(ev.data));
          if (m.type === 'ready') return resolve(m.link);
          if (m.type === 'apdu') {
            const frame = await onApdu({ id: m.id, apdu: m.apdu });
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
          }
        };
        ws.onerror = async () => {
          // A refused upgrade: as the plugin tells 401 from the rest, ask the till what it thinks of the token.
          const h = await fetch(`${pair.url}/v1/health`, { headers: { authorization: `Bearer ${pair.token}` } }).catch(() => null);
          reject(err(h?.status === 401 ? 'unauthorized' : 'unreachable'));
        };
      });
      return { id, close: () => ws.close() };
    },
  };
}
