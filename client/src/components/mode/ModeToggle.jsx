// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Dashboard, Edit, Settings } from '@carbon/icons-react';
import { Button } from '@carbon/react';
import { MODES } from '../../config/layoutConfig';
import './ModeToggle.scss';

/**
 * ModeToggle Component
 *
 * Horizontal icon-based tab system for switching between modes.
 * Uses Carbon Button components with icon-only style for integrated header appearance.
 *
 * @param {string} currentMode - Currently active mode
 * @param {function} onModeChange - Callback when mode changes
 * @param {object} capabilities - User capabilities { can_view, can_design, can_manage }
 */
function ModeToggle({ currentMode, onModeChange, capabilities = {} }) {
  const allModes = [
    {
      id: MODES.VIEW,
      icon: Dashboard,
      label: 'View',
      description: 'View dashboards',
      requiresCapability: 'can_view'
    },
    {
      id: MODES.DESIGN,
      icon: Edit,
      label: 'Design',
      description: 'Design mode',
      requiresCapability: 'can_design'
    },
    {
      id: MODES.MANAGE,
      icon: Settings,
      label: 'Manage',
      description: 'Manage settings',
      requiresCapability: 'can_manage'
    }
  ];

  // Show only modes the user can actually enter. Previously the
  // View button was hidden for view-only users (since they
  // couldn't switch anywhere else anyway). After v0.17.0 some
  // principals lack view entirely (webhook-only system users),
  // so we now gate View the same way Design and Manage are gated:
  // show iff the matching capability is present.
  //
  // If a user has more than one mode available, show all of them
  // — switching between View and Design or View and Manage is the
  // common case for power users.
  const modes = allModes.filter(mode => capabilities[mode.requiresCapability] === true);

  // No modes to show → no toggle. The route tree will surface a
  // "no UI access" stub for this case.
  if (modes.length === 0) return null;

  return (
    <div className="mode-selector">
      {modes.map((mode) => {
        const isActive = currentMode === mode.id;
        const Icon = mode.icon;

        return (
          <Button
            key={mode.id}
            kind={isActive ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => onModeChange(mode.id)}
          >
            <Icon size={16} />
            <span>{mode.label}</span>
          </Button>
        );
      })}
    </div>
  );
}

export default ModeToggle;
