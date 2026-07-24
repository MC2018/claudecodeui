import { useTranslation } from 'react-i18next';

import {
  useUsageLimits,
  usageFullLabel,
  usageFillClass,
  usageResetsInText,
} from '../../../../../../../hooks/useUsageLimits';
import { useUiPreferences } from '../../../../../../../hooks/useUiPreferences';
import SettingsToggle from '../../../../SettingsToggle';

/**
 * Claude subscription usage limits shown in the account area. The numbers are
 * always displayed here (regardless of the composer toggle); the toggle only
 * controls whether the compact widget also appears next to the message box.
 */
export default function ClaudeUsagePanel() {
  const { t } = useTranslation('settings');
  const usage = useUsageLimits();
  const { preferences, setPreference } = useUiPreferences();

  const hasData = Boolean(usage && usage.available && usage.limits.length > 0);

  return (
    <div className="rounded-lg border border-border/60 bg-card/50 p-4">
      <div className="mb-3 font-medium text-foreground">
        {t('agents.usage.title', { defaultValue: 'Usage limits' })}
      </div>

      {hasData && usage && usage.available ? (
        <div className="space-y-3">
          {usage.limits.map((limit) => {
            const pct = Math.max(0, Math.min(100, limit.percent ?? 0));
            const resets = usageResetsInText(limit.resetsAt);
            return (
              <div key={`${limit.kind}:${limit.model ?? ''}`}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="text-foreground">{usageFullLabel(limit)}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {limit.percent == null ? '—' : `${Math.round(limit.percent)}%`}
                    {resets ? ` · ${t('agents.usage.resetsIn', { defaultValue: 'resets in' })} ${resets}` : ''}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${usageFillClass(limit.severity)}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('agents.usage.unavailable', {
            defaultValue: 'Usage data is unavailable right now.',
          })}
        </p>
      )}

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-border/50 pt-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">
            {t('agents.usage.showInChat', { defaultValue: 'Show usage in chat' })}
          </div>
          <div className="text-xs text-muted-foreground">
            {t('agents.usage.showInChatDescription', {
              defaultValue: 'Display these limits next to the message box.',
            })}
          </div>
        </div>
        <SettingsToggle
          checked={preferences.showUsageLimits}
          onChange={(value) => setPreference('showUsageLimits', value)}
          ariaLabel={t('agents.usage.showInChat', { defaultValue: 'Show usage in chat' })}
        />
      </div>
    </div>
  );
}
