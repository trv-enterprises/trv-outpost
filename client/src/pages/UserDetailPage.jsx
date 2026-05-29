// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Button,
  Loading,
  Modal,
  TextInput,
  Checkbox,
  Toggle
} from '@carbon/react';
import { Save, Close, ArrowLeft } from '@carbon/icons-react';
import apiClient from '../api/client';
import DiscardChangesModal from '../components/shared/DiscardChangesModal';
import './UserDetailPage.scss';

/**
 * UserDetailPage Component
 *
 * Create/Edit user with capabilities configuration.
 */
function UserDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isCreateMode = id === 'new';

  const [user, setUser] = useState(null);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState('');
  const [email, setEmail] = useState('');
  const [clerkUserID, setClerkUserID] = useState('');
  const [active, setActive] = useState(true);
  const [capabilities, setCapabilities] = useState({
    view: true,
    design: false,
    manage: false,
    control: false
  });
  const [loading, setLoading] = useState(!isCreateMode);
  const [error, setError] = useState(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isCreateMode) {
      fetchUser();
    }
  }, [id]);

  const fetchUser = async () => {
    try {
      setLoading(true);
      const data = await apiClient.getUser(id);

      setUser(data);
      setName(data.name);
      setEmail(data.email || '');
      setClerkUserID(data.clerk_user_id || '');
      setActive(data.active !== false);

      // Convert capabilities array to object
      const caps = {
        view: false,
        design: false,
        manage: false,
        control: false
      };
      (data.capabilities || []).forEach(cap => {
        caps[cap] = true;
      });
      setCapabilities(caps);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Check for duplicate user name on blur
  const checkDuplicateName = async (nameToCheck) => {
    if (!nameToCheck || !nameToCheck.trim()) {
      setNameError('');
      return;
    }
    try {
      const response = await apiClient.getUsers();
      const users = response.users || [];
      const duplicate = users.find(u =>
        u.name.toLowerCase() === nameToCheck.trim().toLowerCase() &&
        u.id !== id
      );
      if (duplicate) {
        setNameError('A user with this name already exists');
      } else {
        setNameError('');
      }
    } catch (err) {
      console.error('Error checking user name:', err);
      setNameError('');
    }
  };

  const handleCapabilityChange = (capability, checked) => {
    setCapabilities(prev => ({
      ...prev,
      [capability]: checked
    }));
    setHasChanges(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Convert capabilities object to array
      const capsArray = Object.entries(capabilities)
        .filter(([, enabled]) => enabled)
        .map(([cap]) => cap);

      const payload = {
        name,
        email: email || undefined,
        capabilities: capsArray,
        active,
      };

      // Only send clerk_user_id when editing — admins use this to
      // re-link or pre-link a user to a Clerk identity. Send the
      // string value directly (including "" to clear an existing
      // link). Skipped on create because Clerk IDs come from a
      // sign-in event, not an admin form.
      if (!isCreateMode) {
        payload.clerk_user_id = clerkUserID;
      }

      if (isCreateMode) {
        await apiClient.createUser(payload);
      } else {
        await apiClient.updateUser(id, payload);
      }

      setHasChanges(false);
      setShowSaveModal(false);
      navigate('/manage/users');
    } catch (err) {
      alert(`Failed to save: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (hasChanges) {
      setShowCancelModal(true);
    } else {
      navigate('/manage/users');
    }
  };

  const confirmCancel = () => {
    setShowCancelModal(false);
    navigate('/manage/users');
  };

  if (loading) {
    return (
      <div className="user-detail-page">
        <Loading description="Loading user..." withOverlay={false} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="user-detail-page">
        <div className="error-message">Error: {error}</div>
        <Button onClick={() => navigate('/manage/users')}>Back to Users</Button>
      </div>
    );
  }

  return (
    <div className="user-detail-page">
      {/* Page header bar with title and actions */}
      <div className="page-header-bar">
        <div className="header-left">
          <Button
            kind="ghost"
            renderIcon={ArrowLeft}
            onClick={() => navigate('/manage/users')}
            size="md"
          >
            Back
          </Button>
          <h1>{isCreateMode ? 'Create User' : 'Edit User'}</h1>
        </div>
        <div className="page-actions">
          <Button
            kind="secondary"
            renderIcon={Close}
            onClick={handleCancel}
            size="md"
          >
            Cancel
          </Button>
          <Button
            kind="primary"
            renderIcon={Save}
            onClick={() => setShowSaveModal(true)}
            disabled={!name || nameError}
            size="md"
          >
            Save User
          </Button>
        </div>
      </div>

      {/* Form content */}
      <div className="form-content">
        {/* User Name */}
        <div className="form-row">
          <TextInput
            id="user-name"
            labelText="Name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setHasChanges(true);
              if (nameError) setNameError('');
            }}
            onBlur={(e) => checkDuplicateName(e.target.value)}
            placeholder="Enter user name"
            invalid={!!nameError}
            invalidText={nameError}
          />
        </div>

        {/* Email */}
        <div className="form-row">
          <TextInput
            id="user-email"
            labelText="Email (optional)"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setHasChanges(true);
            }}
            placeholder="Enter email address"
            type="email"
            helperText="Used by Clerk sign-in to JIT-link this user to their Clerk identity on first sign-in."
          />
        </div>

        {/* Clerk user ID — admin override for the Clerk JIT link.
            Hidden on create because Clerk IDs are issued by a Clerk
            sign-in event, not by the dashboard admin form. */}
        {!isCreateMode && (
          <div className="form-row">
            <TextInput
              id="user-clerk-id"
              labelText="Clerk user ID (advanced)"
              value={clerkUserID}
              onChange={(e) => {
                setClerkUserID(e.target.value);
                setHasChanges(true);
              }}
              placeholder="user_2abc...XYZ (auto-populated on first Clerk sign-in)"
              helperText="Set automatically the first time this user signs in via Clerk. Edit only to manually re-link to a different Clerk identity, or clear to break the link."
            />
          </div>
        )}

        {/* Active Status */}
        <div className="form-row">
          <Toggle
            id="user-active"
            labelText="Account Status"
            labelA="Inactive"
            labelB="Active"
            toggled={active}
            onToggle={(checked) => {
              setActive(checked);
              setHasChanges(true);
            }}
          />
        </div>

        {/* Capabilities Section */}
        <div className="config-section">
          <h3>Capabilities</h3>
          <p className="section-description">
            Select the capabilities this user should have. Capabilities determine which modes the user can access.
          </p>

          <div className="capabilities-form">
            <div className="capability-item">
              <Checkbox
                id="cap-view"
                labelText="View"
                checked={capabilities.view}
                onChange={(e) => handleCapabilityChange('view', e.target.checked)}
              />
              <span className="capability-description">
                Access View mode to see dashboards and data visualizations
              </span>
            </div>

            <div className="capability-item">
              <Checkbox
                id="cap-design"
                labelText="Design"
                checked={capabilities.design}
                onChange={(e) => handleCapabilityChange('design', e.target.checked)}
              />
              <span className="capability-description">
                Access Design mode to create and edit charts, dashboards, and data sources
              </span>
            </div>

            <div className="capability-item">
              <Checkbox
                id="cap-manage"
                labelText="Manage"
                checked={capabilities.manage}
                onChange={(e) => handleCapabilityChange('manage', e.target.checked)}
              />
              <span className="capability-description">
                Access Manage mode for system administration and user management
              </span>
            </div>

            <div className="capability-item">
              <Checkbox
                id="cap-control"
                labelText="Control"
                checked={capabilities.control}
                onChange={(e) => handleCapabilityChange('control', e.target.checked)}
              />
              <span className="capability-description">
                Fire control commands (buttons, toggles, sliders) and mark Frigate alerts as reviewed. Independent of design/manage.
              </span>
            </div>
          </div>
        </div>

        {/* GUID Display (edit mode only) */}
        {!isCreateMode && user && (
          <div className="config-section">
            <h3>Authentication</h3>
            <div className="form-row">
              <TextInput
                id="user-guid"
                labelText="User GUID (read-only)"
                value={user.guid || ''}
                readOnly
              />
            </div>
          </div>
        )}
      </div>

      {/* Cancel confirmation modal */}
      <DiscardChangesModal
        open={showCancelModal}
        onKeepEditing={() => setShowCancelModal(false)}
        onDiscard={confirmCancel}
      />

      {/* Save confirmation modal */}
      {showSaveModal && (
        <Modal
          open={true}
          onRequestClose={() => setShowSaveModal(false)}
          onRequestSubmit={handleSave}
          modalHeading={isCreateMode ? "Create User" : "Save Changes"}
          primaryButtonText={saving ? "Saving..." : "Save"}
          secondaryButtonText="Cancel"
          primaryButtonDisabled={saving}
        >
          <p>
            {isCreateMode
              ? `Create user "${name}"?`
              : `Save changes to user "${name}"?`}
          </p>
          <div className="modal-capabilities">
            <strong>Capabilities:</strong>{' '}
            {Object.entries(capabilities)
              .filter(([, enabled]) => enabled)
              .map(([cap]) => cap.toUpperCase())
              .join(', ') || 'None'}
          </div>
        </Modal>
      )}
    </div>
  );
}

export default UserDetailPage;
