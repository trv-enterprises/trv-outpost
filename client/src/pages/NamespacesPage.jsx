// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useCallback } from 'react';
import {
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
  IconButton,
  Loading,
  Modal,
  TextInput,
  TextArea,
  InlineNotification,
} from '@carbon/react';
import { Add, TrashCan, Edit } from '@carbon/icons-react';
import apiClient from '../api/client';
import { useNamespaces } from '../context/NamespaceContext';
import NamespaceChip from '../components/shared/NamespaceChip';
import { NAMESPACE_DEFAULT_COLOR } from '../utils/namespaceColor';
import './NamespacesPage.scss';

// Carbon-safe palette for the color picker. Users pick one of these
// rather than typing hex — keeps the visual palette consistent and
// avoids the "I typed a hex that nobody can read on dark theme" trap.
const NAMESPACE_PALETTE = [
  { name: 'Gray',    value: '#6f6f6f' },
  { name: 'Blue',    value: '#0f62fe' },
  { name: 'Cyan',    value: '#1192e8' },
  { name: 'Teal',    value: '#009d9a' },
  { name: 'Green',   value: '#24a148' },
  { name: 'Warm',    value: '#ff832b' },
  { name: 'Red',     value: '#da1e28' },
  { name: 'Magenta', value: '#d02670' },
  { name: 'Purple',  value: '#8a3ffc' },
  { name: 'Yellow',  value: '#f1c21b' },
  { name: 'Cool',    value: '#6929c4' },
  { name: 'Black',   value: '#393939' },
];

function NamespacesPage() {
  const { namespaces, refresh } = useNamespaces();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Editor modal (both create and edit). `editing` === null means create;
  // an existing record means edit.
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formColor, setFormColor] = useState(NAMESPACE_DEFAULT_COLOR);
  const [formError, setFormError] = useState(null);

  // Delete flow: separate modal because the failure case (409 with
  // usage counts) needs its own affordance to tell the user what's in
  // the way.
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteUsage, setDeleteUsage] = useState(null);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openCreate = () => {
    setEditing(null);
    setFormName('');
    setFormDescription('');
    setFormColor(NAMESPACE_DEFAULT_COLOR);
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (ns) => {
    setEditing(ns);
    setFormName(ns.name);
    setFormDescription(ns.description || '');
    setFormColor(ns.color || NAMESPACE_DEFAULT_COLOR);
    setFormError(null);
    setModalOpen(true);
  };

  const save = useCallback(async () => {
    setLoading(true);
    setFormError(null);
    try {
      if (editing) {
        await apiClient.updateNamespace(editing.id, {
          name: formName,
          description: formDescription,
          color: formColor,
        });
      } else {
        await apiClient.createNamespace({
          name: formName,
          description: formDescription,
          color: formColor,
        });
      }
      setModalOpen(false);
      await refresh();
    } catch (err) {
      setFormError(err.message || 'Save failed');
    } finally {
      setLoading(false);
    }
  }, [editing, formName, formDescription, formColor, refresh]);

  const startDelete = (ns) => {
    setDeleteTarget(ns);
    setDeleteUsage(null);
  };

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setLoading(true);
    try {
      await apiClient.deleteNamespace(deleteTarget.id);
      setDeleteTarget(null);
      setDeleteUsage(null);
      await refresh();
    } catch (err) {
      // 409 from the backend carries a `usage` object with per-type
      // counts. Display it so the user knows what's blocking.
      const usage = err?.data?.usage;
      if (usage) setDeleteUsage(usage);
      else setDeleteUsage({ error: err.message || 'Delete failed' });
    } finally {
      setLoading(false);
    }
  }, [deleteTarget, refresh]);

  const headers = [
    { key: 'name', header: 'Namespace' },
    { key: 'description', header: 'Description' },
    { key: 'color', header: 'Color' },
    { key: 'actions', header: '' },
  ];

  const rows = namespaces.map((ns) => ({
    id: ns.id,
    name: ns.name,
    description: ns.description,
    color: ns.color,
    record: ns,
  }));

  return (
    <div className="namespaces-page">
      <div className="namespaces-page__header">
        <div>
          <h1>Namespaces</h1>
          <p className="namespaces-page__subtitle">
            Namespaces group connections, components, and dashboards into separate conflict domains.
            Two namespaces can each have a dashboard called “Home” without colliding.
          </p>
        </div>
      </div>

      {error && (
        <InlineNotification
          kind="error"
          title="Failed to load namespaces"
          subtitle={error.message || String(error)}
          lowContrast
          onClose={() => setError(null)}
        />
      )}

      <DataTable rows={rows} headers={headers}>
        {({ rows: r, headers: h, getHeaderProps, getRowProps, getTableProps }) => (
          <TableContainer>
            <TableToolbar>
              <TableToolbarContent>
                <Button renderIcon={Add} onClick={openCreate}>
                  Create namespace
                </Button>
              </TableToolbarContent>
            </TableToolbar>
            <Table {...getTableProps()}>
              <TableHead>
                <TableRow>
                  {h.map((header) => (
                    <TableHeader key={header.key} {...getHeaderProps({ header })}>
                      {header.header}
                    </TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {r.map((row) => {
                  const ns = rows.find((x) => x.id === row.id)?.record;
                  return (
                    <TableRow key={row.id} {...getRowProps({ row })}>
                      <TableCell>
                        <NamespaceChip name={ns?.name} size="md" />
                      </TableCell>
                      <TableCell>{ns?.description || <em>—</em>}</TableCell>
                      <TableCell>
                        <code className="namespaces-page__hex">{ns?.color}</code>
                      </TableCell>
                      <TableCell>
                        <IconButton
                          kind="ghost"
                          size="sm"
                          label="Edit namespace"
                          onClick={() => openEdit(ns)}
                        >
                          <Edit size={16} />
                        </IconButton>
                        <IconButton
                          kind="ghost"
                          size="sm"
                          label="Delete namespace"
                          disabled={ns?.name === 'default'}
                          onClick={() => startDelete(ns)}
                        >
                          <TrashCan size={16} />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DataTable>

      {/* Create/Edit Modal */}
      <Modal
        open={modalOpen}
        modalHeading={editing ? `Edit namespace “${editing.name}”` : 'Create namespace'}
        primaryButtonText="Save"
        secondaryButtonText="Cancel"
        onRequestClose={() => setModalOpen(false)}
        onRequestSubmit={save}
        primaryButtonDisabled={loading || !formName.trim()}
      >
        <div className="namespaces-page__form">
          {formError && (
            <InlineNotification
              kind="error"
              title="Save failed"
              subtitle={formError}
              lowContrast
              hideCloseButton
            />
          )}
          <TextInput
            id="ns-name"
            labelText={editing?.name === 'default' ? 'Name (slug) — locked' : 'Name (slug)'}
            helperText={editing?.name === 'default'
              ? 'The "default" slug is fixed — it\'s used by server-side fallbacks and the startup seed. Description and color are editable.'
              : 'Lowercase letters, numbers, and hyphens. 3–32 characters.'}
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            // The `default` slug is the server's fallback target and
            // startup-seed identity; renaming it would break those
            // invariants. Description and color stay editable.
            disabled={editing?.name === 'default'}
          />
          <TextArea
            id="ns-description"
            labelText="Description"
            rows={2}
            value={formDescription}
            onChange={(e) => setFormDescription(e.target.value)}
          />
          <fieldset className="namespaces-page__palette">
            <legend>Color</legend>
            <div className="namespaces-page__swatches">
              {NAMESPACE_PALETTE.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  aria-label={c.name}
                  title={c.name}
                  className={`namespaces-page__swatch ${formColor === c.value ? 'is-selected' : ''}`}
                  style={{ backgroundColor: c.value }}
                  onClick={() => setFormColor(c.value)}
                />
              ))}
            </div>
          </fieldset>
        </div>
      </Modal>

      {/* Delete confirmation */}
      <Modal
        open={!!deleteTarget}
        modalHeading={deleteTarget ? `Delete namespace “${deleteTarget.name}”?` : ''}
        primaryButtonText="Delete"
        secondaryButtonText="Cancel"
        danger
        onRequestClose={() => { setDeleteTarget(null); setDeleteUsage(null); }}
        onRequestSubmit={confirmDelete}
        primaryButtonDisabled={
          loading
          || (deleteUsage && !deleteUsage.error && (deleteUsage.connections > 0 || deleteUsage.components > 0 || deleteUsage.dashboards > 0))
        }
      >
        {deleteUsage && deleteUsage.error && (
          <InlineNotification kind="error" title="Delete failed" subtitle={deleteUsage.error} lowContrast hideCloseButton />
        )}
        {deleteUsage && !deleteUsage.error && (deleteUsage.connections > 0 || deleteUsage.components > 0 || deleteUsage.dashboards > 0) && (
          <InlineNotification
            kind="error"
            title="Namespace is in use"
            subtitle={`${deleteUsage.connections} connection(s), ${deleteUsage.components} component(s), ${deleteUsage.dashboards} dashboard(s). Move or delete them before trying again.`}
            lowContrast
            hideCloseButton
          />
        )}
        {!deleteUsage && (
          <p>
            The namespace will be removed. Any connections, components, or dashboards that reference it must be moved or deleted first
            — the server will reject the delete otherwise.
          </p>
        )}
      </Modal>

      {loading && <Loading description="Working…" small withOverlay={false} />}
    </div>
  );
}

export default NamespacesPage;
