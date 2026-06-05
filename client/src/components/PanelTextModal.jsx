// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Modal,
  TextInput,
  Select,
  SelectItem,
  Tag,
} from '@carbon/react';
import { DISPLAY_CONTENT_FORMATS } from './controls/ControlTextLabel';
import { variableTokenFor, resolveTextTemplate } from '../utils/resolveTextTemplate';
import './PanelTextModal.scss';

// Low end keeps the original fine cadence (2px to 20, then 4px to 48);
// the large end mirrors the Number component's size steps
// (56→400, see chart-spec/specs/number.json) so a Text-panel title can
// be sized to match a giant Number, with no gap in resolution.
const FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 80, 96, 120, 160, 200, 240, 300, 400];

const ALIGN_OPTIONS = [
  { id: 'left', text: 'Left' },
  { id: 'center', text: 'Center' },
  { id: 'right', text: 'Right' },
];

/**
 * PanelTextModal — edit a text panel's config in an Apply/Cancel modal (same
 * pattern as the dashboard Settings and Variables modals). Edits a local draft;
 * Apply commits via onApply (which dirties the dashboard) and Cancel discards.
 *
 * The "Text" field is a template that may embed {{variable:NAME}} tokens,
 * inserted at the cursor by clicking a variable pill. Tokens resolve at view
 * time to the dashboard variable's display value.
 *
 * @param {boolean}  open
 * @param {object}   config      the panel's current text_config
 * @param {Function} onApply     (newConfig) => void  — commit + dirty
 * @param {Function} onClose     () => void           — cancel/discard
 * @param {Array}    variables   [{name, label}] available for insertion
 * @param {object}   variableValues  name → live value, for the inline preview
 */
function PanelTextModal({ open, config, onApply, onClose, variables = [], variableValues = {} }) {
  const [content, setContent] = useState('');
  const [displayContent, setDisplayContent] = useState('title');
  const [size, setSize] = useState(20);
  const [align, setAlign] = useState('center');
  const contentRef = useRef(null);

  // Seed the draft from the panel's config each time the modal opens, so Cancel
  // discards cleanly and a prior abandoned edit can't ride along.
  useEffect(() => {
    if (!open) return;
    setContent(config?.content || '');
    setDisplayContent(config?.display_content || 'title');
    setSize(config?.size || 20);
    setAlign(config?.align || 'center');
  }, [open, config]);

  const isTitle = displayContent === 'title';

  // Insert a token at the caret of the Text field (falls back to appending),
  // then restore focus + caret just after it. Mirrors the component editor's
  // query-pill insertion.
  const insertToken = useCallback((token) => {
    const el = contentRef.current?.input || contentRef.current;
    setContent((prev) => {
      const start = el?.selectionStart ?? prev.length;
      const end = el?.selectionEnd ?? prev.length;
      const next = prev.slice(0, start) + token + prev.slice(end);
      requestAnimationFrame(() => {
        if (el && typeof el.setSelectionRange === 'function') {
          const pos = start + token.length;
          el.focus();
          el.setSelectionRange(pos, pos);
        }
      });
      return next;
    });
  }, []);

  const handleApply = () => {
    onApply({
      content: isTitle ? content : '',
      display_content: displayContent,
      size,
      align,
    });
    onClose();
  };

  // Live preview of the resolved title (tokens → current values).
  const preview = isTitle ? resolveTextTemplate(content, variableValues) : '';

  // Content-type options with live date/time preview.
  const now = new Date();
  const contentItems = Object.entries(DISPLAY_CONTENT_FORMATS)
    // The legacy dashboard_variable content type is superseded by {{variable:…}}
    // tokens in the Text field; hide it from new edits but still render it.
    .filter(([id]) => id !== 'dashboard_variable')
    .map(([id, def]) => ({
      id,
      text: def.isDateTime ? `${def.label} — ${def.format(now)}` : def.label,
    }));

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      onRequestSubmit={handleApply}
      modalHeading="Text Panel"
      primaryButtonText="Apply"
      secondaryButtonText="Cancel"
      size="sm"
    >
      <div className="panel-text-modal-body">
        <Select
          id="text-display-content"
          labelText="Content type"
          value={displayContent}
          onChange={(e) => setDisplayContent(e.target.value)}
        >
          {contentItems.map((item) => (
            <SelectItem key={item.id} value={item.id} text={item.text} />
          ))}
        </Select>

        {isTitle && (
          <>
            <TextInput
              id="text-content"
              ref={contentRef}
              labelText="Text"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Enter text…"
              helperText="Embed a dashboard variable with the pills below."
            />
            {variables.length > 0 && (
              <div className="variable-pills">
                <span className="variable-pills__hint">Insert variable:</span>
                {variables.map((v) => {
                  const token = variableTokenFor(v.name);
                  return (
                    <Tag
                      key={v.name}
                      type="purple"
                      size="sm"
                      onClick={() => insertToken(token)}
                      title={`Insert ${token}`}
                      style={{ cursor: 'pointer' }}
                    >
                      {v.label}
                    </Tag>
                  );
                })}
              </div>
            )}
            {preview !== content && (
              <p className="panel-text-modal-preview">
                Preview: <span>{preview || '—'}</span>
              </p>
            )}
          </>
        )}

        <div className="panel-text-modal-row">
          <Select
            id="text-size"
            labelText="Font size"
            value={String(size)}
            onChange={(e) => setSize(Number(e.target.value))}
          >
            {FONT_SIZES.map((fs) => (
              <SelectItem key={fs} value={String(fs)} text={`${fs}px`} />
            ))}
          </Select>

          <Select
            id="text-align"
            labelText="Align"
            value={align}
            onChange={(e) => setAlign(e.target.value)}
          >
            {ALIGN_OPTIONS.map((opt) => (
              <SelectItem key={opt.id} value={opt.id} text={opt.text} />
            ))}
          </Select>
        </div>
      </div>
    </Modal>
  );
}

export default PanelTextModal;
