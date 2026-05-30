// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  TextInput,
  Select,
  SelectItem,
  Button
} from '@carbon/react';
import { Close } from '@carbon/icons-react';
import { DISPLAY_CONTENT_FORMATS } from './controls/ControlTextLabel';
import './PanelTextEditor.scss';

// Low end keeps the original fine cadence (2px to 20, then 4px to 48);
// the large end mirrors the Number component's size steps
// (56→400, see chart-spec/specs/number.json) so a Text-panel title can
// be sized to match a giant Number, with no gap in resolution.
const FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 80, 96, 120, 160, 200, 240, 300, 400];

const ALIGN_OPTIONS = [
  { id: 'left', text: 'Left' },
  { id: 'center', text: 'Center' },
  { id: 'right', text: 'Right' }
];

function PanelTextEditor({ config, onUpdate, onClose, anchorRect }) {
  const [content, setContent] = useState(config?.content || '');
  const [displayContent, setDisplayContent] = useState(config?.display_content || 'title');
  const [size, setSize] = useState(config?.size || 20);
  const [align, setAlign] = useState(config?.align || 'center');
  const editorRef = useRef(null);
  const configRef = useRef(config);

  // Reset state when a different panel's config is loaded
  useEffect(() => {
    if (config !== configRef.current) {
      configRef.current = config;
      setContent(config?.content || '');
      setDisplayContent(config?.display_content || 'title');
      setSize(config?.size || 20);
      setAlign(config?.align || 'center');
    }
  }, [config]);

  const isTitle = displayContent === 'title';

  // Push changes to parent on every field change
  useEffect(() => {
    onUpdate({
      content: isTitle ? content : '',
      display_content: displayContent,
      size,
      align
    });
  }, [content, displayContent, size, align]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (editorRef.current && !editorRef.current.contains(e.target)) {
        onClose();
      }
    };
    // Delay to avoid catching the click that opened the editor
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // Position below the panel's hover header, aligned to the right (near edit button)
  const style = {};
  if (anchorRect) {
    const editorWidth = 320;
    const right = anchorRect.right - editorWidth;
    style.position = 'fixed';
    style.top = anchorRect.top + 32; // 28px header + 4px gap
    style.left = Math.max(8, Math.min(right, window.innerWidth - editorWidth - 8));
    style.zIndex = 9999;
  }

  // Build display content options with live preview
  const now = new Date();
  const contentItems = Object.entries(DISPLAY_CONTENT_FORMATS).map(([id, def]) => ({
    id,
    text: def.isDateTime ? `${def.label} — ${def.format(now)}` : def.label
  }));

  return createPortal(
    <div className="panel-text-editor" ref={editorRef} style={style}>
      <div className="panel-text-editor-header">
        <span>Text Panel</span>
        <Button
          kind="ghost"
          size="sm"
          hasIconOnly
          renderIcon={Close}
          iconDescription="Close"
          onClick={onClose}
        />
      </div>
      <div className="panel-text-editor-body">
        <Select
          id="text-display-content"
          labelText="Content Type"
          value={displayContent}
          onChange={(e) => setDisplayContent(e.target.value)}
          size="sm"
        >
          {contentItems.map(item => (
            <SelectItem key={item.id} value={item.id} text={item.text} />
          ))}
        </Select>

        {isTitle && (
          <TextInput
            id="text-content"
            labelText="Text"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Enter text..."
            size="sm"
            autoFocus
          />
        )}

        <div className="panel-text-editor-row">
          <Select
            id="text-size"
            labelText="Font Size"
            value={String(size)}
            onChange={(e) => setSize(Number(e.target.value))}
            size="sm"
          >
            {FONT_SIZES.map(fs => (
              <SelectItem key={fs} value={String(fs)} text={`${fs}px`} />
            ))}
          </Select>

          <Select
            id="text-align"
            labelText="Align"
            value={align}
            onChange={(e) => setAlign(e.target.value)}
            size="sm"
          >
            {ALIGN_OPTIONS.map(opt => (
              <SelectItem key={opt.id} value={opt.id} text={opt.text} />
            ))}
          </Select>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default PanelTextEditor;
