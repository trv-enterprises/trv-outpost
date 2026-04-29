// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useState, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { TextInput, Tag as CarbonTag, FormLabel } from '@carbon/react';
import apiClient from '../../api/client';
import { getAllTagsCached, normalizeTag } from './tagsApi';
import './TagInput.scss';

/**
 * Creatable tag input with autocomplete against the shared tag pool.
 *
 * Design notes: I originally used Carbon's ComboBox (Downshift-based) for
 * suggestions, but its Enter-handling swallowed new-tag creation. This
 * uses a plain TextInput with a custom suggestion dropdown and explicit
 * Enter/comma to create.
 *
 * Props:
 * - value:       string[]    currently selected tags
 * - onChange:    (string[]) => void
 * - label:       string      form field label (default "Tags")
 * - helperText:  string      helper text beneath the input
 * - id:          string      field id (default "tag-input")
 */
function TagInput({
  value = [],
  onChange,
  label = 'Tags',
  helperText = 'Type and press Enter to add. Tags are case-insensitive.',
  id = 'tag-input',
}) {
  const [allTags, setAllTags] = useState([]);
  const [inputText, setInputText] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [dropdownPos, setDropdownPos] = useState(null);
  const containerRef = useRef(null);
  const fieldRef = useRef(null);

  // Fetch the shared tag pool on mount (session cached).
  useEffect(() => {
    let cancelled = false;
    getAllTagsCached(apiClient)
      .then((res) => {
        if (cancelled) return;
        setAllTags((res?.tags || []).map((t) => t.name));
      })
      .catch(() => {
        // Silent: TagInput still works without suggestions.
      });
    return () => { cancelled = true; };
  }, []);

  // Close suggestions when clicking outside (also accounts for the
  // portal-rendered list — check both the container and the live
  // dropdown element).
  useEffect(() => {
    const handleClickOutside = (e) => {
      const inContainer =
        containerRef.current && containerRef.current.contains(e.target);
      const inDropdown = e.target.closest?.('.tag-input__suggestions');
      if (!inContainer && !inDropdown) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Track input field position so the portal-rendered dropdown stays
  // anchored as the page scrolls or the modal repositions.
  useLayoutEffect(() => {
    if (!showSuggestions) return undefined;
    const updatePos = () => {
      if (!fieldRef.current) return;
      const r = fieldRef.current.getBoundingClientRect();
      setDropdownPos({ left: r.left, top: r.bottom, width: r.width });
    };
    updatePos();
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [showSuggestions]);

  // Compute filtered suggestions (not already selected, matching input).
  const suggestions = useMemo(() => {
    const q = inputText.trim().toLowerCase();
    return allTags
      .filter((t) => !value.includes(t))
      .filter((t) => (q ? t.toLowerCase().includes(q) : true))
      .slice(0, 8);
  }, [allTags, value, inputText]);

  const addTag = useCallback(
    (raw) => {
      const norm = normalizeTag(raw);
      if (!norm || value.includes(norm)) return;
      onChange([...value, norm].sort());
      setInputText('');
      setHighlightIndex(-1);
      setShowSuggestions(false);
    },
    [value, onChange],
  );

  const removeTag = useCallback(
    (tag) => {
      onChange(value.filter((t) => t !== tag));
    },
    [value, onChange],
  );

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      if (inputText.length === 0) return;
      e.preventDefault();
      setShowSuggestions(true);
      setHighlightIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((prev) => Math.max(prev - 1, -1));
    } else if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      // If a suggestion is highlighted, use it. Otherwise use raw input.
      if (highlightIndex >= 0 && suggestions[highlightIndex]) {
        addTag(suggestions[highlightIndex]);
      } else if (inputText.trim()) {
        addTag(inputText);
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setHighlightIndex(-1);
    }
  };

  // Preview the normalized form so users see what they'll actually save.
  const preview = inputText.trim() ? normalizeTag(inputText) : '';
  const previewIsNew =
    preview && !allTags.includes(preview) && !value.includes(preview);

  return (
    <div className="tag-input" ref={containerRef}>
      <FormLabel>{label}</FormLabel>
      <div className="tag-input__field" ref={fieldRef}>
        <TextInput
          id={id}
          labelText=""
          hideLabel
          value={inputText}
          onChange={(e) => {
            const next = e.target.value;
            setInputText(next);
            setShowSuggestions(next.length > 0);
            setHighlightIndex(-1);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Add tag..."
          helperText={
            previewIsNew
              ? `Press enter to add new tag "${preview}"`
              : helperText
          }
          autoComplete="off"
        />
      </div>
      {showSuggestions && suggestions.length > 0 && dropdownPos &&
        createPortal(
          <ul
            className="tag-input__suggestions"
            style={{
              left: `${dropdownPos.left}px`,
              top: `${dropdownPos.top}px`,
              width: `${dropdownPos.width}px`,
            }}
          >
            {suggestions.map((s, idx) => (
              <li
                key={s}
                className={
                  'tag-input__suggestion' +
                  (idx === highlightIndex ? ' tag-input__suggestion--highlighted' : '')
                }
                onMouseDown={(e) => {
                  e.preventDefault();
                  addTag(s);
                }}
                onMouseEnter={() => setHighlightIndex(idx)}
              >
                {s}
              </li>
            ))}
          </ul>,
          document.body,
        )}
      {value.length > 0 && (
        <div className="tag-input__chips">
          {value.map((t) => (
            <CarbonTag
              key={t}
              type="blue"
              size="sm"
              filter
              onClose={() => removeTag(t)}
              title={`Remove ${t}`}
            >
              {t}
            </CarbonTag>
          ))}
        </div>
      )}
    </div>
  );
}

export default TagInput;
