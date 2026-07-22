import { useEffect } from 'react';

import { useUiPreferences } from '../../hooks/useUiPreferences';

/**
 * Applies the global UI scale preference by zooming the document root.
 *
 * `zoom` (not `transform: scale`) is used so the layout reflows at the new
 * size — the viewport simply shows more or less content — and so it scales
 * everything uniformly, including portalled modals and the few elements with
 * `!important` pixel font sizes. Renders nothing; mounted once near the app root
 * so a change from Settings takes effect live everywhere.
 */
export default function UiScaleApplier() {
  const { preferences } = useUiPreferences();
  const scale = preferences.uiScale;

  useEffect(() => {
    const root = document.documentElement;
    if (scale === 1) {
      root.style.removeProperty('zoom');
    } else {
      root.style.zoom = String(scale);
    }
    return () => {
      root.style.removeProperty('zoom');
    };
  }, [scale]);

  return null;
}
