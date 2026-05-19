// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { SideNavItems } from '@carbon/react';
import DashboardTilesPicker from '../DashboardTilesPicker';
import './ViewModeNav.scss';

/**
 * View Mode sidebar — thin wrapper around DashboardTilesPicker.
 * Picker is reused by the ts-store alerts rule wizard ("target
 * dashboard" field) and the status-only dashboard component; keep
 * any tile/list behaviour changes there, not here.
 */
function ViewModeNav({ location, navigate }) {
  const currentDashboardId = location.pathname.startsWith('/view/dashboards/')
    ? location.pathname.replace('/view/dashboards/', '')
    : null;

  return (
    <SideNavItems>
      <div className="view-mode-nav">
        <DashboardTilesPicker
          selectedId={currentDashboardId}
          onSelect={(dashboard) => navigate(`/view/dashboards/${dashboard.id}`)}
          showHeader
        />
      </div>
    </SideNavItems>
  );
}

export default ViewModeNav;
