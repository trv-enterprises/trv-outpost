// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { OverflowMenu, OverflowMenuItem } from '@carbon/react';
import { Checkmark, ChevronDown, UserAvatar } from '@carbon/icons-react';
import './DevUserSwitcher.scss';

/**
 * DevUserSwitcher
 *
 * Header pill that lets the developer impersonate any user in the
 * deployment. Production browsers have one identity per session
 * (resolved via the bootstrap chain); this control only renders
 * under `npm run dev` so the same dev box can exercise different
 * roles against a local server.
 *
 * Visually parallels NamespacePicker so the two pills read as
 * matching context controls in the header right rail.
 *
 * Caller MUST gate this on `import.meta.env.DEV` so it never ships
 * in production bundles.
 *
 * Props:
 *   currentUser     — { name, guid, ... } | null
 *   users           — full user list to switch between
 *   onUserChange    — invoked with the selected user object
 */
function DevUserSwitcher({ currentUser, users = [], onUserChange }) {
  const label = currentUser?.name || 'No user';

  return (
    <OverflowMenu
      aria-label="Switch user (dev only)"
      iconDescription="Dev-only: act as a different user"
      className="dev-user-switcher"
      menuOptionsClass="dev-user-switcher-menu"
      flipped
      renderIcon={() => (
        <div className="dev-user-switcher__trigger">
          <span className="dev-user-switcher__chip">
            <UserAvatar size={14} />
            <span className="dev-user-switcher__chip-name">{label}</span>
          </span>
          <ChevronDown size={14} className="dev-user-switcher__caret" />
        </div>
      )}
    >
      {users.map((user) => (
        <OverflowMenuItem
          key={user.guid}
          itemText={
            <span className="dev-user-switcher__item">
              {currentUser?.guid === user.guid ? (
                <Checkmark size={14} />
              ) : (
                <span style={{ width: 14, display: 'inline-block' }} />
              )}
              <span className="dev-user-switcher__item-name">{user.name}</span>
            </span>
          }
          onClick={() => onUserChange(user)}
        />
      ))}
    </OverflowMenu>
  );
}

export default DevUserSwitcher;
