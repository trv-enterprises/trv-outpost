// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import {
  Loading,
  DataTable,
  TableContainer,
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
  Button,
  Tag,
  InlineNotification,
  Modal,
  TextInput,
  Select,
  SelectItem
} from '@carbon/react';
import { Edit } from '@carbon/icons-react';
import apiClient from '../api/client';
import LayoutDimensionsEditorModal from '../components/LayoutDimensionsEditorModal';
import DefaultLayoutDimensionEditorModal from '../components/DefaultLayoutDimensionEditorModal';
import TileFontSizeEditorModal from '../components/TileFontSizeEditorModal';
import DefaultDashboardFitModeEditorModal from '../components/DefaultDashboardFitModeEditorModal';
import DashboardConfigRefreshIntervalEditorModal, { DEFAULT_DASHBOARD_CONFIG_REFRESH_INTERVAL } from '../components/DashboardConfigRefreshIntervalEditorModal';
import DefaultBrowserUserEditorModal from '../components/DefaultBrowserUserEditorModal';
import NumericChartNumberSizeEditorModal, { DEFAULT_NUMBER_CHART_SIZE } from '../components/NumericChartNumberSizeEditorModal';
import EnabledTypesEditorModal from '../components/EnabledTypesEditorModal';
import PrimitiveSettingEditorModal from '../components/PrimitiveSettingEditorModal';
import { useEnabledTypes } from '../context/EnabledTypesContext';
import './SettingsPage.scss';

/**
 * SettingsPage Component
 *
 * Displays user-configurable settings in a simple list view.
 * Each setting type has a custom modal editor.
 */
function SettingsPage() {
  const [settings, setSettings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notification, setNotification] = useState(null);

  // Modal states
  const [editingSetting, setEditingSetting] = useState(null);
  const [layoutDimensionsModalOpen, setLayoutDimensionsModalOpen] = useState(false);
  const [defaultLayoutDimensionModalOpen, setDefaultLayoutDimensionModalOpen] = useState(false);
  const [tileFontSizeModalOpen, setTileFontSizeModalOpen] = useState(false);
  const [defaultFitModeModalOpen, setDefaultFitModeModalOpen] = useState(false);
  const [dashboardConfigRefreshModalOpen, setDashboardConfigRefreshModalOpen] = useState(false);
  const [defaultBrowserUserModalOpen, setDefaultBrowserUserModalOpen] = useState(false);
  const [numericChartSizeModalOpen, setNumericChartSizeModalOpen] = useState(false);
  const [dashboardCommandModalOpen, setDashboardCommandModalOpen] = useState(false);
  const [enabledTypesModalOpen, setEnabledTypesModalOpen] = useState(false);
  const [primitiveEditorOpen, setPrimitiveEditorOpen] = useState(false);
  const [mqttConnections, setMqttConnections] = useState([]);
  const { refresh: refreshEnabledTypes } = useEnabledTypes();

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      setLoading(true);
      const data = await apiClient.getSettings();
      // API returns {settings: [...]}
      setSettings(data.settings || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (setting) => {
    setEditingSetting(setting);

    // Open the appropriate modal based on setting key
    switch (setting.key) {
      case 'layout_dimensions':
        setLayoutDimensionsModalOpen(true);
        break;
      case 'default_layout_dimension':
        setDefaultLayoutDimensionModalOpen(true);
        break;
      case 'tile_font_size':
        setTileFontSizeModalOpen(true);
        break;
      case 'default_dashboard_fit_mode':
        setDefaultFitModeModalOpen(true);
        break;
      case 'dashboard_config_refresh_interval':
        setDashboardConfigRefreshModalOpen(true);
        break;
      case 'default_browser_user_guid':
        setDefaultBrowserUserModalOpen(true);
        break;
      case 'default_numeric_chart_number_size':
        setNumericChartSizeModalOpen(true);
        break;
      case 'dashboard_command_topic':
      case 'dashboard_command_connection':
        // Fetch MQTT connections for the dropdown
        apiClient.getConnections().then(data => {
          const conns = (data.connections || []).filter(c => c.type === 'mqtt');
          setMqttConnections(conns);
        }).catch(() => {});
        setDashboardCommandModalOpen(true);
        break;
      case 'enabled_types':
        setEnabledTypesModalOpen(true);
        break;
      default:
        // No bespoke editor — fall back to the generic primitive
        // editor (Toggle / NumberInput / TextInput chosen by the
        // value's runtime type). Settings that need richer UX
        // should still ship their own modal.
        setPrimitiveEditorOpen(true);
    }
  };

  const handleSave = async (key, value) => {
    try {
      await apiClient.updateSetting(key, value);
      setNotification({ kind: 'success', title: 'Setting updated successfully' });
      fetchSettings();
    } catch (err) {
      setNotification({ kind: 'error', title: 'Failed to update setting', subtitle: err.message });
    }
  };

  const handleLayoutDimensionsClose = () => {
    setLayoutDimensionsModalOpen(false);
    setEditingSetting(null);
  };

  const handleDefaultLayoutDimensionClose = () => {
    setDefaultLayoutDimensionModalOpen(false);
    setEditingSetting(null);
  };

  const handleTileFontSizeClose = () => {
    setTileFontSizeModalOpen(false);
    setEditingSetting(null);
  };

  const handleDefaultFitModeClose = () => {
    setDefaultFitModeModalOpen(false);
    setEditingSetting(null);
  };

  const handleDashboardConfigRefreshClose = () => {
    setDashboardConfigRefreshModalOpen(false);
    setEditingSetting(null);
  };

  const handleDefaultBrowserUserClose = () => {
    setDefaultBrowserUserModalOpen(false);
    setEditingSetting(null);
  };

  const handleDashboardCommandClose = () => {
    setDashboardCommandModalOpen(false);
    setEditingSetting(null);
  };

  // Format value for display in table
  const formatValueForDisplay = (value) => {
    if (Array.isArray(value)) {
      return `Array (${value.length} items)`;
    }
    if (typeof value === 'object' && value !== null) {
      return 'Object';
    }
    return String(value);
  };

  // Get available layout dimensions for the default selector
  const getLayoutDimensions = () => {
    const layoutDimensionsSetting = settings.find(s => s.key === 'layout_dimensions');
    if (!layoutDimensionsSetting || !Array.isArray(layoutDimensionsSetting.value)) {
      return [];
    }
    // Transform the Viper format [{Key: 'name', Value: '...'}, ...] to {name: '...', ...}
    return layoutDimensionsSetting.value.map(item => {
      if (Array.isArray(item)) {
        const obj = {};
        item.forEach(kv => {
          if (kv.Key && kv.Value !== undefined) {
            obj[kv.Key] = kv.Value;
          }
        });
        return obj;
      }
      return item;
    });
  };

  // Table headers
  const headers = [
    { key: 'key', header: 'Key' },
    { key: 'category', header: 'Category' },
    { key: 'description', header: 'Description' },
    { key: 'value', header: 'Value' },
    { key: 'actions', header: '' }
  ];

  // Hide system-managed settings (known_types is the upgrade ledger and
  // shouldn't appear in the admin settings list — it's maintained by the
  // server's seed-on-first-sight routine).
  const visibleSettings = settings.filter((s) => s.key !== 'known_types');

  // Transform settings to table rows
  const rows = visibleSettings.map((setting) => ({
    id: setting.key,
    key: setting.key,
    category: setting.category || '-',
    description: setting.description || '-',
    value: formatValueForDisplay(setting.value),
    _original: setting
  }));

  if (loading) {
    return (
      <div className="settings-page">
        <Loading description="Loading settings..." withOverlay={false} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="settings-page">
        <div className="error-message">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="settings-page">
      {/* Page Header */}
      <div className="page-header">
        <h1>Settings</h1>
        <p className="page-description">
          Manage user-configurable system settings.
          These settings are persisted in the database and can be modified by administrators.
        </p>
      </div>

      {notification && (
        <InlineNotification
          kind={notification.kind}
          title={notification.title}
          subtitle={notification.subtitle}
          onCloseButtonClick={() => setNotification(null)}
          lowContrast
        />
      )}

      <DataTable rows={rows} headers={headers}>
        {({ rows, headers, getTableProps, getHeaderProps, getRowProps }) => (
          <TableContainer>
            <Table {...getTableProps()}>
              <TableHead>
                <TableRow>
                  {headers.map((header) => (
                    <TableHeader key={header.key} {...getHeaderProps({ header })}>
                      {header.header}
                    </TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => {
                  const originalSetting = visibleSettings.find(s => s.key === row.id);
                  return (
                    <TableRow key={row.id} {...getRowProps({ row })}>
                      {row.cells.map((cell) => {
                        if (cell.info.header === 'key') {
                          return (
                            <TableCell key={cell.id}>
                              <code className="setting-key">{cell.value}</code>
                            </TableCell>
                          );
                        }
                        if (cell.info.header === 'category') {
                          return (
                            <TableCell key={cell.id}>
                              {cell.value !== '-' ? (
                                <Tag type="outline" size="sm">{cell.value}</Tag>
                              ) : '-'}
                            </TableCell>
                          );
                        }
                        if (cell.info.header === 'actions') {
                          return (
                            <TableCell key={cell.id}>
                              <Button
                                kind="ghost"
                                size="sm"
                                renderIcon={Edit}
                                iconDescription="Edit"
                                hasIconOnly
                                onClick={() => handleEdit(originalSetting)}
                              />
                            </TableCell>
                          );
                        }
                        return <TableCell key={cell.id}>{cell.value}</TableCell>;
                      })}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DataTable>

      {/* Layout Dimensions Editor Modal */}
      <LayoutDimensionsEditorModal
        open={layoutDimensionsModalOpen}
        onClose={handleLayoutDimensionsClose}
        dimensions={editingSetting?.key === 'layout_dimensions' ? getLayoutDimensions() : []}
        onSave={(dimensions) => {
          handleSave('layout_dimensions', dimensions);
          handleLayoutDimensionsClose();
        }}
      />

      {/* Default Layout Dimension Editor Modal */}
      <DefaultLayoutDimensionEditorModal
        open={defaultLayoutDimensionModalOpen}
        onClose={handleDefaultLayoutDimensionClose}
        currentValue={editingSetting?.key === 'default_layout_dimension' ? editingSetting.value : ''}
        availableDimensions={getLayoutDimensions()}
        onSave={(value) => {
          handleSave('default_layout_dimension', value);
          handleDefaultLayoutDimensionClose();
        }}
      />
      {/* Tile Font Size Editor Modal */}
      <TileFontSizeEditorModal
        open={tileFontSizeModalOpen}
        onClose={handleTileFontSizeClose}
        currentValue={editingSetting?.key === 'tile_font_size' ? editingSetting.value : 'sm'}
        onSave={(value) => {
          handleSave('tile_font_size', value);
          handleTileFontSizeClose();
        }}
      />

      {/* Default Dashboard Fit Mode Editor Modal */}
      <DefaultDashboardFitModeEditorModal
        open={defaultFitModeModalOpen}
        onClose={handleDefaultFitModeClose}
        currentValue={editingSetting?.key === 'default_dashboard_fit_mode' ? editingSetting.value : 'stretch'}
        onSave={(value) => {
          handleSave('default_dashboard_fit_mode', value);
          handleDefaultFitModeClose();
        }}
      />

      {/* Dashboard Config Refresh Interval Editor Modal */}
      <DashboardConfigRefreshIntervalEditorModal
        open={dashboardConfigRefreshModalOpen}
        onClose={handleDashboardConfigRefreshClose}
        currentValue={editingSetting?.key === 'dashboard_config_refresh_interval' ? editingSetting.value : DEFAULT_DASHBOARD_CONFIG_REFRESH_INTERVAL}
        onSave={(value) => {
          handleSave('dashboard_config_refresh_interval', value);
          handleDashboardConfigRefreshClose();
        }}
      />

      {/* Default Browser User Editor Modal */}
      <DefaultBrowserUserEditorModal
        open={defaultBrowserUserModalOpen}
        onClose={handleDefaultBrowserUserClose}
        currentValue={editingSetting?.key === 'default_browser_user_guid' ? editingSetting.value : ''}
        onSave={(value) => {
          handleSave('default_browser_user_guid', value);
          handleDefaultBrowserUserClose();
        }}
      />

      {/* Default Number Chart Value Size Editor Modal */}
      <NumericChartNumberSizeEditorModal
        open={numericChartSizeModalOpen}
        onClose={() => { setNumericChartSizeModalOpen(false); setEditingSetting(null); }}
        currentValue={editingSetting?.key === 'default_numeric_chart_number_size' ? editingSetting.value : DEFAULT_NUMBER_CHART_SIZE}
        onSave={(value) => {
          handleSave('default_numeric_chart_number_size', value);
          setNumericChartSizeModalOpen(false);
          setEditingSetting(null);
        }}
      />

      {/* Type Availability Editor Modal */}
      <EnabledTypesEditorModal
        open={enabledTypesModalOpen}
        onClose={() => {
          setEnabledTypesModalOpen(false);
          setEditingSetting(null);
        }}
        onSaved={() => {
          // Refresh the picker context so changes take effect immediately
          // across the app, then refetch settings to update the table.
          refreshEnabledTypes();
          setNotification({ kind: 'success', title: 'Type availability updated' });
          fetchSettings();
        }}
      />

      {/* Dashboard Command Settings Modal */}
      <Modal
        open={dashboardCommandModalOpen}
        onRequestClose={handleDashboardCommandClose}
        modalHeading={editingSetting?.key === 'dashboard_command_topic' ? 'Dashboard Command Topic' : 'Dashboard Command Connection'}
        primaryButtonText="Save"
        secondaryButtonText="Cancel"
        onSecondarySubmit={handleDashboardCommandClose}
        onRequestSubmit={() => {
          const input = document.getElementById('dashboard-cmd-input');
          if (input) {
            handleSave(editingSetting.key, input.value);
          }
          handleDashboardCommandClose();
        }}
        size="sm"
      >
        {editingSetting?.key === 'dashboard_command_topic' ? (
          <TextInput
            id="dashboard-cmd-input"
            labelText="Command Topic"
            defaultValue={editingSetting?.value || 'dashboard/cmd'}
            helperText="MQTT topic the dashboard subscribes to for voice/kiosk commands. Commands are JSON: {target, action, ...}"
          />
        ) : (
          <Select
            id="dashboard-cmd-input"
            labelText="MQTT Connection"
            defaultValue={editingSetting?.value || ''}
            helperText="Select the MQTT broker connection used for dashboard commands"
          >
            <SelectItem value="" text="None (disabled)" />
            {mqttConnections.map(c => (
              <SelectItem key={c.id} value={c.id} text={`${c.name} (${c.type})`} />
            ))}
          </Select>
        )}
      </Modal>

      {/* Generic primitive editor — fallback for settings without a
          bespoke modal. Lets newly-added boolean/number/string keys
          in user-configurable.yaml be editable in the UI without a
          follow-up JSX change. */}
      <PrimitiveSettingEditorModal
        open={primitiveEditorOpen}
        onClose={() => setPrimitiveEditorOpen(false)}
        setting={editingSetting}
        onSave={(value) => {
          handleSave(editingSetting.key, value);
          setPrimitiveEditorOpen(false);
        }}
      />
    </div>
  );
}

export default SettingsPage;
