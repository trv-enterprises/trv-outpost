// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { SideNavItems, SideNavLink } from '@carbon/react';
import {
  Edit,
  DataBase,
  ChartLineSmooth,
  Dashboard
} from '@carbon/icons-react';
import './DesignModeNav.scss';

/**
 * DesignModeNav Component
 *
 * Navigation for Design Mode with 3 sections:
 * - Connections: Configure data connections
 * - Components: Create and edit displays and controls
 * - Dashboards: Combine components with layouts
 */
function DesignModeNav({ location, navigate }) {
  const designNavItems = [
    {
      path: '/design/connections',
      icon: DataBase,
      label: 'Connections',
      description: 'Configure data connections'
    },
    {
      path: '/design/components',
      icon: ChartLineSmooth,
      label: 'Components',
      description: 'Create and edit displays and controls'
    },
    {
      path: '/design/dashboards',
      icon: Dashboard,
      label: 'Dashboards',
      description: 'Combine components with layouts'
    }
  ];

  return (
    <SideNavItems>
      <div className="design-mode-nav">
        <div className="nav-header">
          <Edit size={16} />
          <span>Resources</span>
        </div>

        <div className="nav-links">
          {designNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <SideNavLink
                key={item.path}
                renderIcon={Icon}
                href={item.path}
                isActive={location.pathname.startsWith(item.path)}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(item.path);
                }}
              >
                {item.label}
              </SideNavLink>
            );
          })}
        </div>
      </div>
    </SideNavItems>
  );
}

export default DesignModeNav;
