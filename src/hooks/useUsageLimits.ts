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

/** Compact label under a bar; weekly-scoped limits carry the model name. */
export function usageShortLabel(limit: UsageLimit): string {
  if (limit.kind === 'session') return '5h';
  if (limit.kind === 'weekly_all') return 'wk';
  return limit.model ?? 'wk';
}

/** Full label used in tooltips and the settings panel. */
export function usageFullLabel(limit: UsageLimit): string {
  if (limit.kind === 'session') return 'Session (5h)';
  if (limit.kind === 'weekly_all') return 'Weekly';
  return limit.model ? `${limit.model} (weekly)` : 'Weekly (scoped)';
}

/** Bar fill colour by severity; the API reports 'normal' until a limit tightens. */
export function usageFillClass(severity: string): string {
  if (severity === 'critical' || severity === 'high') return 'bg-red-500';
  if (severity === 'warning' || severity === 'medium') return 'bg-amber-500';
  return 'bg-primary';
}

/** Human "resets in" text from an ISO timestamp. */
export function usageResetsInText(resetsAt: string | null): string {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

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
