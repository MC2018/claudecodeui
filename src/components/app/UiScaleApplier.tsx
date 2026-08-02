import { useEffect } from 'react';

import { useUiPreferences } from '../../hooks/useUiPreferences';

/**
 * Applies the global UI scale preference by scaling the root font size.
 *
 * Deliberately NOT `zoom`: with CSS zoom the browser stops keeping pointer
 * coordinates in step with the rendered layout, so anything that reads
 * `event.clientX` against a `getBoundingClientRect()` drifts by roughly the
 * zoom factor. That broke drag-to-resize (the handle jumped ~50-100px away
 * from the cursor at 90%), and would equally affect any other pointer-driven
 * geometry. Native browser zoom does not have this problem, which is the tell.
 *
 * Scaling the root font size keeps everything in ordinary CSS pixels, so
 * pointer maths stays correct. Tailwind's spacing, sizing and text scales are
 * rem-based, so this still scales the interface as a whole rather than only
 * the text. A percentage (not a px value) is used so the scale multiplies the
 * user's own browser font-size preference instead of overriding it.
 *
 * Renders nothing; mounted once near the app root so a change in Settings
 * takes effect live everywhere.
 */
export default function UiScaleApplier() {
  const { preferences } = useUiPreferences();
  const scale = preferences.uiScale;

  useEffect(() => {
    const root = document.documentElement;
    // Clear the old `zoom` value too: installs that ran the previous
    // implementation can still have it set inline on the root element.
    root.style.removeProperty('zoom');

    if (scale === 1) {
      root.style.removeProperty('font-size');
    } else {
      root.style.fontSize = `${scale * 100}%`;
    }

    return () => {
      root.style.removeProperty('font-size');
    };
  }, [scale]);

  return null;
}
