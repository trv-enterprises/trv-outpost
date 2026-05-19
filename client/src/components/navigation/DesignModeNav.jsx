// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { SideNavItems, SideNavLink } from '@carbon/react';
import {
  Edit,
  DataBase,
  ChartLineSmooth,
  Dashboard,
  Apps
} from '@carbon/icons-react';
import useExtensions from '../../hooks/useExtensions';
import './DesignModeNav.scss';

/**
 * DesignModeNav Component
 *
 * Navigation for Design Mode with two sections:
 * - Resources: Connections, Components, Dashboards
 * - Extensions: optional add-on features. Section hides entirely
 *   when no extension is enabled (admin toggles in Manage → Settings).
 */
function DesignModeNav({ location, navigate }) {
  const { enabled: enabledExtensions } = useExtensions();

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

  const renderLink = (item) => {
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
  };

  return (
    <SideNavItems>
      <div className="design-mode-nav">
        <div className="nav-header">
          <Edit size={16} />
          <span>Resources</span>
        </div>

        <div className="nav-links">
          {designNavItems.map(renderLink)}
        </div>

        {enabledExtensions.length > 0 && (
          <>
            <div className="nav-header nav-header--subsection">
              <Apps size={16} />
              <span>Extensions</span>
            </div>

            <div className="nav-links">
              {enabledExtensions.map(renderLink)}
            </div>
          </>
        )}
      </div>
    </SideNavItems>
  );
}

export default DesignModeNav;
