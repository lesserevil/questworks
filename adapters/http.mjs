/**
 * adapters/http.mjs — Shared HTTP utility for all QuestWorks adapters.
 *
 * Exports:
 *   AdapterError   — standard error class for all adapter HTTP failures
 *   bearerAuth()   — builds Bearer Authorization header object
 *   basicAuth()    — builds Basic Authorization header object
 *   fetchJson()    — fetch wrapper with error handling and 429 retry
 *
 * All three external adapters (GitHub, Jira, Beads) import from this module.
 * No adapter should define its own fetch wrapper.
 */

/**
 * Standard error class for adapter HTTP failures.
 *
 * @property {number} status  HTTP status code, or 0 for network errors
 * @property {string|null} body  Raw response text, or null for network errors
 */
export class AdapterError extends Error {
  /**
   * @param {string} message
   * @param {number} [status=0]  HTTP status code or 0 for network errors
   * @param {string|null} [body=null]  Raw response body text
   */
  constructor(message, status = 0, body = null) {
    super(message);
    this.name = 'AdapterError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Returns a Bearer Authorization header object.
 *
 * @param {string} token
 * @returns {{ Authorization: string }}
 */
export function bearerAuth(token) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Returns a Basic Authorization header object (for Jira and similar).
 *
 * @param {string} user   Username or email
 * @param {string} token  Password or API token
 * @returns {{ Authorization: string }}
 */
export function basicAuth(user, token) {
  const encoded = Buffer.from(`${user}:${token}`).toString('base64');
  return { Authorization: `Basic ${encoded}` };
}

/**
 * Sleep for the given number of milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a URL and return parsed JSON.
 *
 * Retry behavior on 429 (Too Many Requests):
 *   - If Retry-After header is present and <= 60s: wait that long, retry once.
 *   - If Retry-After header is present and > 60s: throw immediately (no retry).
 *   - If Retry-After header is absent: wait 1s, retry once.
 *   - options.retryOn429 = false disables all retry logic.
 *
 * No retry on other 4xx or 5xx responses.
 *
 * @param {string} url
 * @param {RequestInit & { retryOn429?: boolean }} [options={}]
 * @returns {Promise<any>}  Parsed JSON body
 * @throws {AdapterError}
 */
export async function fetchJson(url, options = {}) {
  const { retryOn429 = true, ...fetchOptions } = options;

  /**
   * Execute a single fetch attempt.
   *
   * @returns {{ retry: boolean, waitMs?: number, result?: any, error?: AdapterError }}
   */
  async function attempt() {
    let response;

    try {
      response = await fetch(url, fetchOptions);
    } catch (err) {
      throw new AdapterError(err.message, 0, null);
    }

    if (response.status === 429 && retryOn429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      let waitSeconds = 1; // default if no header
      let shouldRetry = true;

      if (retryAfterHeader !== null) {
        const parsed = parseInt(retryAfterHeader, 10);
        if (!isNaN(parsed)) {
          if (parsed > 60) {
            // Wait too long — don't retry
            shouldRetry = false;
          } else {
            waitSeconds = parsed;
          }
        }
      }

      if (!shouldRetry) {
        const body = await response.text().catch(() => null);
        throw new AdapterError(
          `HTTP 429 Too Many Requests (Retry-After: ${retryAfterHeader} exceeds limit)`,
          429,
          body,
        );
      }

      return { retry: true, waitMs: waitSeconds * 1000 };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => null);
      throw new AdapterError(
        `HTTP ${response.status} ${response.statusText}`,
        response.status,
        body,
      );
    }

    const json = await response.json();
    return { retry: false, result: json };
  }

  // First attempt
  const first = await attempt();
  if (!first.retry) {
    return first.result;
  }

  // Single retry after waiting
  await sleep(first.waitMs);
  const second = await attempt();
  if (!second.retry) {
    return second.result;
  }

  // Should not happen (retry only once), but handle defensively
  throw new AdapterError('HTTP 429 Too Many Requests after retry', 429, null);
}
