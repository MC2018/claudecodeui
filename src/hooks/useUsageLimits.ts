import { useEffect, useState } from 'react';

import { api } from '../utils/api';

export type UsageLimit = {
  kind: 'session' | 'weekly_all' | 'weekly_scoped' | string;
  group: string | null;
  percent: number | null;
  severity: string;
  resetsAt: string | null;
  model: string | null;
};

export type UsageLimits =
  | { available: true; fetchedAt: string; limits: UsageLimit[] }
  | { available: false; reason?: string };

const POLL_INTERVAL_MS = 90_000;

/**
 * Polls the subscription usage limits (5-hour / weekly / per-model) that the
 * server proxies from the Claude usage endpoint. Refreshes on an interval and
 * on tab focus, and pauses while the tab is hidden so a backgrounded PWA does
 * not keep polling.
 */
export function useUsageLimits(): UsageLimits | null {
  const [data, setData] = useState<UsageLimits | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      try {
        const response = await api.usageLimits();
        if (!response.ok) {
          return;
        }
        const next = (await response.json()) as UsageLimits;
        if (!cancelled) {
          setData(next);
        }
      } catch {
        // Leave the last known value in place on a transient failure.
      }
    };

    void load();
    timer = setInterval(load, POLL_INTERVAL_MS);

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void load();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (timer) {
        clearInterval(timer);
      }
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return data;
}
