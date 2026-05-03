// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Modal, Tag } from '@carbon/react';
import { Time } from '@carbon/icons-react';
import { createPortal } from 'react-dom';
import ComponentPanelWithActions from './ComponentPanelWithActions';
import WeatherDisplay from './weather/WeatherDisplay';
import FrigateCameraViewer from './frigate/FrigateCameraViewer';
import './ComponentExpandModal.scss';

/**
 * ComponentExpandModal
 *
 * Large modal showing a single dashboard component live. Opened by
 * double-clicking a chart, weather display, or frigate camera in view mode.
 * The modal renders a fresh instance of the component with the same
 * connection / data-mapping / refresh-interval props the panel uses, so a
 * streaming component keeps streaming and a polling component keeps polling
 * on its own cadence — independent of the underlying panel.
 *
 * Portaled to document.body to escape the dashboard grid's CSS transform
 * (fit-to-screen `scale(...)` would otherwise scale the modal too).
 */
export default function ComponentExpandModal({
  open,
  onClose,
  chart,
  dashboardSettings,
  lastRefresh,
  formatTime,
  dashboardCommand,
}) {
  if (!chart) return null;

  const heading = chart.title || chart.name || 'Component';
  const isPolling = (dashboardSettings?.refresh_interval || 0) > 0;
  const refreshInterval = isPolling ? dashboardSettings.refresh_interval : null;
  // Treat any non-control, non-display component with custom code as a chart
  // so legacy records with `component_type=""` render correctly.
  const isDisplay = chart.component_type === 'display';
  const isControl = chart.component_type === 'control';
  const isChart = chart.component_type === 'chart' || (!isDisplay && !isControl && !!chart.component_code);
  const displayType = chart.display_config?.display_type;

  return createPortal(
    <Modal
      open={open}
      onRequestClose={onClose}
      modalHeading={heading}
      passiveModal
      size="lg"
      className="component-expand-modal"
    >
      {isPolling && (
        <div className="component-expand-meta">
          <Tag type="green" size="sm">
            <Time size={12} />
            Data refresh: {refreshInterval}s
          </Tag>
          {lastRefresh && (
            <span className="last-refresh">
              Last refresh: {formatTime ? formatTime(lastRefresh) : ''}
            </span>
          )}
        </div>
      )}
      <div className="component-expand-body">
        {isChart && (
          <ComponentPanelWithActions
            chart={chart}
            loaderProps={{
              code: chart.component_code,
              props: {},
              componentMeta: chart,
              dataMapping: chart.data_mapping,
              connectionId: chart.connection_id,
              queryConfig: chart.query_config,
              dataRefreshInterval: refreshInterval ? refreshInterval * 1000 : null,
            }}
          />
        )}
        {isDisplay && displayType === 'weather' && (
          <WeatherDisplay config={chart.display_config} />
        )}
        {isDisplay && displayType === 'frigate_camera' && (
          <FrigateCameraViewer
            config={chart.display_config}
            dashboardCommand={dashboardCommand}
          />
        )}
      </div>
    </Modal>,
    document.body
  );
}
