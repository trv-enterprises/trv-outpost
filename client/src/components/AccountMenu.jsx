// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useNavigate } from 'react-router-dom';
import {
  OverflowMenu,
  OverflowMenuItem,
} from '@carbon/react';
import { Logout, Password, UserAvatar } from '@carbon/icons-react';
import './AccountMenu.scss';

/**
 * AccountMenu
 *
 * The avatar dropdown on the right edge of the header. Shows the
 * signed-in user's name + email at the top (read-only), then
 * personal-account actions: API keys today; sign-out, MFA, etc.
 * once Clerk lands in v0.10.0.
 *
 * This menu is intentionally NOT a user switcher — production users
 * have one identity per browser. Dev-mode user switching lives in a
 * separate component (DevUserSwitcher) so the prod menu stays
 * focused on account actions.
 *
 * Props:
 *   currentUser     — { name, email, guid } | null
 *   electronMode    — boolean; when true, adds a "Disconnect" item
 *   onDisconnect    — handler invoked from the Disconnect item
 */
function AccountMenu({ currentUser, electronMode = false, onDisconnect }) {
  const navigate = useNavigate();

  const displayName = currentUser?.name || (electronMode ? 'Connected' : 'No user');
  const email = currentUser?.email || '';

  return (
    <OverflowMenu
      aria-label="Account"
      renderIcon={() => <UserAvatar size={20} />}
      flipped
      menuOptionsClass="account-menu-options"
    >
      {/* Identity header — disabled, just contextual */}
      <OverflowMenuItem
        className="account-menu-identity"
        itemText={
          <span className="account-menu-identity__inner">
            <UserAvatar size={20} />
            <span className="account-menu-identity__text">
              <span className="account-menu-identity__name">{displayName}</span>
              {email && (
                <span className="account-menu-identity__email">{email}</span>
              )}
            </span>
          </span>
        }
        disabled
      />

      <OverflowMenuItem
        itemText={
          <span className="account-menu-action">
            <Password size={16} />
            <span>API Keys</span>
          </span>
        }
        onClick={() => navigate('/account/api-keys')}
        hasDivider
      />

      {electronMode && (
        <OverflowMenuItem
          itemText={
            <span className="account-menu-action">
              <Logout size={16} />
              <span>Disconnect</span>
            </span>
          }
          onClick={onDisconnect}
          hasDivider
        />
      )}
    </OverflowMenu>
  );
}

export default AccountMenu;
