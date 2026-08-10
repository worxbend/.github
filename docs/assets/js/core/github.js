/**
 * Reads the repository list straight from GitHub, in the visitor's browser, with no credentials.
 *
 * Why it works without a token
 * ----------------------------
 * Everything this site shows is public, and GitHub's REST API serves public data to anonymous
 * callers. It also sends `Access-Control-Allow-Origin: *`, so a browser is allowed to call it
 * directly from another domain — no proxy, no server, no key. A key would be pointless here
 * anyway: anything shipped to a static page is readable by anybody who opens the network tab.
 *
 * The one real constraint is the rate limit: 60 requests an hour, counted per IP address rather
 * than per site. Three things keep us far inside it.
 *
 *   1. One request per account. The list endpoint returns up to 100 repositories in a single
 *      response, and it already carries every field the catalogue needs — description, primary
 *      language, topics, stars, and the last push date. Asking for anything per-repository (the
 *      full language breakdown, for instance) would cost one request each and blow the budget on
 *      the first visit, so the catalogue deliberately does without.
 *   2. A cache with a lifetime. A successful answer is kept in localStorage for CACHE_TTL_MS, and
 *      during that window the page does not call GitHub at all. Reloading the page twenty times
 *      costs nothing.
 *   3. Conditional requests. Each response's ETag is remembered and sent back as `If-None-Match`.
 *      When nothing has changed GitHub answers `304 Not Modified`, and a 304 does not count
 *      against the rate limit at all.
 *
 * What happens when it fails
 * --------------------------
 * Never a blank page. The catalogue falls back in this order: fresh cache, then the network, then
 * a stale cache, then the seed file committed alongside this code. Whichever one answers is
 * reported in `source` so the page can say honestly where its data came from and how old it is.
 */

/**
 * The accounts the catalogue is drawn from. `kind` picks the endpoint: organisations and users
 * live at different paths even though the response shape is identical.
 */
export const ACCOUNTS = [
  { login: 'worxbend', kind: 'org', label: 'worxbend', url: 'https://github.com/worxbend' },
  { login: 'w0rxbend', kind: 'user', label: 'w0rxbend', url: 'https://github.com/w0rxbend' },
  {
    login: 'oleksandr-balyshyn',
    kind: 'user',
    label: 'oleksandr-balyshyn',
    url: 'https://github.com/oleksandr-balyshyn',
  },
];

/** How long a complete answer is trusted before the page asks GitHub again. */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How long an answer that was missing an account is trusted.
 *
 * Much shorter, because it is a stopgap rather than a result. Long enough that a failing account
 * is not retried on every single page view; short enough that a transient outage does not leave a
 * whole account missing from the catalogue for the rest of the day.
 */
export const PARTIAL_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Pagination stops here. Every account currently fits in one page of 100; the cap exists so a
 * mistake in the loop can never turn into a hundred requests against a 60-per-hour budget.
 */
const MAX_PAGES = 3;

const CACHE_KEY = 'wb.gh.cache';
const CACHE_VERSION = 2;

/** Abandon a request that has not answered in this long, so one slow account cannot hang the page. */
const TIMEOUT_MS = 8000;

function endpoint(account, page) {
  const path = account.kind === 'org' ? 'orgs' : 'users';
  return `https://api.github.com/${path}/${account.login}/repos` +
    `?per_page=100&sort=pushed&direction=desc&type=owner&page=${page}`;
}

/**
 * Cut a GitHub API repository object down to the fields the catalogue uses.
 *
 * Storing the raw response would put roughly ten times as much data in localStorage for no gain,
 * and would couple the cache format to GitHub's, so a field they rename would corrupt it.
 */
function normalise(raw, login) {
  return {
    name: raw.name,
    owner: login,
    url: raw.html_url,
    home: typeof raw.homepage === 'string' ? raw.homepage.trim() : '',
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    lang: raw.language || '',
    stars: Number(raw.stargazers_count) || 0,
    forks: Number(raw.forks_count) || 0,
    updated: String(raw.pushed_at || '').slice(0, 10),
    topics: Array.isArray(raw.topics) ? raw.topics.slice(0, 12) : [],
    isFork: Boolean(raw.fork),
    isArchived: Boolean(raw.archived),
  };
}

// --- Cache ---------------------------------------------------------------------------------
//
// Kept separate from core/store.js on purpose. That module is for a handful of small user
// preferences; this is a bulk payload with its own version, its own expiry and its own ETags, and
// mixing the two would mean a corrupt catalogue could take the visitor's theme down with it.

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.version !== CACHE_VERSION || !Array.isArray(parsed.repos)) return null;
    return parsed;
  } catch {
    // Unparseable, or storage is blocked entirely. Either way there is no usable cache.
    return null;
  }
}

function writeCache(entry) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Private mode, or the origin is at its quota. The catalogue still works for this visit; it
    // just costs two requests again next time, which the rate limit can afford.
  }
}

export function clearCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* nothing to clear if storage is unavailable */
  }
}

// --- Fetching ------------------------------------------------------------------------------

/**
 * Follow `Link: <…>; rel="next"` to see whether another page exists.
 *
 * GitHub does not report a total; the only signal is this header. It is readable from a browser
 * because GitHub names Link in `Access-Control-Expose-Headers`.
 */
function hasNextPage(response) {
  const link = response.headers.get('Link');
  return typeof link === 'string' && /rel="next"/.test(link);
}

async function fetchAccount(account, etags, signal) {
  const repos = [];
  let notModified = false;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = endpoint(account, page);
    const headers = { Accept: 'application/vnd.github+json' };
    // Only revalidate the first page. A conditional request on a later page is not meaningful
    // once an earlier one has changed, and every account fits in one page today anyway.
    if (page === 1 && etags[url]) headers['If-None-Match'] = etags[url];

    const response = await fetch(url, { headers, signal, mode: 'cors', cache: 'no-store' });

    if (response.status === 304) {
      // Nothing has changed since the cached copy, and this answer was free.
      notModified = true;
      break;
    }
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get('X-RateLimit-Remaining');
      const reset = Number(response.headers.get('X-RateLimit-Reset')) * 1000;
      const error = new Error(`GitHub rate limit reached for ${account.login}`);
      error.rateLimited = remaining === '0';
      error.resetAt = Number.isFinite(reset) ? reset : null;
      throw error;
    }
    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status} for ${account.login}`);
    }

    const etag = response.headers.get('ETag');
    if (page === 1 && etag) etags[url] = etag;

    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error(`unexpected response shape for ${account.login}`);
    for (const raw of batch) repos.push(normalise(raw, account.login));

    if (batch.length < 100 || !hasNextPage(response)) break;
    if (page === MAX_PAGES) {
      console.warn(
        `[github] ${account.login} has more than ${MAX_PAGES * 100} repositories; the rest are ` +
        'not shown. Raise MAX_PAGES in core/github.js if that becomes real.',
      );
    }
  }

  return { repos, notModified };
}

/**
 * Get the repository list, preferring the cheapest source that can answer.
 *
 * @param {object} options
 * @param {Array}  options.seed    committed fallback, used when nothing else answers
 * @param {boolean} options.force  ignore a fresh cache and revalidate now
 * @returns {Promise<{repos: Array, source: string, fetchedAt: number|null, error: Error|null,
 *                    accounts: string[]}>}
 */
export async function fetchCatalog({ seed = [], force = false } = {}) {
  const cached = readCache();
  const now = Date.now();

  // If any account failed last time, the answer is trusted for a few minutes rather than six
  // hours, so the failure is retried soon. Otherwise one timeout on a first visit would hide a
  // whole account for the rest of the day — and because a cache hit reports no error, the page
  // would cheerfully say everything was fine.
  const ttl = cached?.partial ? PARTIAL_CACHE_TTL_MS : CACHE_TTL_MS;
  if (!force && cached && now - cached.fetchedAt < ttl) {
    return {
      repos: cached.repos,
      source: 'cache',
      fetchedAt: cached.fetchedAt,
      error: null,
      accounts: cached.accounts || [],
    };
  }

  const etags = { ...(cached?.etags || {}) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const settled = await Promise.allSettled(
      ACCOUNTS.map((account) => fetchAccount(account, etags, controller.signal)),
    );

    const repos = [];
    const reached = [];
    let unchangedAccounts = 0;
    let firstError = null;

    settled.forEach((result, index) => {
      const login = ACCOUNTS[index].login;
      if (result.status === 'rejected') {
        firstError = firstError || result.reason;
        return;
      }
      reached.push(login);
      if (result.value.notModified) {
        unchangedAccounts += 1;
        // Nothing changed, so reuse this account's rows from the cache.
        if (cached) repos.push(...cached.repos.filter((r) => r.owner === login));
        return;
      }
      repos.push(...result.value.repos);
    });

    // Every account answered "not modified": the cached copy is still current, so re-stamp it
    // rather than treating it as expired and asking again on the next page view.
    if (reached.length === ACCOUNTS.length && unchangedAccounts === ACCOUNTS.length && cached) {
      // Every account answered, so whatever was incomplete about this cache no longer is. Spreading
      // `cached` unchanged would carry a stale `partial: true` forward, and the shortened lifetime
      // that flag buys would then make the page revalidate every five minutes for good — long
      // after GitHub confirmed all three accounts were current.
      const entry = { ...cached, fetchedAt: now, etags, accounts: reached, partial: false };
      writeCache(entry);
      return { repos: cached.repos, source: 'revalidated', fetchedAt: now, error: null,
               accounts: reached, partial: false };
    }

    // A partial answer is still better than none, but it must not overwrite a complete cache with
    // a shorter list, or one account being briefly unreachable would erase it from the catalogue.
    if (reached.length === 0) throw firstError || new Error('no account could be reached');
    if (reached.length < ACCOUNTS.length && cached) {
      for (const login of ACCOUNTS.map((a) => a.login)) {
        if (!reached.includes(login)) repos.push(...cached.repos.filter((r) => r.owner === login));
      }
    }

    const partial = reached.length < ACCOUNTS.length;
    const entry = { version: CACHE_VERSION, fetchedAt: now, repos, etags, accounts: reached, partial };
    writeCache(entry);
    return { repos, source: 'network', fetchedAt: now, error: firstError, accounts: reached, partial };
  } catch (error) {
    // The network is the least reliable link in the chain, so failing here is expected rather
    // than exceptional: fall back to whatever is on hand and say so.
    if (cached) {
      return { repos: cached.repos, source: 'stale-cache', fetchedAt: cached.fetchedAt,
               error, accounts: cached.accounts || [] };
    }
    return { repos: seed, source: 'seed', fetchedAt: null, error, accounts: [] };
  } finally {
    clearTimeout(timer);
  }
}
