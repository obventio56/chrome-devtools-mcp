/**
 * Browserbase session management for chrome-devtools-mcp.
 *
 * Creates hosted browser sessions via the Browserbase API and connects
 * Puppeteer over CDP WebSocket.  Sessions are automatically closed on
 * process exit / SIGTERM / SIGINT.
 */

import type {Browser, Target} from './third_party/index.js';
import {puppeteer} from './third_party/index.js';
import {logger} from './logger.js';

const BROWSERBASE_API = 'https://api.browserbase.com/v1';

export interface BrowserbaseOptions {
  apiKey: string;
  projectId: string;
  sessionId?: string;   // Reuse an existing session instead of creating one
  proxy?: boolean;
  keepAlive?: boolean;
}

interface BrowserbaseSession {
  id: string;
  connectUrl: string;
}

let activeSession: BrowserbaseSession | undefined;
let activeBrowser: Browser | undefined;
let cleanupRegistered = false;

function makeTargetFilter() {
  const ignoredPrefixes = new Set([
    'chrome://',
    'chrome-extension://',
    'chrome-untrusted://',
  ]);
  return function targetFilter(target: Target): boolean {
    if (target.url() === 'chrome://newtab/') return true;
    if (target.url().startsWith('chrome://inspect')) return true;
    for (const prefix of ignoredPrefixes) {
      if (target.url().startsWith(prefix)) return false;
    }
    return true;
  };
}

async function createSession(
  opts: BrowserbaseOptions,
): Promise<BrowserbaseSession> {
  const body: Record<string, unknown> = {
    projectId: opts.projectId,
  };
  if (opts.proxy) {
    body.proxies = true;
  }
  if (opts.keepAlive) {
    body.keepAlive = true;
  }

  logger('Creating Browserbase session', JSON.stringify(body));
  const res = await fetch(`${BROWSERBASE_API}/sessions`, {
    method: 'POST',
    headers: {
      'x-bb-api-key': opts.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Browserbase session creation failed (${res.status}): ${text}`,
    );
  }

  const session = (await res.json()) as BrowserbaseSession;
  logger(`Browserbase session created: ${session.id}`);
  return session;
}

async function retrieveConnectUrl(
  apiKey: string,
  sessionId: string,
): Promise<string> {
  logger(`Retrieving connect URL for existing session: ${sessionId}`);
  const res = await fetch(
    `${BROWSERBASE_API}/sessions/${sessionId}/debug`,
    {
      headers: {'x-bb-api-key': apiKey},
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Browserbase debug info retrieval failed (${res.status}): ${text}`,
    );
  }
  const data = (await res.json()) as {debuggerFullscreenUrl: string; wsUrl: string};
  return data.wsUrl;
}

async function closeSession(apiKey: string, sessionId: string): Promise<void> {
  logger(`Closing Browserbase session: ${sessionId}`);
  try {
    const res = await fetch(
      `${BROWSERBASE_API}/sessions/${sessionId}`,
      {
        method: 'POST',
        headers: {
          'x-bb-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({status: 'REQUEST_RELEASE'}),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      logger(`Warning: session close returned ${res.status}: ${text}`);
    } else {
      logger(`Browserbase session ${sessionId} closed`);
    }
  } catch (err) {
    logger(`Warning: failed to close Browserbase session: ${err}`);
  }
}

function registerCleanup(apiKey: string, ownedSession: boolean): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const cleanup = () => {
    if (activeSession && ownedSession) {
      // Fire-and-forget — process is exiting
      void closeSession(apiKey, activeSession.id);
    }
  };

  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('beforeExit', cleanup);
}

export async function ensureBrowserbaseConnected(
  opts: BrowserbaseOptions,
): Promise<Browser> {
  if (activeBrowser?.connected) {
    return activeBrowser;
  }

  let ownedSession = false;

  if (opts.sessionId) {
    // Reuse an existing session — retrieve its connect URL
    const connectUrl = await retrieveConnectUrl(opts.apiKey, opts.sessionId);
    activeSession = {id: opts.sessionId, connectUrl};
  } else {
    // Create a fresh session
    activeSession = await createSession(opts);
    ownedSession = true;
  }

  console.error(`[browserbase] Session: ${activeSession.id}`);
  console.error(
    `[browserbase] Connect: ${activeSession.connectUrl.slice(0, 60)}...`,
  );

  registerCleanup(opts.apiKey, ownedSession);

  activeBrowser = await puppeteer.connect({
    browserWSEndpoint: activeSession.connectUrl,
    targetFilter: makeTargetFilter(),
    defaultViewport: null,
  });

  logger('Puppeteer connected to Browserbase session');
  return activeBrowser;
}

/**
 * Returns the active Browserbase session ID, if any.
 */
export function getActiveSessionId(): string | undefined {
  return activeSession?.id;
}
