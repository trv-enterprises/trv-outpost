// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useState, useMemo } from 'react';
import { Modal, Checkbox, Button, InlineNotification } from '@carbon/react';
import { ChevronRight, ChevronDown } from '@carbon/icons-react';
import { createTwoFilesPatch } from 'diff';
import './ImportDiffModal.scss';

/**
 * ImportDiffModal
 *
 * Single modal that aggregates every same-id-different-content conflict
 * the backend preflight surfaced. Each conflict can be expanded to show
 * a unified diff of the existing vs incoming object; each has a checkbox
 * that defaults to "overwrite" (true).
 *
 * On Apply, returns a `decisions` map keyed by `kind:id` for the parent
 * to pass to the backend apply endpoint.
 *
 * Props:
 *   open       — boolean.
 *   onClose    — cancel callback.
 *   onApply    — (decisions) => void.
 *   conflicts  — ImportConflict[] from the preflight response.
 */
export default function ImportDiffModal({ open, onClose, onApply, conflicts = [] }) {
  // Per-conflict overwrite decision, keyed by "kind:id".
  const [decisions, setDecisions] = useState({});
  const [expanded, setExpanded] = useState({});

  // Reset when the modal opens / conflicts change. Default every
  // conflict to "overwrite: true" so the fast path is Apply-without-
  // thinking; user can uncheck anything they want to preserve.
  useEffect(() => {
    if (!open) return;
    const init = {};
    conflicts.forEach((c) => {
      init[`${c.kind}:${c.id}`] = true;
    });
    setDecisions(init);
    setExpanded({});
  }, [open, conflicts]);

  const allChecked = useMemo(() => {
    return conflicts.every((c) => decisions[`${c.kind}:${c.id}`]);
  }, [conflicts, decisions]);

  const noneChecked = useMemo(() => {
    return conflicts.every((c) => !decisions[`${c.kind}:${c.id}`]);
  }, [conflicts, decisions]);

  const toggleAll = (value) => {
    const next = {};
    conflicts.forEach((c) => { next[`${c.kind}:${c.id}`] = value; });
    setDecisions(next);
  };

  const toggle = (key) => {
    setDecisions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleExpand = (key) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const diffFor = (c) => {
    // createTwoFilesPatch produces a unified diff; label the sides
    // "existing"/"incoming" so the diff headers are readable.
    return createTwoFilesPatch('existing', 'incoming', c.existing, c.incoming, '', '', { context: 3 });
  };

  return (
    <Modal
      open={open}
      modalHeading="Review conflicts"
      primaryButtonText="Apply"
      secondaryButtonText="Cancel"
      onRequestClose={onClose}
      onRequestSubmit={() => onApply(decisions)}
      size="lg"
      className="import-diff-modal"
    >
      {conflicts.length === 0 ? (
        <InlineNotification kind="info" title="No conflicts" subtitle="Nothing to review." lowContrast hideCloseButton />
      ) : (
        <>
          <p className="import-diff-modal__intro">
            These objects already exist with the same ID but different content. Checked rows will be overwritten;
            unchecked rows will be skipped (existing content preserved).
          </p>
          <div className="import-diff-modal__bulk">
            <Button kind="ghost" size="sm" onClick={() => toggleAll(true)} disabled={allChecked}>Select all</Button>
            <Button kind="ghost" size="sm" onClick={() => toggleAll(false)} disabled={noneChecked}>Deselect all</Button>
          </div>
          <div className="import-diff-modal__list">
            {conflicts.map((c) => {
              const key = `${c.kind}:${c.id}`;
              const isExpanded = !!expanded[key];
              return (
                <div key={key} className="import-diff-modal__item">
                  <div className="import-diff-modal__item-header">
                    <Checkbox
                      id={`diff-overwrite-${key}`}
                      labelText=""
                      checked={!!decisions[key]}
                      onChange={() => toggle(key)}
                    />
                    <button
                      type="button"
                      className="import-diff-modal__expand"
                      onClick={() => toggleExpand(key)}
                      aria-expanded={isExpanded}
                    >
                      {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </button>
                    <span className="import-diff-modal__kind">{c.kind}</span>
                    <span className="import-diff-modal__name">{c.name}</span>
                    <code className="import-diff-modal__id">{c.id}</code>
                  </div>
                  {isExpanded && (
                    <pre className="import-diff-modal__diff">
                      {diffFor(c).split('\n').map((line, i) => {
                        let cls = '';
                        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add';
                        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'remove';
                        else if (line.startsWith('@')) cls = 'hunk';
                        return <span key={i} className={cls}>{line + '\n'}</span>;
                      })}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </Modal>
  );
}
