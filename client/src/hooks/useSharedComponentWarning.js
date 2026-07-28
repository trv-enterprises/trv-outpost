// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useRef, useState } from 'react';
import apiClient from '../api/client';

/**
 * Gate a component save behind a "this is on other dashboards" confirmation.
 *
 * Components are shared entities, so an edit made from one place lands
 * everywhere the component is used. Three different surfaces save components
 * (the detail page, the dashboard editor's ComponentEditorModal, and the AI
 * builder); this hook holds the rule they all follow so the warning can't
 * drift between them:
 *
 *   warn when the component already exists AND is referenced by at least one
 *   dashboard other than the one being edited.
 *
 * A brand-new component (no id) never warns — there is nothing to affect yet.
 * A component used only by the dashboard in front of you never warns either;
 * that edit does exactly what it looks like it does.
 *
 * Usage lookup failures do NOT block the save. The warning is an
 * informational courtesy, and a usage endpoint hiccup is a bad reason to
 * refuse someone's work — we let the save through rather than trapping it
 * behind a dialog we can't populate.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.currentDashboardId] Dashboard being edited, if the
 *        save happens inside a dashboard editor. Excluded from the
 *        "other dashboards" test and labeled distinctly in the dialog.
 * @returns {{
 *   modalProps: object,     // spread onto <SharedComponentWarningModal/>
 *   guardSave: Function,    // (componentId, componentName, doSave) => Promise
 * }}
 */
export default function useSharedComponentWarning({ currentDashboardId } = {}) {
  const [open, setOpen] = useState(false);
  const [dashboards, setDashboards] = useState([]);
  const [componentName, setComponentName] = useState('');
  // The deferred save. A ref, not state: it's a callback we invoke once on
  // confirm, and it must never trigger a re-render or be stale.
  const pendingSaveRef = useRef(null);

  const close = useCallback(() => {
    setOpen(false);
    pendingSaveRef.current = null;
  }, []);

  /**
   * Run `doSave`, first asking for confirmation if the component is shared.
   *
   * @param {string|null} componentId   Existing component id; falsy = create.
   * @param {string} name               Component name, for the dialog copy.
   * @param {Function} doSave           The actual save; called on confirm or
   *                                    immediately when no warning is needed.
   */
  const guardSave = useCallback(async (componentId, name, doSave) => {
    if (!componentId) return doSave(); // create — nothing to affect yet

    let usage;
    try {
      usage = await apiClient.getComponentUsage(componentId);
    } catch (err) {
      // Never let a usage-lookup failure block the user's save.
      console.error('[useSharedComponentWarning] usage lookup failed:', err);
      return doSave();
    }

    const refs = usage?.dashboards || [];
    const othersCount = refs.filter(
      (d) => d.unauthorized || d.id !== currentDashboardId
    ).length;
    if (othersCount === 0) return doSave(); // only here (or nowhere) — just save

    setComponentName(name || '');
    setDashboards(refs);
    pendingSaveRef.current = doSave;
    setOpen(true);
    return undefined;
  }, [currentDashboardId]);

  const onConfirm = useCallback(() => {
    const run = pendingSaveRef.current;
    setOpen(false);
    pendingSaveRef.current = null;
    if (run) run();
  }, []);

  return {
    guardSave,
    modalProps: {
      open,
      dashboards,
      componentName,
      currentDashboardId,
      onCancel: close,
      onConfirm,
    },
  };
}
