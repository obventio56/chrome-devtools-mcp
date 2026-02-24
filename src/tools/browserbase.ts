/**
 * Browserbase-specific tools.
 */

import {getActiveSessionId} from '../browserbase.js';
import {zod} from '../third_party/index.js';
import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

export const getSessionInfo = defineTool({
  name: 'browserbase_get_session_info',
  description:
    'Returns the active Browserbase session ID. Useful for interacting with the Browserbase API directly (e.g. the Downloads API).',
  annotations: {
    title: 'Browserbase Session Info',
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {},
  handler: async (_request, response) => {
    const sessionId = getActiveSessionId();
    if (sessionId) {
      response.appendResponseLine(`Browserbase session ID: ${sessionId}`);
      response.appendResponseLine(
        `Downloads API: curl -o /tmp/downloads.zip "https://api.browserbase.com/v1/sessions/${sessionId}/downloads" -H "X-BB-API-Key: $BROWSERBASE_API_KEY"`,
      );
    } else {
      response.appendResponseLine(
        'No active Browserbase session. The server is using a local or externally-connected browser.',
      );
    }
  },
});
