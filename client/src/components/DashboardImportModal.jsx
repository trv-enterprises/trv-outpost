// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useCallback, useMemo } from 'react';
import {
  Modal,
  FileUploaderDropContainer,
  InlineNotification,
  Loading,
  Button,
  Tag,
} from '@carbon/react';
import apiClient from '../api/client';
import { useNamespaces } from '../context/NamespaceContext';
import NamespaceSelect from './shared/NamespaceSelect';
import ImportDiffModal from './ImportDiffModal';

/**
 * DashboardImportModal
 *
 * Orchestrates the full import flow:
 *
 *   1. File upload — user drops a bundle JSON. We parse client-side
 *      and validate the format_version before hitting the server.
 *   2. Target namespace — defaults cascade: bundle's source_namespace
 *      if it exists locally → activeNamespace → "default". User can
 *      override via the select. If the source_namespace doesn't exist
 *      locally, we offer a one-click "Create namespace" so the import
 *      lands in a properly-labeled ns without a detour through the
 *      management page.
 *   3. Preflight — runs on every target-namespace change so the counts
 *      and diff/blocked buckets reflect the chosen destination.
 *   4. Apply — disabled while there are blocked conflicts. Opens the
 *      diff modal if there are overwritable conflicts so the user
 *      picks per-object. Successful apply surfaces the created/updated/
 *      skipped counts and closes.
 *
 * Props:
 *   open    — boolean.
 *   onClose — callback; called after a successful import too.
 *   onImported — optional callback fired after a successful apply so
 *                the parent can refresh its list.
 */
export default function DashboardImportModal({ open, onClose, onImported }) {
  const { namespaces, activeNamespace, refresh: refreshNamespaces } = useNamespaces();

  const [bundle, setBundle] = useState(null);
  const [fileName, setFileName] = useState('');
  const [fileError, setFileError] = useState(null);

  const [targetNamespace, setTargetNamespace] = useState('');
  const [preflight, setPreflight] = useState(null);
  const [preflightError, setPreflightError] = useState(null);
  const [loading, setLoading] = useState(false);

  const [diffOpen, setDiffOpen] = useState(false);
  const [applyError, setApplyError] = useState(null);
  const [applyResult, setApplyResult] = useState(null);
  const [creatingNamespace, setCreatingNamespace] = useState(false);

  // Derive the default target namespace every time the bundle changes:
  // bundle.source_namespace if it exists locally, else activeNamespace,
  // else "default".
  const localNames = useMemo(() => new Set(namespaces.map((n) => n.name)), [namespaces]);
  const sourceNamespaceExistsLocally = useMemo(() => {
    return !!bundle?.source_namespace && localNames.has(bundle.source_namespace);
  }, [bundle, localNames]);

  const runPreflight = useCallback(async (b, target) => {
    setLoading(true);
    setPreflight(null);
    setPreflightError(null);
    setApplyResult(null);
    try {
      const result = await apiClient.preflightImport(b, target || '');
      setPreflight(result);
    } catch (err) {
      setPreflightError(err.message || 'Preflight failed');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleFileUpload = useCallback(async (evt) => {
    const file = evt?.addedFiles?.[0] || evt?.target?.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setFileError(null);
    setApplyResult(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (parsed?.format_version !== 1) {
        throw new Error(`Unsupported format_version ${parsed?.format_version}`);
      }
      if (!parsed?.objects) {
        throw new Error('Bundle is missing an "objects" block');
      }
      setBundle(parsed);
      // Seed target: the user's active namespace always wins. The
      // bundle's source_namespace is informational (shown in a notice
      // below) but shouldn't auto-override the user's current working
      // context. Common case: "I'm working in tviviano-homelab, I just
      // want my import to land here." User can still explicitly pick
      // the source namespace from the select if that's what they want.
      const seed = activeNamespace || 'default';
      setTargetNamespace(seed);
      runPreflight(parsed, seed);
    } catch (err) {
      setBundle(null);
      setFileError(err.message || 'Failed to parse bundle');
    }
  }, [activeNamespace, localNames, runPreflight]);

  // Re-preflight when the user picks a different target namespace.
  const handleTargetChange = useCallback((ns) => {
    setTargetNamespace(ns);
    if (bundle) runPreflight(bundle, ns);
  }, [bundle, runPreflight]);

  // Offer one-click create for the bundle's source namespace when it
  // doesn't exist locally — common case for users importing a bundle
  // from someone else.
  const handleCreateSourceNamespace = useCallback(async () => {
    if (!bundle?.source_namespace) return;
    setCreatingNamespace(true);
    try {
      await apiClient.createNamespace({
        name: bundle.source_namespace,
        description: 'Created during import.',
      });
      await refreshNamespaces();
      setTargetNamespace(bundle.source_namespace);
      runPreflight(bundle, bundle.source_namespace);
    } catch (err) {
      setPreflightError(err.message || 'Failed to create namespace');
    } finally {
      setCreatingNamespace(false);
    }
  }, [bundle, refreshNamespaces, runPreflight]);

  const apply = useCallback(async (decisions = {}) => {
    if (!bundle) return;
    setLoading(true);
    setApplyError(null);
    setApplyResult(null);
    try {
      const result = await apiClient.applyImport(bundle, targetNamespace, decisions);
      setApplyResult(result);
      if (onImported) onImported(result);
    } catch (err) {
      setApplyError(err.message || 'Apply failed');
    } finally {
      setLoading(false);
      setDiffOpen(false);
    }
  }, [bundle, targetNamespace, onImported]);

  // Primary action logic:
  //   - blocked items present → Apply disabled, user must resolve
  //   - conflicts present → open the diff modal to collect decisions
  //   - only new / identical → apply directly
  const handlePrimary = useCallback(() => {
    if (!preflight) return;
    if (preflight.blocked && preflight.blocked.length > 0) return;
    if (preflight.conflicts && preflight.conflicts.length > 0) {
      setDiffOpen(true);
      return;
    }
    apply({});
  }, [preflight, apply]);

  const reset = useCallback(() => {
    setBundle(null);
    setFileName('');
    setFileError(null);
    setTargetNamespace('');
    setPreflight(null);
    setPreflightError(null);
    setApplyResult(null);
    setApplyError(null);
  }, []);

  const closeAndReset = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const hasBlocked = preflight && preflight.blocked && preflight.blocked.length > 0;
  const primaryDisabled = loading || !preflight || hasBlocked || !!applyResult;

  return (
    <>
      <Modal
        open={open}
        modalHeading="Import dashboards"
        primaryButtonText={applyResult ? 'Done' : 'Import'}
        secondaryButtonText="Cancel"
        onRequestClose={closeAndReset}
        onRequestSubmit={applyResult ? closeAndReset : handlePrimary}
        primaryButtonDisabled={primaryDisabled}
        size="md"
      >
        {loading && <Loading description="Working…" small withOverlay={false} />}

        {/* Result summary replaces the rest when apply succeeded */}
        {applyResult && (
          <InlineNotification
            kind="success"
            title="Import complete"
            subtitle={`${applyResult.created} created · ${applyResult.updated} updated · ${applyResult.skipped} skipped`}
            lowContrast
            hideCloseButton
          />
        )}

        {!applyResult && (
          <>
            {/* Step 1: file drop */}
            {!bundle && (
              <div style={{ marginBottom: '1rem' }}>
                <label className="cds--label" htmlFor="import-file">Bundle JSON</label>
                <FileUploaderDropContainer
                  id="import-file"
                  accept={['.json', 'application/json']}
                  labelText="Drop a bundle file here or click to select"
                  onAddFiles={(_, addedItems) => handleFileUpload(addedItems)}
                />
                {fileError && (
                  <InlineNotification
                    kind="error"
                    title="Invalid bundle"
                    subtitle={fileError}
                    lowContrast
                    hideCloseButton
                    style={{ marginTop: '0.5rem' }}
                  />
                )}
              </div>
            )}

            {/* Step 2+: target namespace + preflight summary */}
            {bundle && (
              <>
                <p style={{ fontSize: '0.75rem', color: 'var(--cds-text-secondary)', marginBottom: '0.5rem' }}>
                  File: <code>{fileName}</code> · source namespace: <code>{bundle.source_namespace || '(mixed)'}</code>
                </p>

                {bundle.source_namespace && !sourceNamespaceExistsLocally && (
                  <InlineNotification
                    kind="info"
                    title="Source namespace not found here"
                    subtitle={`This bundle was exported from "${bundle.source_namespace}", which doesn't exist locally. Defaulting to your active namespace "${targetNamespace}" — pick another target below, or create the source namespace to import there.`}
                    lowContrast
                    hideCloseButton
                    actions={
                      <Button
                        kind="ghost"
                        size="sm"
                        onClick={handleCreateSourceNamespace}
                        disabled={creatingNamespace}
                      >
                        Create “{bundle.source_namespace}”
                      </Button>
                    }
                    style={{ marginBottom: '0.75rem' }}
                  />
                )}

                {bundle.source_namespace && sourceNamespaceExistsLocally && bundle.source_namespace !== targetNamespace && (
                  <InlineNotification
                    kind="info"
                    title="Default target is your active namespace"
                    subtitle={`This bundle came from "${bundle.source_namespace}", which exists here. Importing to "${targetNamespace}" by default — switch below if you want to use the source namespace instead.`}
                    lowContrast
                    hideCloseButton
                    actions={
                      <Button
                        kind="ghost"
                        size="sm"
                        onClick={() => handleTargetChange(bundle.source_namespace)}
                      >
                        Use “{bundle.source_namespace}”
                      </Button>
                    }
                    style={{ marginBottom: '0.75rem' }}
                  />
                )}

                <NamespaceSelect
                  id="import-target-namespace"
                  labelText="Target namespace"
                  value={targetNamespace}
                  onChange={handleTargetChange}
                />

                {preflightError && (
                  <InlineNotification
                    kind="error"
                    title="Preflight failed"
                    subtitle={preflightError}
                    lowContrast
                    hideCloseButton
                    style={{ marginTop: '0.75rem' }}
                  />
                )}

                {preflight && (
                  <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <Tag type="green"  size="sm">{preflight.new.length} new</Tag>
                      <Tag type="gray"   size="sm">{preflight.identical.length} identical</Tag>
                      <Tag type="warm-gray" size="sm">{preflight.conflicts.length} conflicts</Tag>
                      {hasBlocked && (
                        <Tag type="red" size="sm">{preflight.blocked.length} blocked</Tag>
                      )}
                    </div>
                    {hasBlocked && (
                      <InlineNotification
                        kind="error"
                        title="Resolve these before importing"
                        subtitle={
                          preflight.blocked.map((b) =>
                            `${b.kind} "${b.incoming_name}" — ${b.reason}`
                          ).join(' · ')
                        }
                        lowContrast
                        hideCloseButton
                      />
                    )}
                  </div>
                )}

                {applyError && (
                  <InlineNotification
                    kind="error"
                    title="Apply failed"
                    subtitle={applyError}
                    lowContrast
                    hideCloseButton
                    style={{ marginTop: '0.75rem' }}
                  />
                )}
              </>
            )}
          </>
        )}
      </Modal>

      {/* Diff modal stacks on top when conflicts exist and user hits Import */}
      <ImportDiffModal
        open={diffOpen}
        conflicts={preflight?.conflicts || []}
        onClose={() => setDiffOpen(false)}
        onApply={(decisions) => apply(decisions)}
      />
    </>
  );
}
