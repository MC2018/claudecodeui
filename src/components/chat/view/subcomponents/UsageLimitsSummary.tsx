import { useUsageLimits, type UsageLimit } from '../../../../hooks/useUsageLimits';

// Short label shown under each bar. Weekly-scoped limits carry the model name.
function shortLabel(limit: UsageLimit): string {
  if (limit.kind === 'session') return '5h';
  if (limit.kind === 'weekly_all') return 'wk';
  return limit.model ?? 'wk';
}

function fullLabel(limit: UsageLimit): string {
  if (limit.kind === 'session') return 'Session (5h)';
  if (limit.kind === 'weekly_all') return 'Weekly';
  return limit.model ? `${limit.model} (weekly)` : 'Weekly (scoped)';
}

// Fill colour by severity; the API reports 'normal' until a limit gets tight.
function fillClass(severity: string): string {
  if (severity === 'critical' || severity === 'high') return 'bg-red-500';
  if (severity === 'warning' || severity === 'medium') return 'bg-amber-500';
  return 'bg-primary';
}

function resetsInText(resetsAt: string | null): string {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export default function UsageLimitsSummary() {
  const usage = useUsageLimits();

  if (!usage || !usage.available || usage.limits.length === 0) {
    return null;
  }

  const title = usage.limits
    .map((limit) => {
      const pct = limit.percent == null ? '—' : `${Math.round(limit.percent)}%`;
      const resets = resetsInText(limit.resetsAt);
      return `${fullLabel(limit)}: ${pct}${resets ? ` · resets in ${resets}` : ''}`;
    })
    .join('\n');

  return (
    <div
      title={title}
      aria-label="Subscription usage limits"
      className="inline-flex h-8 items-center gap-2 rounded-lg border border-border/70 bg-background/70 px-2 shadow-sm"
    >
      {usage.limits.map((limit) => {
        const pct = Math.max(0, Math.min(100, limit.percent ?? 0));
        return (
          <div key={`${limit.kind}:${limit.model ?? ''}`} className="flex w-8 flex-col items-center gap-0.5">
            <span className="max-w-full truncate text-[9px] font-medium leading-none text-muted-foreground">
              {shortLabel(limit)}
            </span>
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
              <div className={`h-full rounded-full ${fillClass(limit.severity)}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[9px] tabular-nums leading-none text-muted-foreground/80">
              {limit.percent == null ? '—' : `${Math.round(limit.percent)}%`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
