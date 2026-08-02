// Surfaces the Claude subscription usage limits (5-hour session, weekly, and
// per-model like Fable) that the `claude` CLI shows via /usage.
//
// Lean design: read the OAuth access token the CLI already stores at
// ~/.claude/.credentials.json and call the same endpoint the CLI uses. Claude
// Code refreshes that token in the file as it runs, so we simply reuse it; if
// it is missing or expired we report `available: false` and let the UI hide the
// widget rather than erroring. The token never leaves the server.
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import express from 'express';

const router = express.Router();

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60_000;

// Kinds we surface, in display order. Anything else the API returns is ignored.
const SURFACED_KINDS = new Set(['session', 'weekly_all', 'weekly_scoped']);

let cache = { at: 0, payload: null };

/**
 * Reads the stored OAuth token. Returns null when the file is absent,
 * unreadable, or the token has expired.
 */
async function readOauthToken() {
  try {
    const raw = await readFile(CREDENTIALS_PATH, 'utf8');
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    const token = typeof oauth?.accessToken === 'string' ? oauth.accessToken : null;
    if (!token) {
      return null;
    }
    // expiresAt is epoch ms. Treat a near-expiry token as expired (30s skew).
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now() + 30_000) {
      return { token, expired: true };
    }
    return { token, expired: false };
  } catch {
    return null;
  }
}

async function fetchUsage(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'cloudcli-usage/1',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { available: false, reason: `upstream_${response.status}` };
    }
    return { available: true, data: await response.json() };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'timeout' : 'network_error';
    return { available: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalizes the raw usage payload into the small shape the UI needs. Uses the
 * ready-made `limits` array (the same one the CLI renders), keeping only the
 * kinds we surface and exposing a per-model display name when scoped.
 */
function normalize(data) {
  const rawLimits = Array.isArray(data?.limits) ? data.limits : [];
  const limits = rawLimits
    .filter((limit) => SURFACED_KINDS.has(limit?.kind))
    .map((limit) => ({
      kind: limit.kind,
      group: limit.group ?? null,
      percent: typeof limit.percent === 'number' ? limit.percent : null,
      severity: limit.severity ?? 'normal',
      resetsAt: limit.resets_at ?? null,
      model: limit?.scope?.model?.display_name ?? null,
    }));
  return { available: true, fetchedAt: new Date().toISOString(), limits };
}

router.get('/', async (req, res) => {
  if (cache.payload && Date.now() - cache.at < CACHE_TTL_MS) {
    return res.json(cache.payload);
  }

  const creds = await readOauthToken();
  if (!creds) {
    return res.json({ available: false, reason: 'no_token' });
  }
  if (creds.expired) {
    return res.json({ available: false, reason: 'token_expired' });
  }

  const result = await fetchUsage(creds.token);
  if (!result.available) {
    // Do not cache failures — the token may refresh momentarily.
    return res.json({ available: false, reason: result.reason });
  }

  const payload = normalize(result.data);
  cache = { at: Date.now(), payload };
  return res.json(payload);
});

export default router;
