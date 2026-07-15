// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
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
  Link,
} from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import apiClient from '../api/client';
import { useNamespaces } from '../context/NamespaceContext';
import NamespaceChip from '../components/shared/NamespaceChip';
import { NAMESPACE_DEFAULT_COLOR, NAMESPACE_PALETTE, namespaceChipStyle } from '../utils/namespaceColor';
import './NamespacesPage.scss';

// NAMESPACE_PALETTE moved to utils/namespaceColor so this page's create
// modal and the namespace detail page's edit form share one source (#4).

function NamespacesPage() {
  const navigate = useNavigate();
  const { namespaces, refresh } = useNamespaces();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // CREATE modal only. Editing moved to /manage/namespaces/:id (#4) —
  // a namespace now also owns its user-access list, which a modal has
  // no room for, and row-click-to-edit matches the other Manage lists.
  const [modalOpen, setModalOpen] = useState(false);
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
    setFormName('');
    setFormDescription('');
    setFormColor(NAMESPACE_DEFAULT_COLOR);
    setFormError(null);
    setModalOpen(true);
  };

  const save = useCallback(async () => {
    setLoading(true);
    setFormError(null);
    try {
      await apiClient.createNamespace({
        name: formName,
        description: formDescription,
        color: formColor,
      });
      setModalOpen(false);
      await refresh();
    } catch (err) {
      setFormError(err.message || 'Save failed');
    } finally {
      setLoading(false);
    }
  }, [formName, formDescription, formColor, refresh]);

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
            {' '}<Link href="/docs/namespaces" target="_blank" rel="noopener noreferrer">Learn more</Link>.
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
                  const { key, ...rowProps } = getRowProps({ row });
                  return (
                    // Row-click → detail page, matching the other Manage
                    // lists (users, connections, components). #4: the edit
                    // modal became a page so it can also show the
                    // namespace's users.
                    <TableRow
                      key={key}
                      {...rowProps}
                      className="clickable-row"
                      onClick={() => navigate(`/manage/namespaces/${ns.id}`)}
                    >
                      <TableCell>
                        <NamespaceChip name={ns?.name} size="md" />
                      </TableCell>
                      <TableCell>{ns?.description || <em>—</em>}</TableCell>
                      <TableCell>
                        <code className="namespaces-page__hex">{ns?.color}</code>
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
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

      {/* Create modal (edit lives at /manage/namespaces/:id — #4) */}
      <Modal
        open={modalOpen}
        modalHeading="Create namespace"
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
            labelText="Name (slug)"
            helperText="Lowercase letters, numbers, and hyphens. 3–32 characters."
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
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
                  // Render the swatch as the mapped Carbon tag color (the chip's
                  // real color), not the raw hex — so the picker previews exactly
                  // what the chip will look like.
                  style={{ backgroundColor: namespaceChipStyle(c.value).backgroundColor }}
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
