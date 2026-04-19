// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { SideNavItems, SideNavLink } from '@carbon/react';
import { Settings, SettingsAdjust, UserMultiple, IotPlatform, Tag } from '@carbon/icons-react';
import './ManageModeNav.scss';

/**
 * ManageModeNav Component
 *
 * Navigation for Manage Mode - system administration and monitoring.
 */
function ManageModeNav({ location, navigate }) {
  const manageNavItems = [
    {
      path: '/manage/users',
      icon: UserMultiple,
      label: 'Users',
      description: 'User management'
    },
    {
      path: '/manage/devices',
      icon: IotPlatform,
      label: 'Device Types',
      description: 'Device type management'
    },
    {
      path: '/manage/namespaces',
      icon: Tag,
      label: 'Namespaces',
      description: 'Namespace management'
    },
    {
      path: '/manage/settings',
      icon: SettingsAdjust,
      label: 'Settings',
      description: 'System administration'
    }
  ];

  return (
    <SideNavItems>
      <div className="manage-mode-nav">
        <div className="nav-header">
          <Settings size={16} />
          <span>Configuration</span>
        </div>

        <div className="nav-links">
          {manageNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <SideNavLink
                key={item.path}
                renderIcon={Icon}
                href={item.path}
                isActive={location.pathname === item.path}
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

export default ManageModeNav;
