// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Loading, Modal, UnorderedList, ListItem, InlineLoading } from '@carbon/react';
import { Save, Close, ArrowLeft } from '@carbon/icons-react';
import ComponentEditor from '../components/ComponentEditor';
import apiClient from '../api/client';
import DiscardChangesModal from '../components/shared/DiscardChangesModal';
import { invalidateTagsCache } from '../components/shared/tagsApi';
import { clearDataviewLayoutForCurrentUser } from '../hooks/useDataviewLayout';
import useAssistantSurface from '../hooks/useAssistantSurface';
import { useAIAvailability } from '../context/AIAvailabilityContext';
import './ComponentDetailPage.scss';

/**
 * ComponentDetailPage Component
 *
 * Standalone page for creating/editing charts and controls.
 * Uses shared ComponentEditor component.
 * Pass ?type=control to create a control instead of a chart.
 */
function ComponentDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isCreateMode = id === 'new';
  const initialComponentType = searchParams.get('type') || 'chart';
  // "From Existing" seeds a NEW component from an existing one's fields.
  // We're still in create mode (id === 'new'), so save POSTs a new record —
  // we just need to load the source's data first.
  const cloneFromId = isCreateMode ? searchParams.get('cloneFrom') : null;

  // Initialize chart with component_type from URL param for new controls
  const [chart, setChart] = useState(() => {
    if (isCreateMode && !cloneFromId && initialComponentType === 'control') {
      return { component_type: 'control' };
    }
    return null;
  });
  // Loading when editing an existing component OR seeding a clone — both fetch.
  const [loading, setLoading] = useState(!isCreateMode || !!cloneFromId);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [pendingPayload, setPendingPayload] = useState(null);
  // Dashboards this save will reach, shown inside the save-confirm modal.
  // null = not applicable (create) or lookup failed.
  const [saveUsage, setSaveUsage] = useState(null);
  const [saveUsageLoading, setSaveUsageLoading] = useState(false);
  const [isValid, setIsValid] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [showDiscardModal, setShowDiscardModal] = useState(false);
  const editorRef = useRef(null);
  // Guards the one-shot clone seed against StrictMode's double-effect run
  // (and any remount), so we don't fetch + re-suffix the name twice.
  const clonedFromRef = useRef(null);

  useEffect(() => {
    if (cloneFromId) {
      if (clonedFromRef.current === cloneFromId) return;
      clonedFromRef.current = cloneFromId;
      fetchCloneSource(cloneFromId);
    } else if (!isCreateMode) {
      fetchChart();
    }
  }, [id, cloneFromId]);

  // Publish the current component surface to the Dashboard Assistant.
  // Always EDIT mode here — this page only renders the editor, never
  // a read-only view. New (unsaved) components publish a surface
  // without an ID so the agent at least knows the user is in the
  // editor, even before save. Skip the registration entirely when
  // the assistant is disabled — no consumer to feed.
  const { chatAgentEnabled } = useAIAvailability();
  const assistantSurface = useMemo(() => {
    if (!chatAgentEnabled) return null;
    return {
      mode: 'EDIT',
      surface: 'COMPONENT',
      surfaceId: !isCreateMode ? (chart?.id || id) : undefined,
      surfaceName: chart?.title || chart?.name || undefined,
    };
  }, [chatAgentEnabled, isCreateMode, id, chart?.id, chart?.title, chart?.name]);
  useAssistantSurface(assistantSurface);

  const fetchChart = async () => {
    try {
      setLoading(true);
      const data = await apiClient.getComponent(id);
      setChart(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Seed a new component from an existing one's fields. Strip identity and
  // version metadata so the editor treats it as a fresh record, and suffix
  // the name so it doesn't collide with the source on the (namespace, name)
  // uniqueness constraint at create time.
  const fetchCloneSource = async (sourceId) => {
    try {
      setLoading(true);
      const data = await apiClient.getComponent(sourceId);
      // Strip identity, version, draft-session, timestamp, and usage fields so
      // the editor saves this as a brand-new record (json field names per
      // models.Component).
      const {
        id: _id, version: _v, status: _s, ai_session_id: _ai,
        created: _c, updated: _u, dashboard_usage: _du,
        version_count: _vc, has_draft: _hd,
        ...seed
      } = data;
      setChart({ ...seed, name: `${data.name || 'Component'} (Copy)` });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (chartPayload) => {
    // Show confirmation modal with the payload
    setPendingPayload(chartPayload);
    setShowSaveModal(true);
    // This page already confirms every save, so rather than stacking a second
    // dialog we fold the shared-component warning into that one: look up which
    // dashboards this edit will reach and list them in the same modal. Fetched
    // alongside the open (not awaited before it) so the dialog appears
    // instantly and fills in.
    if (isCreateMode || !id || id === 'new') {
      setSaveUsage(null);
      return;
    }
    setSaveUsageLoading(true);
    try {
      const usage = await apiClient.getComponentUsage(id);
      setSaveUsage(usage?.dashboards || []);
    } catch (err) {
      // Informational only — never block the save on a usage hiccup.
      console.error('[ComponentDetailPage] usage lookup failed:', err);
      setSaveUsage(null);
    } finally {
      setSaveUsageLoading(false);
    }
  };

  const confirmSave = async () => {
    if (!pendingPayload) return;

    setSaving(true);
    try {
      if (isCreateMode) {
        await apiClient.createComponent(pendingPayload);
      } else {
        await apiClient.updateComponent(id, pendingPayload);
        // The author just re-specified this component's column layout, so
        // drop THEIR OWN per-user drag widths for it. Otherwise the widths
        // they dragged while viewing the chart earlier sit on top of the
        // layout they just saved: change a column, save, open the viewer,
        // and see the old width with nothing on screen explaining why.
        //
        // widthBase only invalidates a drag when the author sets an
        // explicit width on that column — it does nothing when the change
        // is to release a width back to autosize, reorder, or hide, which
        // are exactly the cases that strand a stale drag.
        //
        // Only the saving user's own layout for this one component is
        // cleared; other users' drags remain their own preference.
        // Best-effort — never block the save on it.
        await clearDataviewLayoutForCurrentUser(id);
      }

      invalidateTagsCache();
      setShowSaveModal(false);
      navigate('/design/components');
    } catch (err) {
      alert(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (editorRef.current?.hasUnsavedChanges?.()) {
      setShowDiscardModal(true);
      return;
    }
    navigate('/design/components');
  };

  const confirmDiscard = () => {
    setShowDiscardModal(false);
    navigate('/design/components');
  };

  const handleSaveClick = () => {
    if (editorRef.current) {
      editorRef.current.save();
    }
  };

  if (loading) {
    return (
      <div className="component-detail-page">
        <Loading description="Loading chart..." withOverlay={false} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="component-detail-page">
        <div className="error-message">Error: {error}</div>
        <Button onClick={() => navigate('/design/components')}>Back to Charts</Button>
      </div>
    );
  }

  return (
    <div className="component-detail-page">
      {/* Page header bar with title and actions */}
      <div className="page-header-bar">
        <div className="header-left">
          <Button
            kind="ghost"
            renderIcon={ArrowLeft}
            onClick={() => navigate('/design/components')}
            size="md"
          >
            Back
          </Button>
          <h1>{isCreateMode ? 'Create Component' : 'Edit Component'}</h1>
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
            onClick={handleSaveClick}
            disabled={saving || !isValid || !isDirty}
            size="md"
          >
            Save
          </Button>
        </div>
      </div>

      {/* key on the route id (or 'new' for create) so navigating between
          charts — or from an edit to a fresh create — remounts the editor
          with clean state instead of bleeding the previous chart's fields
          (e.g. a stale options.xAxisRange or phantom sliding window) into
          the next one. The init effect resets on `chart` change too; this
          is belt-and-suspenders for instance reuse. */}
      <ComponentEditor
        key={id || 'new'}
        ref={editorRef}
        chart={chart}
        onSave={handleSave}
        onCancel={handleCancel}
        saving={saving}
        showActions={false}
        className="component-detail-editor"
        onValidityChange={setIsValid}
        onDirtyChange={setIsDirty}
      />

      {/* Discard changes confirmation */}
      <DiscardChangesModal
        open={showDiscardModal}
        onKeepEditing={() => setShowDiscardModal(false)}
        onDiscard={confirmDiscard}
        body="You have unsaved changes. Discard them and leave?"
      />

      {/* Save confirmation modal */}
      {showSaveModal && (
        <Modal
          open={true}
          onRequestClose={() => setShowSaveModal(false)}
          onRequestSubmit={confirmSave}
          modalHeading={isCreateMode ? "Create Component" : "Save Changes"}
          primaryButtonText={saving ? "Saving..." : "Save"}
          secondaryButtonText="Cancel"
          primaryButtonDisabled={saving}
        >
          <p>
            {isCreateMode
              ? `Create component "${pendingPayload?.name}"?`
              : `Save changes to "${pendingPayload?.name}"?`}
          </p>
          {/* Shared-component notice: components are shared entities, so this
              save lands on every dashboard using it, not just the one the
              author had in mind. */}
          {saveUsageLoading && (
            <InlineLoading description="Checking where this component is used…" />
          )}
          {!saveUsageLoading && saveUsage && saveUsage.length > 0 && (
            <>
              <p style={{ marginTop: '0.75rem' }}>
                This component is used on {saveUsage.length} dashboard
                {saveUsage.length === 1 ? '' : 's'} — saving updates it on{' '}
                {saveUsage.length === 1 ? 'it' : 'all of them'}:
              </p>
              <UnorderedList style={{ margin: '0.5rem 0 0 1rem' }}>
                {saveUsage.filter((d) => !d.unauthorized).map((d) => (
                  <ListItem key={d.id}>{d.name}</ListItem>
                ))}
                {saveUsage.some((d) => d.unauthorized) && (
                  <ListItem key="hidden">
                    {saveUsage.filter((d) => d.unauthorized).length} in a namespace you
                    can&apos;t view
                  </ListItem>
                )}
              </UnorderedList>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

export default ComponentDetailPage;
