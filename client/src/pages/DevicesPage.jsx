// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useCallback } from 'react';
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
  TableToolbar,
  TableToolbarContent,
  Button,
  Tag,
  InlineNotification,
  Modal,
  Link
} from '@carbon/react';
import { Add, TrashCan, Edit, View } from '@carbon/icons-react';
import apiClient from '../api/client';
import DeviceTypeEditor from '../components/DeviceTypeEditor';
import './DevicesPage.scss';

function DevicesPage() {
  // Device types state
  const [deviceTypes, setDeviceTypes] = useState([]);
  const [loading, setLoading] = useState(true);

  // UI state
  const [error, setError] = useState(null);
  const [notification, setNotification] = useState(null);

  // Modal states
  const [typeEditorOpen, setTypeEditorOpen] = useState(false);
  const [editingType, setEditingType] = useState(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const fetchDeviceTypes = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiClient.getDeviceTypes({ page_size: 100 });
      setDeviceTypes(data.device_types || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDeviceTypes();
  }, [fetchDeviceTypes]);

  // Delete handler
  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    try {
      await apiClient.deleteDeviceType(deleteTarget.id);
      setNotification({ kind: 'success', title: 'Device type deleted' });
      fetchDeviceTypes();
    } catch (err) {
      setNotification({ kind: 'error', title: 'Delete failed', subtitle: err.message });
    } finally {
      setDeleteModalOpen(false);
      setDeleteTarget(null);
    }
  };

  // Device type save handler
  const handleTypeSaved = () => {
    setTypeEditorOpen(false);
    setEditingType(null);
    fetchDeviceTypes();
    setNotification({ kind: 'success', title: 'Device type saved' });
  };

  // Device type table
  const typeHeaders = [
    { key: 'name', header: 'Name' },
    { key: 'category', header: 'Category' },
    { key: 'subtype', header: 'Subtype' },
    { key: 'protocol', header: 'Protocol' },
    { key: 'capabilities', header: 'Capabilities' },
    { key: 'supported_types', header: 'Control Types' },
    { key: 'built_in', header: 'Type' },
    { key: 'actions', header: '' }
  ];

  const typeRows = deviceTypes.map(dt => ({
    id: dt.id,
    name: dt.name,
    category: dt.category,
    subtype: dt.subtype || '-',
    protocol: dt.protocol,
    capabilities: String(dt.capabilities?.length || 0),
    supported_types: (dt.supported_types || []).join(', ') || '-',
    built_in: dt.is_built_in ? 'built-in' : 'custom',
    actions: dt.id
  }));

  const renderCellContent = (cell) => {
    if (cell.info.header === 'built_in') {
      return cell.value === 'built-in'
        ? <Tag type="blue" size="sm">Built-in</Tag>
        : <Tag type="gray" size="sm">Custom</Tag>;
    }
    if (cell.info.header === 'category') {
      return <Tag type="purple" size="sm">{cell.value}</Tag>;
    }
    if (cell.info.header === 'protocol') {
      return <Tag type="teal" size="sm">{cell.value}</Tag>;
    }
    return cell.value;
  };

  if (loading) {
    return (
      <div className="devices-page">
        <Loading description="Loading device types..." withOverlay={false} />
      </div>
    );
  }

  return (
    <div className="devices-page">
      <div className="devices-page-header">
        <h2>Device Types</h2>
        <p className="page-description">
          Define reusable device types with command schemas that control components send to connected devices.
          {' '}<Link href="/docs/device-types" target="_blank" rel="noopener noreferrer">Learn more</Link>.
        </p>
      </div>

      {notification && (
        <InlineNotification
          kind={notification.kind}
          title={notification.title}
          subtitle={notification.subtitle}
          onClose={() => setNotification(null)}
          style={{ marginBottom: '1rem' }}
        />
      )}

      {error && (
        <InlineNotification
          kind="error"
          title="Error"
          subtitle={error}
          onClose={() => setError(null)}
          style={{ marginBottom: '1rem' }}
        />
      )}

      <DataTable rows={typeRows} headers={typeHeaders} isSortable>
        {({ rows, headers, getHeaderProps, getRowProps, getTableProps }) => (
          <TableContainer>
            <TableToolbar>
              <TableToolbarContent>
                <Button
                  kind="primary"
                  size="sm"
                  renderIcon={Add}
                  onClick={() => {
                    setEditingType(null);
                    setTypeEditorOpen(true);
                  }}
                >
                  Add Device Type
                </Button>
              </TableToolbarContent>
            </TableToolbar>
            <Table {...getTableProps()}>
              <TableHead>
                <TableRow>
                  {headers.map(header => (
                    <TableHeader {...getHeaderProps({ header })} key={header.key}>
                      {header.header}
                    </TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map(row => (
                  <TableRow {...getRowProps({ row })} key={row.id}>
                    {row.cells.map(cell => (
                      <TableCell key={cell.id}>
                        {cell.info.header === 'actions' ? (
                          <div className="row-actions">
                            {deviceTypes.find(dt => dt.id === row.id)?.is_built_in ? (
                              <Button
                                kind="ghost"
                                size="sm"
                                hasIconOnly
                                renderIcon={View}
                                iconDescription="View"
                                onClick={() => {
                                  const dt = deviceTypes.find(t => t.id === row.id);
                                  setEditingType(dt);
                                  setTypeEditorOpen(true);
                                }}
                              />
                            ) : (
                              <>
                                <Button
                                  kind="ghost"
                                  size="sm"
                                  hasIconOnly
                                  renderIcon={Edit}
                                  iconDescription="Edit"
                                  onClick={() => {
                                    const dt = deviceTypes.find(t => t.id === row.id);
                                    setEditingType(dt);
                                    setTypeEditorOpen(true);
                                  }}
                                />
                                <Button
                                  kind="ghost"
                                  size="sm"
                                  hasIconOnly
                                  renderIcon={TrashCan}
                                  iconDescription="Delete"
                                  onClick={() => {
                                    const dt = deviceTypes.find(t => t.id === row.id);
                                    setDeleteTarget(dt);
                                    setDeleteModalOpen(true);
                                  }}
                                />
                              </>
                            )}
                          </div>
                        ) : (
                          renderCellContent(cell)
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DataTable>

      {deviceTypes.length === 0 && !loading && (
        <div className="empty-state">
          No device types configured.
        </div>
      )}

      {/* Device Type Editor Modal */}
      {typeEditorOpen && (
        <DeviceTypeEditor
          deviceType={editingType}
          onSave={handleTypeSaved}
          onClose={() => { setTypeEditorOpen(false); setEditingType(null); }}
        />
      )}

      {/* Delete Confirmation Modal */}
      <Modal
        open={deleteModalOpen}
        danger
        modalHeading="Delete device type?"
        primaryButtonText="Delete"
        secondaryButtonText="Cancel"
        onRequestClose={() => { setDeleteModalOpen(false); setDeleteTarget(null); }}
        onRequestSubmit={handleDeleteConfirm}
      >
        <p>
          Are you sure you want to delete <strong>{deleteTarget?.name}</strong>?
          This action cannot be undone.
        </p>
      </Modal>
    </div>
  );
}

export default DevicesPage;
