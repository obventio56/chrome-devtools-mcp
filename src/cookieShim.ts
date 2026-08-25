
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Legacy cookie / connection-affinity shim.
 *
 * Some payment/session backends (e.g. F5-fronted TrustCommerce) set their
 * session/persistence cookie without a `SameSite` attribute.  Chrome treats
 * such cookies as `SameSite=Lax` and silently refuses to store them when the
 * response is loaded in a cross-site iframe.  On top of that, these backends
 * rely on connection-based load-balancer affinity: a normal desktop browser
 * keeps one keep-alive connection to one backend node, but proxied browsers
 * (like Browserbase) fan requests out across upstream connections, so
 * session-bound state such as CSRF tokens is minted on one node and validated
 * on another — the embedded form then fails even though the same flow works
 * in a local browser.
 *
 * The shim intercepts cross-site iframe document requests (out-of-process or
 * in-process — same-site frames are unaffected by SameSite=Lax and are passed
 * through).  When an origin with an empty cookie jar is first seen, it is
 * probed from the MCP process; if the probe response sets a SameSite-less
 * cookie, the origin is treated as a legacy origin:
 *
 *  1. its cookies are stored in the browser as `SameSite=None; Secure`, and
 *  2. every subsequent document request to it is served through a dedicated
 *     single-socket keep-alive agent in the MCP process (transparently, via
 *     `Fetch.fulfillRequest`), restoring the connection affinity of a normal
 *     desktop browser.  Redirects are not followed — the browser sees them
 *     and navigates normally, so cross-origin callbacks/result redirects fire
 *     exactly as they would unshimmed.
 */

import {Agent, request as httpsRequest} from 'node:https';

import {logger} from './logger.js';
import type {Browser, CDPSession, Protocol} from './third_party/index.js';
import {CDPSessionEvent} from './third_party/index.js';

const PROXY_TIMEOUT_MS = 30_000;

interface ParsedCookie {
  name: string;
  value: string;
  domain?: string;
  path: string;
  expires?: number;
}

interface ProxiedResponse {
  status: number;
  headers: Array<{name: string; value: string}>;
  body: Buffer;
  setCookies: string[];
}

interface ShimState {
  primedOrigins: Set<string>;
  pinnedAgents: Map<string, Agent>;
  attachedSessions: WeakSet<CDPSession>;
}

function parseSetCookie(line: string): ParsedCookie | undefined {
  const parts = line.split(';');
  const first = parts.shift();
  if (!first) {return undefined;}
  const eq = first.indexOf('=');
  if (eq <= 0) {return undefined;}
  const cookie: ParsedCookie = {
    name: first.slice(0, eq).trim(),
    value: first.slice(eq + 1).trim(),
    path: '/',
  };
  if (!cookie.name) {return undefined;}
  for (const part of parts) {
    const attrEq = part.indexOf('=');
    const key = (attrEq === -1 ? part : part.slice(0, attrEq))
      .trim()
      .toLowerCase();
    const val = attrEq === -1 ? '' : part.slice(attrEq + 1).trim();
    if (key === 'domain' && val) {cookie.domain = val;}
    else if (key === 'path' && val) {cookie.path = val;}
    else if (key === 'max-age' && val) {
      const seconds = Number(val);
      if (Number.isFinite(seconds)) {
        cookie.expires = Math.floor(Date.now() / 1000) + seconds;
      }
    } else if (key === 'expires' && val && cookie.expires === undefined) {
      const ts = Date.parse(val);
      if (Number.isFinite(ts)) {cookie.expires = Math.floor(ts / 1000);}
    }
  }
  return cookie;
}

function hasSameSite(line: string): boolean {
  return /;\s*samesite\s*=/i.test(line);
}

/** Store a legacy cookie in the browser jar as SameSite=None; Secure. */
async function storeUpgradedCookie(
  session: CDPSession,
  url: string,
  cookie: ParsedCookie,
): Promise<void> {
  await session.send('Network.setCookie', {
    name: cookie.name,
    value: cookie.value,
    url,
    ...(cookie.domain ? {domain: cookie.domain} : {}),
    path: cookie.path,
    ...(cookie.expires !== undefined ? {expires: cookie.expires} : {}),
    secure: true,
    sameSite: 'None',
  });
  logger(
    `[cookieShim] stored legacy cookie ${cookie.name} for ` +
      `${cookie.domain ?? new URL(url).hostname} as SameSite=None; Secure`,
  );
}

/**
 * Perform one HTTPS request over the given (single-socket, keep-alive) agent
 * without following redirects.
 */
function proxiedRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  agent: Agent,
): Promise<ProxiedResponse> {
  return new Promise((resolve, reject) => {
    const outHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      // Connection management belongs to our agent; force identity encoding
      // so the fulfilled body needs no re-encoding bookkeeping.
      if (
        lower === 'connection' ||
        lower === 'keep-alive' ||
        lower === 'accept-encoding' ||
        lower === 'content-length'
      ) {
        continue;
      }
      outHeaders[name] = value;
    }
    outHeaders['Accept-Encoding'] = 'identity';
    if (body !== undefined) {
      outHeaders['Content-Length'] = String(body.length);
    }

    const req = httpsRequest(
      url,
      {method, headers: outHeaders, agent, timeout: PROXY_TIMEOUT_MS},
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () => {
          const responseHeaders: Array<{name: string; value: string}> = [];
          const setCookies: string[] = res.headers['set-cookie'] ?? [];
          for (const [name, value] of Object.entries(res.headers)) {
            const lower = name.toLowerCase();
            if (
              lower === 'set-cookie' ||
              lower === 'connection' ||
              lower === 'keep-alive' ||
              lower === 'transfer-encoding' ||
              lower === 'content-length'
            ) {
              continue;
            }
            if (typeof value === 'string') {
              responseHeaders.push({name, value});
            } else if (Array.isArray(value)) {
              for (const v of value) {responseHeaders.push({name, value: v});}
            }
          }
          resolve({
            status: res.statusCode ?? 200,
            headers: responseHeaders,
            body: Buffer.concat(chunks),
            setCookies,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('proxied request timeout')));
    req.on('error', reject);
    if (body !== undefined) {req.write(body);}
    req.end();
  });
}

/**
 * Serve the paused request through the origin's pinned single-connection
 * agent and fulfill it in the browser.
 */
async function fulfillViaPinnedAgent(
  session: CDPSession,
  event: Protocol.Fetch.RequestPausedEvent,
  agent: Agent,
): Promise<void> {
  const {requestId, request} = event;

  let body: Buffer | undefined;
  if (request.postData !== undefined) {
    body = Buffer.from(request.postData, 'utf8');
  } else if (request.hasPostData) {
    // Body too large to be inlined in the paused event; pass the request
    // through rather than replaying it without its body.
    logger(
      `[cookieShim] ${request.url} has a non-inlined post body; not pinning`,
    );
    await session.send('Fetch.continueRequest', {requestId});
    return;
  }

  const response = await proxiedRequest(
    request.url,
    request.method,
    request.headers,
    body,
    agent,
  );

  for (const line of response.setCookies) {
    const cookie = parseSetCookie(line);
    if (!cookie) {continue;}
    await storeUpgradedCookie(session, request.url, cookie);
  }

  logger(
    `[cookieShim] pinned ${request.method} ${request.url} -> ${response.status}`,
  );
  await session.send('Fetch.fulfillRequest', {
    requestId,
    responseCode: response.status,
    responseHeaders: response.headers,
    body: response.body.toString('base64'),
  });
}

/**
 * Request-stage handler for cross-site iframe document requests.  Probes
 * unknown origins for the legacy-cookie signature and, for legacy origins,
 * serves the request through the pinned agent.
 */
async function handlePausedRequest(
  session: CDPSession,
  event: Protocol.Fetch.RequestPausedEvent,
  state: ShimState,
): Promise<void> {
  const {requestId, request} = event;
  const url = request.url;
  const origin = new URL(url).origin;

  const pinned = state.pinnedAgents.get(origin);
  if (pinned) {
    await fulfillViaPinnedAgent(session, event, pinned);
    return;
  }

  if (state.primedOrigins.has(origin) || !url.startsWith('https://')) {
    await session.send('Fetch.continueRequest', {requestId});
    return;
  }
  state.primedOrigins.add(origin);

  // A populated jar means the origin's cookies are being stored normally —
  // it does not have the legacy-cookie problem.
  const {cookies: existing} = await session.send('Network.getCookies', {
    urls: [url],
  });
  if (existing.length > 0) {
    await session.send('Fetch.continueRequest', {requestId});
    return;
  }

  const agent = new Agent({keepAlive: true, maxSockets: 1});
  let legacyCookies: ParsedCookie[];
  try {
    const probe = await proxiedRequest(url, 'GET', {}, undefined, agent);
    legacyCookies = probe.setCookies
      .filter(line => !hasSameSite(line))
      .map(parseSetCookie)
      .filter((c): c is ParsedCookie => c !== undefined);
  } catch (err) {
    logger(`[cookieShim] probe for ${origin} failed: ${err}`);
    agent.destroy();
    await session.send('Fetch.continueRequest', {requestId});
    return;
  }

  if (legacyCookies.length === 0) {
    agent.destroy();
    await session.send('Fetch.continueRequest', {requestId});
    return;
  }

  logger(
    `[cookieShim] ${origin} sets SameSite-less cookies in a cross-site ` +
      `iframe; pinning its documents to a single upstream connection`,
  );
  state.pinnedAgents.set(origin, agent);
  for (const cookie of legacyCookies) {
    await storeUpgradedCookie(session, url, cookie);
  }
  await fulfillViaPinnedAgent(session, event, agent);
}

async function attachSession(
  session: CDPSession,
  state: ShimState,
): Promise<void> {
  if (state.attachedSessions.has(session)) {return;}
  state.attachedSessions.add(session);

  let info: Protocol.Target.GetTargetInfoResponse;
  try {
    info = await session.send('Target.getTargetInfo');
  } catch {
    return; // session already detached
  }
  const {targetId, type} = info.targetInfo;
  if (type !== 'iframe' && type !== 'page') {return;}

  // On a page session, the target's own (main) frame is first-party: Chrome
  // stores SameSite-less cookies there as Lax without help, so pass those
  // documents through.  Subframe documents on the page session are same-
  // process iframes; out-of-process iframes arrive as their own 'iframe'
  // targets, where every document belongs to the (cross-site) iframe.
  const mainFrameId = type === 'page' ? targetId : undefined;

  session.on('Fetch.requestPaused', event => {
    if (mainFrameId !== undefined && event.frameId === mainFrameId) {
      void session
        .send('Fetch.continueRequest', {requestId: event.requestId})
        .catch(() => undefined);
      return;
    }
    void handlePausedRequest(session, event, state).catch(err => {
      logger(`[cookieShim] paused-request handler error: ${err}`);
      void session
        .send('Fetch.continueRequest', {requestId: event.requestId})
        .catch(() => undefined);
    });
  });

  try {
    await session.send('Fetch.enable', {
      patterns: [
        {
          urlPattern: 'https://*',
          resourceType: 'Document',
          requestStage: 'Request',
        },
      ],
    });
  } catch (err) {
    logger(`[cookieShim] Fetch.enable failed: ${err}`);
  }
}

/**
 * Installs the legacy cookie / connection-affinity shim on every current and
 * future page (and out-of-process iframe) of the browser.
 */
export function installLegacyCookieShim(browser: Browser): void {
  const state: ShimState = {
    primedOrigins: new Set(),
    pinnedAgents: new Map(),
    attachedSessions: new WeakSet(),
  };

  void browser
    .target()
    .createCDPSession()
    .then(session => {
      const connection = session.connection();
      if (!connection) {
        logger('[cookieShim] no CDP connection available');
        return;
      }
      connection.on(CDPSessionEvent.SessionAttached, (child: CDPSession) => {
        void attachSession(child, state).catch(err => {
          logger(`[cookieShim] session attach failed: ${err}`);
        });
      });
      logger('[cookieShim] installed');
    })
    .catch(err => logger(`[cookieShim] install failed: ${err}`));

  // Pages that were already open (and thus already attached) when the shim
  // was installed.
  browser
    .pages()
    .then(pages =>
      Promise.all(
        pages.map(async page => {
          const session = await page.createCDPSession();
          await attachSession(session, state);
        }),
      ),
    )
    .catch(err => logger(`[cookieShim] initial page attach failed: ${err}`));
}
