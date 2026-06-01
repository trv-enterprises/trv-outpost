// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import {
  Modal,
  TextInput,
  NumberInput,
  Button,
  DataTable,
  TableContainer,
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
  IconButton
} from '@carbon/react';
import { Add, TrashCan, Edit, Checkmark, Close } from '@carbon/icons-react';
import './LayoutDimensionsEditorModal.scss';

/**
 * LayoutDimensionsEditorModal Component
 *
 * Modal for editing the list of available layout dimension presets.
 * Each dimension has: name, max_width, max_height
 */
function LayoutDimensionsEditorModal({ open, onClose, dimensions, onSave }) {
  const [localDimensions, setLocalDimensions] = useState([]);
  const [editingIndex, setEditingIndex] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', max_width: 0, max_height: 0, default_scale: 100 });
  const [newForm, setNewForm] = useState({ name: '', max_width: 1920, max_height: 1080, default_scale: 100 });
  const [showAddForm, setShowAddForm] = useState(false);

  // Initialize local state when modal opens
  useEffect(() => {
    if (open && dimensions) {
      setLocalDimensions([...dimensions]);
      setEditingIndex(null);
      setShowAddForm(false);
    }
  }, [open, dimensions]);

  const handleEdit = (index) => {
    setEditingIndex(index);
    // Default scale to 100 for presets saved before the field existed.
    setEditForm({ default_scale: 100, ...localDimensions[index] });
  };

  const handleCancelEdit = () => {
    setEditingIndex(null);
    setEditForm({ name: '', max_width: 0, max_height: 0, default_scale: 100 });
  };

  const handleSaveEdit = () => {
    const updated = [...localDimensions];
    updated[editingIndex] = { ...editForm };
    setLocalDimensions(updated);
    setEditingIndex(null);
  };

  const handleDelete = (index) => {
    const updated = localDimensions.filter((_, i) => i !== index);
    setLocalDimensions(updated);
  };

  const handleAddNew = () => {
    if (!newForm.name.trim()) return;
    setLocalDimensions([...localDimensions, { ...newForm }]);
    setNewForm({ name: '', max_width: 1920, max_height: 1080, default_scale: 100 });
    setShowAddForm(false);
  };

  const handleSave = () => {
    onSave(localDimensions);
  };

  const headers = [
    { key: 'name', header: 'Name' },
    { key: 'max_width', header: 'Max Width' },
    { key: 'max_height', header: 'Max Height' },
    { key: 'default_scale', header: 'Default Scale %' },
    { key: 'actions', header: '' }
  ];

  const rows = localDimensions.map((dim, index) => ({
    id: String(index),
    name: dim.name,
    max_width: dim.max_width,
    max_height: dim.max_height,
    default_scale: dim.default_scale || 100,
    _index: index
  }));

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      modalHeading="Edit Layout Dimensions"
      primaryButtonText="Save"
      secondaryButtonText="Cancel"
      onRequestSubmit={handleSave}
      size="lg"
      className="layout-dimensions-modal"
    >
      <div className="layout-dimensions-editor">
        <p className="modal-description">
          Configure the available layout dimension presets for dashboards.
          These dimensions determine the available screen sizes when designing dashboards.
        </p>

        <DataTable rows={rows} headers={headers}>
          {({ rows, headers, getTableProps, getHeaderProps, getRowProps }) => (
            <TableContainer>
              <Table {...getTableProps()} size="sm">
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
                    const index = localDimensions.findIndex((_, i) => String(i) === row.id);
                    const isEditing = editingIndex === index;

                    return (
                      <TableRow key={row.id} {...getRowProps({ row })}>
                        {isEditing ? (
                          <>
                            <TableCell>
                              <TextInput
                                id={`edit-name-${index}`}
                                size="sm"
                                value={editForm.name}
                                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                                labelText=""
                                hideLabel
                              />
                            </TableCell>
                            <TableCell>
                              <NumberInput
                                id={`edit-width-${index}`}
                                size="sm"
                                value={editForm.max_width}
                                onChange={(e, { value }) => setEditForm({ ...editForm, max_width: value })}
                                min={100}
                                max={10000}
                                hideLabel
                                label=""
                              />
                            </TableCell>
                            <TableCell>
                              <NumberInput
                                id={`edit-height-${index}`}
                                size="sm"
                                value={editForm.max_height}
                                onChange={(e, { value }) => setEditForm({ ...editForm, max_height: value })}
                                min={100}
                                max={10000}
                                hideLabel
                                label=""
                              />
                            </TableCell>
                            <TableCell>
                              <NumberInput
                                id={`edit-scale-${index}`}
                                size="sm"
                                value={editForm.default_scale ?? 100}
                                onChange={(e, { value }) => setEditForm({ ...editForm, default_scale: value })}
                                min={50}
                                max={200}
                                step={5}
                                hideLabel
                                label=""
                              />
                            </TableCell>
                            <TableCell>
                              <div className="action-buttons">
                                <IconButton
                                  kind="ghost"
                                  size="sm"
                                  label="Save"
                                  onClick={handleSaveEdit}
                                >
                                  <Checkmark />
                                </IconButton>
                                <IconButton
                                  kind="ghost"
                                  size="sm"
                                  label="Cancel"
                                  onClick={handleCancelEdit}
                                >
                                  <Close />
                                </IconButton>
                              </div>
                            </TableCell>
                          </>
                        ) : (
                          <>
                            <TableCell>{row.cells.find(c => c.info.header === 'name')?.value}</TableCell>
                            <TableCell>{row.cells.find(c => c.info.header === 'max_width')?.value}px</TableCell>
                            <TableCell>{row.cells.find(c => c.info.header === 'max_height')?.value}px</TableCell>
                            <TableCell>{row.cells.find(c => c.info.header === 'default_scale')?.value}%</TableCell>
                            <TableCell>
                              <div className="action-buttons">
                                <IconButton
                                  kind="ghost"
                                  size="sm"
                                  label="Edit"
                                  onClick={() => handleEdit(index)}
                                >
                                  <Edit />
                                </IconButton>
                                <IconButton
                                  kind="ghost"
                                  size="sm"
                                  label="Delete"
                                  onClick={() => handleDelete(index)}
                                >
                                  <TrashCan />
                                </IconButton>
                              </div>
                            </TableCell>
                          </>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </DataTable>

        {showAddForm ? (
          <div className="add-form">
            <div className="add-form-inputs">
              <TextInput
                id="new-name"
                size="sm"
                labelText="Name"
                placeholder="e.g., 1920x1080-HD"
                value={newForm.name}
                onChange={(e) => setNewForm({ ...newForm, name: e.target.value })}
              />
              <NumberInput
                id="new-width"
                size="sm"
                label="Max Width"
                value={newForm.max_width}
                onChange={(e, { value }) => setNewForm({ ...newForm, max_width: value })}
                min={100}
                max={10000}
              />
              <NumberInput
                id="new-height"
                size="sm"
                label="Max Height"
                value={newForm.max_height}
                onChange={(e, { value }) => setNewForm({ ...newForm, max_height: value })}
                min={100}
                max={10000}
              />
              <NumberInput
                id="new-scale"
                size="sm"
                label="Default Scale %"
                value={newForm.default_scale}
                onChange={(e, { value }) => setNewForm({ ...newForm, default_scale: value })}
                min={50}
                max={200}
                step={5}
              />
            </div>
            <div className="add-form-actions">
              <Button kind="secondary" size="sm" onClick={() => setShowAddForm(false)}>
                Cancel
              </Button>
              <Button kind="primary" size="sm" onClick={handleAddNew} disabled={!newForm.name.trim()}>
                Add Dimension
              </Button>
            </div>
          </div>
        ) : (
          <Button
            kind="tertiary"
            size="sm"
            renderIcon={Add}
            onClick={() => setShowAddForm(true)}
            className="add-button"
          >
            Add Dimension
          </Button>
        )}
      </div>
    </Modal>
  );
}

export default LayoutDimensionsEditorModal;
