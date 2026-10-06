import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PAGE_SCRIPT, SKIN_PREFIX, difitSkinCss, injectSkin, sendButtonCss } from './difitSkin.ts';
import type { DifitThread } from './difitSkin.ts';
import type { Palette } from './theme.ts';

/** What the send button gets back: a line to show, and the prompt when it could not be sent. */
export interface SendOutcome {
  ok: boolean;
  detail: string;
  /** The prompt, for the page to put on the clipboard when no pane took it. */
  clipboard?: string;
}

export interface ReviewProxyOptions {
  /** difit's own address, `http://localhost:4966`. */
  upstream: string;
  palette: Palette;
  /**
   * Hand the threads to the agent. Asked at click time, not when the review
   * opened: the agent may have been started, or replaced, since.
   */
  send: (threads: DifitThread[]) => Promise<SendOutcome>;
}

export interface ReviewProxy {
  url: string;
  close: () => void;
}

/**
 * A local server in front of difit, serving its page with fleetwood's skin.
 *
 * Everything is passed through untouched except difit's HTML, which gains the
 * stylesheet and the send button, and the few routes under `SKIN_PREFIX`. The
 * pass-through streams rather than buffers, which is load-bearing: difit's
 * `/api/heartbeat` is an SSE stream, and difit shuts itself down when it
 * closes. Piped, the browser tab closing closes the upstream request too, so the
 * self-shutdown the review relies on survives being proxied.
 */
export async function startReviewProxy(options: ReviewProxyOptions): Promise<ReviewProxy> {
  const upstream = new URL(options.upstream);
  const css = difitSkinCss(options.palette) + sendButtonCss(options.palette);

  const api = async (method: string, path: string): Promise<unknown> => {
    const res = await fetch(new URL(path, upstream), { method });
    if (!res.ok) throw new Error(`difit answered ${res.status} to ${method} ${path}`);
    return res.json();
  };

  const send = async (search: string): Promise<SendOutcome> => {
    const body = (await api('GET', `/api/comments-json${search}`)) as { threads?: DifitThread[] };
    const threads = body.threads ?? [];
    if (threads.length === 0) return { ok: false, detail: 'no comments to send' };
    const outcome = await options.send(threads);
    // Resolved only once they reached a pane, as the nvim review cleared its
    // store: what is left on the page is what the agent has not been told.
    // difit tells the page itself, which refetches.
    if (outcome.ok && !outcome.clipboard) {
      const scope = search ? `${search}` : '';
      for (const thread of threads) {
        await api('DELETE', `/api/comments/${encodeURIComponent(thread.id)}${scope}`).catch(() => undefined);
      }
    }
    return outcome;
  };

  const proxy = (req: IncomingMessage, res: ServerResponse, rewriteHtml: boolean): void => {
    const headers = { ...req.headers, host: upstream.host };
    // The page is rewritten, so it has to arrive as text this side can read.
    if (rewriteHtml) delete headers['accept-encoding'];
    const out = httpRequest(
      { host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers },
      (up) => {
        const html = rewriteHtml && (up.headers['content-type'] ?? '').includes('text/html');
        if (!html) {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
          return;
        }
        const chunks: Buffer[] = [];
        up.on('data', (chunk: Buffer) => chunks.push(chunk));
        up.on('end', () => {
          const page = injectSkin(Buffer.concat(chunks).toString('utf8'));
          const { 'content-length': _length, etag: _etag, ...rest } = up.headers;
          res.writeHead(up.statusCode ?? 200, { ...rest, 'cache-control': 'no-store' });
          res.end(page);
        });
      },
    );
    out.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('difit is not answering — the review has ended');
    });
    // The tab going away has to reach difit, or its heartbeat never closes.
    res.on('close', () => out.destroy());
    req.pipe(out);
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname === `${SKIN_PREFIX}/skin.css`) {
      res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-store' });
      res.end(css);
      return;
    }
    if (url.pathname === `${SKIN_PREFIX}/page.js`) {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      res.end(PAGE_SCRIPT);
      return;
    }
    if (url.pathname === `${SKIN_PREFIX}/send` && req.method === 'POST') {
      send(url.search)
        .catch((error: Error): SendOutcome => ({ ok: false, detail: error.message }))
        .then((outcome) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(outcome));
        });
      return;
    }
    // Only a page load can be the HTML; the API and assets go straight through.
    const page = req.method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/assets/');
    proxy(req, res, page);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
