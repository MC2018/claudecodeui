import {
  useUsageLimits,
  usageShortLabel as shortLabel,
  usageFullLabel as fullLabel,
  usageFillClass as fillClass,
  usageResetsInText as resetsInText,
} from '../../../../hooks/useUsageLimits';
import { useUiPreferences } from '../../../../hooks/useUiPreferences';

export default function UsageLimitsSummary() {
  const usage = useUsageLimits();
  const { preferences } = useUiPreferences();

  if (!preferences.showUsageLimits) {
    return null;
  }

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
