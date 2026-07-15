// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Button,
  Loading,
  TextInput,
  TextArea,
  InlineNotification,
  DataTable,
  TableContainer,
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
  IconButton,
  Modal,
  Dropdown,
  Tag,
} from '@carbon/react';
import { Save, Close, ArrowLeft, TrashCan, Add } from '@carbon/icons-react';
import apiClient from '../api/client';
import { useNamespaces } from '../context/NamespaceContext';
import DiscardChangesModal from '../components/shared/DiscardChangesModal';
import {
  NAMESPACE_DEFAULT_COLOR,
  NAMESPACE_PALETTE,
  namespaceChipStyle,
  canonicalNamespaceColor,
} from '../utils/namespaceColor';
import './NamespaceDetailPage.scss';

/**
 * NamespaceDetailPage — edit one namespace, and manage which users can
 * see its content (#4).
 *
 * Replaces the old edit MODAL on NamespacesPage: grants gave the
 * namespace a second dimension (its users) that a modal has no room
 * for, and the other Manage lists (users, connections, components)
 * already use row-click → detail page. Create still happens in a small
 * modal on the list page — there's nothing to show a brand-new
 * namespace yet.
 *
 * Grant edits go through PUT /api/users/:id (the same write the user
 * edit page uses) rather than a namespace-side write endpoint, so
 * there's exactly one server path that mutates grants.
 */
function NamespaceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { refresh: refreshNamespaces } = useNamespaces();

  const [namespace, setNamespace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);

  // Editable fields
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formColor, setFormColor] = useState(NAMESPACE_DEFAULT_COLOR);

  // Users with access (restricted users granted this namespace).
  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [candidateUsers, setCandidateUsers] = useState([]);
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [grantError, setGrantError] = useState(null);

  // The `default` slug is the server's fallback target and startup-seed
  // identity; renaming it would break those invariants.
  const isDefault = namespace?.name === 'default';

  const fetchNamespace = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiClient.getNamespace(id);
      setNamespace(data);
      setFormName(data.name);
      setFormDescription(data.description || '');
      // Normalize legacy/dropped colors to the surviving palette swatch so
      // the picker highlights the right one.
      setFormColor(canonicalNamespaceColor(data.color || NAMESPACE_DEFAULT_COLOR));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  const fetchUsers = useCallback(async () => {
    try {
      setUsersLoading(true);
      const data = await apiClient.getNamespaceUsers(id);
      setUsers(data?.users || []);
    } catch {
      // Non-fatal: the form still works without the access list.
      setUsers([]);
    } finally {
      setUsersLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchNamespace();
    fetchUsers();
  }, [fetchNamespace, fetchUsers]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await apiClient.updateNamespace(id, {
        name: formName,
        description: formDescription,
        color: formColor,
      });
      setHasChanges(false);
      await refreshNamespaces();
      navigate('/manage/namespaces');
    } catch (err) {
      setSaveError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (hasChanges) setShowCancelModal(true);
    else navigate('/manage/namespaces');
  };

  // Open the add-user picker. Candidates are RESTRICTED users who don't
  // already have this grant — an unrestricted user already sees every
  // namespace, so "adding" them here would be a no-op (or, worse, imply
  // we'd restrict them).
  const openAddUser = async () => {
    setGrantError(null);
    setSelectedCandidate(null);
    try {
      const resp = await apiClient.getUsers({ page_size: 'all' });
      const granted = new Set(users.map((u) => u.id));
      const eligible = (resp?.users || []).filter(
        (u) => u.namespaces_restricted && !granted.has(u.id)
      );
      setCandidateUsers(eligible);
      setAddUserOpen(true);
    } catch (err) {
      setGrantError(err.message || 'Failed to load users');
      setAddUserOpen(true);
    }
  };

  const addUserGrant = async () => {
    if (!selectedCandidate || !namespace) return;
    setGrantError(null);
    try {
      const next = [...(selectedCandidate.allowed_namespaces || []), namespace.name];
      await apiClient.updateUser(selectedCandidate.id, { allowed_namespaces: next });
      setAddUserOpen(false);
      await fetchUsers();
    } catch (err) {
      setGrantError(err.message || 'Failed to grant access');
    }
  };

  const removeUserGrant = async (user) => {
    if (!namespace) return;
    try {
      const next = (user.allowed_namespaces || []).filter((n) => n !== namespace.name);
      await apiClient.updateUser(user.id, { allowed_namespaces: next });
      await fetchUsers();
    } catch (err) {
      setGrantError(err.message || 'Failed to revoke access');
    }
  };

  if (loading) {
    return (
      <div className="namespace-detail-page">
        <Loading description="Loading namespace..." withOverlay={false} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="namespace-detail-page">
        <InlineNotification kind="error" title="Failed to load" subtitle={error} lowContrast hideCloseButton />
        <Button kind="ghost" renderIcon={ArrowLeft} onClick={() => navigate('/manage/namespaces')}>
          Back to namespaces
        </Button>
      </div>
    );
  }

  const userHeaders = [
    { key: 'name', header: 'User' },
    { key: 'email', header: 'Email' },
    { key: 'actions', header: '' },
  ];
  const userRows = users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email || '—',
  }));

  return (
    <div className="namespace-detail-page">
      <div className="page-header">
        <Button kind="ghost" size="sm" renderIcon={ArrowLeft} onClick={handleCancel}>
          Namespaces
        </Button>
        <h1>
          Edit namespace
          <Tag type="gray" style={namespaceChipStyle(formColor)}>{formName}</Tag>
        </h1>
      </div>

      <div className="page-actions">
        <Button kind="secondary" renderIcon={Close} onClick={handleCancel}>Cancel</Button>
        <Button
          renderIcon={Save}
          onClick={handleSave}
          disabled={saving || !formName.trim() || !hasChanges}
        >
          Save
        </Button>
      </div>

      {saveError && (
        <InlineNotification kind="error" title="Save failed" subtitle={saveError} lowContrast hideCloseButton />
      )}

      <div className="config-section">
        <h3>Details</h3>
        <div className="namespace-detail-page__form">
          <TextInput
            id="ns-name"
            labelText={isDefault ? 'Name (slug) — locked' : 'Name (slug)'}
            helperText={isDefault
              ? 'The "default" slug is fixed — it\'s used by server-side fallbacks and the startup seed. Description and color are editable.'
              : 'Lowercase letters, numbers, and hyphens. 3–32 characters. Renaming updates every record and user grant that references this namespace.'}
            value={formName}
            onChange={(e) => { setFormName(e.target.value); setHasChanges(true); }}
            disabled={isDefault}
          />
          <TextArea
            id="ns-description"
            labelText="Description"
            rows={2}
            value={formDescription}
            onChange={(e) => { setFormDescription(e.target.value); setHasChanges(true); }}
          />
          <fieldset className="namespace-detail-page__palette">
            <legend>Color</legend>
            <div className="namespace-detail-page__swatches">
              {NAMESPACE_PALETTE.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  aria-label={c.name}
                  title={c.name}
                  className={`namespace-detail-page__swatch ${formColor === c.value ? 'is-selected' : ''}`}
                  // Render the swatch as the mapped Carbon tag color (the
                  // chip's real color), not the raw hex — the picker
                  // previews exactly what the chip will look like.
                  style={{ backgroundColor: namespaceChipStyle(c.value).backgroundColor }}
                  onClick={() => { setFormColor(c.value); setHasChanges(true); }}
                />
              ))}
            </div>
          </fieldset>
        </div>
      </div>

      <div className="config-section">
        <div className="config-section__header">
          <h3>Users with access</h3>
          <Button size="sm" kind="tertiary" renderIcon={Add} onClick={openAddUser}>
            Add user
          </Button>
        </div>
        <p className="section-description">
          Users restricted to specific namespaces who have been granted this one.
          Users who aren&apos;t restricted can see every namespace and aren&apos;t listed here.
        </p>

        {grantError && (
          <InlineNotification kind="error" title="Access change failed" subtitle={grantError} lowContrast onClose={() => setGrantError(null)} />
        )}

        {usersLoading ? (
          <Loading description="Loading users..." withOverlay={false} small />
        ) : users.length === 0 ? (
          <p className="namespace-detail-page__empty">No restricted users have been granted this namespace.</p>
        ) : (
          <DataTable rows={userRows} headers={userHeaders}>
            {({ rows, headers, getTableProps, getHeaderProps, getRowProps }) => (
              <TableContainer>
                <Table {...getTableProps()} size="sm">
                  <TableHead>
                    <TableRow>
                      {headers.map((header) => {
                        const { key, ...rest } = getHeaderProps({ header });
                        return <TableHeader key={key} {...rest}>{header.header}</TableHeader>;
                      })}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rows.map((row) => {
                      const { key, ...rest } = getRowProps({ row });
                      const user = users.find((u) => u.id === row.id);
                      return (
                        <TableRow key={key} {...rest}>
                          {row.cells.map((cell) => {
                            if (cell.info.header === 'actions') {
                              return (
                                <TableCell key={cell.id}>
                                  <IconButton
                                    kind="ghost"
                                    size="sm"
                                    label="Revoke access"
                                    onClick={() => removeUserGrant(user)}
                                  >
                                    <TrashCan />
                                  </IconButton>
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
        )}
      </div>

      <Modal
        open={addUserOpen}
        modalHeading={`Grant access to “${namespace?.name}”`}
        primaryButtonText="Grant access"
        secondaryButtonText="Cancel"
        primaryButtonDisabled={!selectedCandidate}
        onRequestClose={() => setAddUserOpen(false)}
        onRequestSubmit={addUserGrant}
        selectorPrimaryFocus="#ns-add-user"
      >
        {candidateUsers.length === 0 ? (
          <p>
            Every namespace-restricted user already has access to this namespace.
            To restrict a user to specific namespaces, open them in Manage → Users
            and use the Namespaces tab.
          </p>
        ) : (
          <Dropdown
            id="ns-add-user"
            titleText="User"
            label="Select a user"
            items={candidateUsers}
            itemToString={(u) => (u ? `${u.name}${u.email ? ` (${u.email})` : ''}` : '')}
            selectedItem={selectedCandidate}
            onChange={({ selectedItem }) => setSelectedCandidate(selectedItem)}
          />
        )}
      </Modal>

      <DiscardChangesModal
        open={showCancelModal}
        onClose={() => setShowCancelModal(false)}
        onDiscard={() => { setShowCancelModal(false); navigate('/manage/namespaces'); }}
      />
    </div>
  );
}

export default NamespaceDetailPage;
