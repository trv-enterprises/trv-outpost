// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Button, InlineLoading } from '@carbon/react';
import PropTypes from 'prop-types';
import { useControlCommand } from './useControlCommand';
import { registerControl } from './controlRegistry';
import './controls.scss';

function ControlMqttPublish({ control, readOnly = false, onSuccess, onError }) {
  const uiConfig = control.control_config?.ui_config || {};
  const label = uiConfig.label || 'Publish';
  const kind = uiConfig.kind || 'primary';
  const target = control.control_config?.target || '';

  const { execute, loading } = useControlCommand({
    controlId: control.id,
    label,
    target,
    onSuccess,
    onError
  });

  const handleClick = () => {
    if (readOnly) return;
    execute(null, `Published to ${target}`);
  };

  return (
    <div className="control-button-container">
      <Button
        kind={kind}
        onClick={handleClick}
        disabled={loading || readOnly}
        size="lg"
      >
        {loading ? <InlineLoading description="Publishing..." /> : label}
      </Button>
    </div>
  );
}

ControlMqttPublish.propTypes = {
  control: PropTypes.shape({
    id: PropTypes.string.isRequired,
    connection_id: PropTypes.string,
    control_config: PropTypes.shape({
      target: PropTypes.string,
      ui_config: PropTypes.object
    })
  }).isRequired,
  readOnly: PropTypes.bool,
  onSuccess: PropTypes.func,
  onError: PropTypes.func
};

registerControl('mqtt_publish', ControlMqttPublish);
export default ControlMqttPublish;
