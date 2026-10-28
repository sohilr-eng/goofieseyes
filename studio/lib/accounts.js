/**
 * Who we post as, and with which token.
 *
 * Env vars:
 *   META_SYSTEM_USER_TOKEN  (required for Facebook + Instagram) — the
 *                           never-expiring token from Business Settings →
 *                           System users. See docs/studio-setup.md, step 3.
 *   FB_PAGE_ID              (optional) — only needed if the system user can see
 *                           more than one Page; otherwise it's discovered.
 *   THREADS_ACCESS_TOKEN    (required for Threads) — the long-lived token from
 *                           the Threads use case's token generator. Used once to
 *                           seed the store; after that the daily cron refreshes
 *                           the stored copy, because it lives 60 days.
 *
 * Facebook posts need a Page token, not the system user token itself, so it's
 * fetched from the Page and cached for the life of the function instance.
 */

const { facebook, threads } = require('./graph');
const { getStore } = require('./store');

const THREADS_TOKEN_KEY = 'threads:token';
let cachedMeta = null;

async function metaAccount() {
  if (cachedMeta) return cachedMeta;
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) throw new Error('META_SYSTEM_USER_TOKEN is not set (docs/studio-setup.md, step 3).');

  const fields = 'id,name,access_token,instagram_business_account{id,username}';
  let page;
  if (process.env.FB_PAGE_ID) {
    page = await facebook.get(`/${process.env.FB_PAGE_ID}`, { fields }, token);
  } else {
    const { data = [] } = await facebook.get('/me/accounts', { fields }, token);
    if (data.length === 0) throw new Error('The system user has no Pages assigned. Assign the GoofiesEyes Page to it (setup step 3).');
    if (data.length > 1) throw new Error(`The system user can see ${data.length} Pages (${data.map((p) => p.name).join(', ')}). Set FB_PAGE_ID to the one to post as.`);
    page = data[0];
  }

  cachedMeta = {
    token,
    pageId: page.id,
    pageName: page.name,
    pageToken: page.access_token,
    igUserId: page.instagram_business_account?.id || null,
    igUsername: page.instagram_business_account?.username || null,
  };
  return cachedMeta;
}

async function threadsToken() {
  const stored = await getStore().get(THREADS_TOKEN_KEY);
  if (stored?.token) return stored;
  const seed = process.env.THREADS_ACCESS_TOKEN;
  if (!seed) throw new Error('THREADS_ACCESS_TOKEN is not set (docs/studio-setup.md, step 4).');
  // Expiry unknown for a seed token; the daily cron refreshes it and learns it.
  return { token: seed, expiresAt: null, source: 'env' };
}

async function threadsAccount() {
  const { token, expiresAt } = await threadsToken();
  const me = await threads.get('/me', { fields: 'id,username' }, token);
  return { token, expiresAt, userId: me.id, username: me.username };
}

// Swaps the current long-lived token for a fresh 60-day one. Meta only allows
// this once the token is at least 24 hours old, so a failure the day you set it
// up is expected and harmless: the stored or env token keeps working.
async function refreshThreadsToken() {
  const { token } = await threadsToken();
  const url = new URL('https://graph.threads.net/refresh_access_token');
  url.searchParams.set('grant_type', 'th_refresh_token');
  url.searchParams.set('access_token', token);
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error?.message || `Threads token refresh failed (HTTP ${res.status})`);
  }
  const record = {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 0) * 1000,
    refreshedAt: Date.now(),
    source: 'refresh',
  };
  await getStore().set(THREADS_TOKEN_KEY, record);
  return record;
}

function resetAccountCacheForTests() {
  cachedMeta = null;
}

module.exports = { metaAccount, threadsAccount, threadsToken, refreshThreadsToken, resetAccountCacheForTests };
