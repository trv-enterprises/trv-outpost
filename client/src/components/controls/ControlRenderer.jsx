// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import PropTypes from 'prop-types';
import { getControlComponent } from './controlRegistry';
import { CONTROL_TYPE_INFO } from './controlTypes';
import { formatTitle } from './controlUtils';
import './controls.scss';

/**
 * ControlRenderer Component
 *
 * Dispatcher component that renders the appropriate control type
 * based on the control_config.control_type field.
 * Components self-register via controlRegistry — no manual wiring needed.
 *
 * `canControl` gates whether the current user is allowed to fire
 * controls at all (server-side capability `control`). When false,
 * every rendered control is forced read-only regardless of its
 * type's intrinsic canWrite — the user can still SEE the dashboard
 * but can't interact. Defaults true so callers that haven't been
 * upgraded keep working as before.
 */
function ControlRenderer({ control, canControl = true, onSuccess, onError }) {
  const controlType = control.control_config?.control_type;

  if (!controlType) {
    return (
      <div className="control-error">
        Control type not configured
      </div>
    );
  }

  const Component = getControlComponent(controlType);
  if (!Component) {
    return (
      <div className="control-error">
        Unknown control type: {controlType}
      </div>
    );
  }

  // Prefer the user-facing display title; fall back to the internal name
  // if no title was set. The `name` field is the control's unique
  // identifier and tends to be long/contextual ("Home Front Garage Door
  // Sensor - Contact"), whereas `title` is the user-facing display name
  // shown on dashboards and is usually short ("Front Garage"). When a
  // title is provided it wins; when it isn't, the name is still better
  // than showing nothing.
  const title = control.title || control.name;
  const typeInfo = CONTROL_TYPE_INFO[controlType];
  // A control is read-only when EITHER its type doesn't write (e.g.
  // sensor/status displays) OR the current user lacks the `control`
  // capability. Capability gating is the structural gate that lets a
  // kiosk render dashboards safely without exposing the action surface.
  const readOnly = (typeInfo && !typeInfo.canWrite) || !canControl;
  const isTile = controlType.startsWith('tile_');

  return (
    <div className={`control-renderer ${isTile ? 'control-renderer--tile' : ''} ${controlType === 'text_label' ? 'control-renderer--text-label' : ''}`}>
      {title && !isTile && controlType !== 'text_label' && <div className="control-title">{formatTitle(title)}</div>}
      <div className="control-body">
        <Component
          control={control}
          readOnly={readOnly}
          onSuccess={onSuccess}
          onError={onError}
        />
      </div>
    </div>
  );
}

ControlRenderer.propTypes = {
  control: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
    title: PropTypes.string,
    control_config: PropTypes.shape({
      control_type: PropTypes.string,
      ui_config: PropTypes.object
    })
  }).isRequired,
  canControl: PropTypes.bool,
  onSuccess: PropTypes.func,
  onError: PropTypes.func
};

export default ControlRenderer;
