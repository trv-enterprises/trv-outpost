// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  IconButton,
  InlineLoading,
  Popover,
  PopoverContent,
} from '@carbon/react';
import {
  Chat,
  Add,
  Edit,
  TrashCan,
  Play,
  Help,
  ChevronRight,
  ChevronDown,
  Earth,
  Close,
} from '@carbon/icons-react';
import useSnippets from '../../hooks/useSnippets';
import parseSnippetQuery from './searchQuery';
import SnippetEditModal from './SnippetEditModal';
import './SnippetsPanel.scss';

const UNTAGGED_FOLDER_KEY = '__untagged__';

/**
 * Group snippets for rendering. Returns:
 *   {
 *     untagged: Snippet[],       // alpha by title
 *     folders: [{ name, items: Snippet[] }]   // alpha by folder name; items alpha by title
 *   }
 *
 * Snippets with N tags appear under N folders. No deduplication —
 * that's the point of the folder model.
 */
function groupSnippets(snippets) {
  const sorted = [...snippets].sort((a, b) =>
    String(a.title).localeCompare(String(b.title))
  );
  const untagged = [];
  const folderMap = new Map();
  for (const sn of sorted) {
    if (!Array.isArray(sn.tags) || sn.tags.length === 0) {
      untagged.push(sn);
      continue;
    }
    for (const tag of sn.tags) {
      if (!folderMap.has(tag)) folderMap.set(tag, []);
      folderMap.get(tag).push(sn);
    }
  }
  const folders = [...folderMap.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([name, items]) => ({
      name,
      items: items.sort((a, b) => String(a.title).localeCompare(String(b.title))),
    }));
  return { untagged, folders };
}

function SnippetRow({ snippet, selected, onSelect, onActivate }) {
  return (
    <div
      className={`snippet-row${selected ? ' snippet-row--selected' : ''}`}
      onClick={() => onSelect(snippet)}
      onDoubleClick={() => onActivate(snippet)}
      role="button"
      tabIndex={0}
      title={`${snippet.title}\n${snippet.command}`}
    >
      <Chat size={16} className="snippet-row__icon" />
      {snippet.scope === 'global' && (
        <Earth size={12} className="snippet-row__global-marker" title="Global snippet" />
      )}
      <span className="snippet-row__title">{snippet.title}</span>
    </div>
  );
}

function SearchHelpPopover({ open, onClose }) {
  if (!open) return null;
  return (
    <Popover open caret={false} align="bottom-right" onRequestClose={onClose}>
      <PopoverContent className="snippets-search-help">
        <p>Terms match across title, command, and tags. Operators:</p>
        <ul>
          <li><code>title:foo</code> — match only the title</li>
          <li><code>text:foo</code> — match only the command</li>
          <li><code>tag:foo</code> — match only tags</li>
          <li><code>-foo</code> — exclude snippets containing &quot;foo&quot;</li>
          <li><code>foo|bar</code> — OR (binds tighter than AND)</li>
        </ul>
        <p>Example: <code>tag:network -production</code>.</p>
      </PopoverContent>
    </Popover>
  );
}

/**
 * SnippetsPanel — generic iTerm2-style saved-commands library.
 *
 * Props:
 *   - context: string (required) — host surface key, e.g. "edgelake-terminal"
 *   - canCreateGlobal: bool — usually `user.can_manage`
 *   - onPaste: (command: string) => void — single-click handler
 *   - onActivate: (command: string) => void — double-click handler (paste + submit)
 *   - getPrefillCommand: () => string — called when the user clicks "+"
 *     to seed the modal. Host returns its current input field value or
 *     the last successful command (whichever the host prefers).
 *   - onRequestClose: () => void — called when the user clicks the
 *     panel's own close button. Host owns the open/close state.
 */
export default function SnippetsPanel({
  context,
  canCreateGlobal = false,
  onPaste,
  onActivate,
  getPrefillCommand,
  onRequestClose,
}) {
  const { snippets, loading, error, create, update, remove } = useSnippets(context);
  const [query, setQuery] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState(() => new Set());
  const [selectedId, setSelectedId] = useState(null);
  const [modalMode, setModalMode] = useState(null); // null | "add" | "edit"
  const [modalInitial, setModalInitial] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(false);

  const helpButtonRef = useRef(null);

  const predicate = useMemo(() => parseSnippetQuery(query), [query]);
  const filtered = useMemo(() => snippets.filter(predicate), [snippets, predicate]);
  const grouped = useMemo(() => groupSnippets(filtered), [filtered]);

  const selected = useMemo(
    () => snippets.find((s) => s.id === selectedId) || null,
    [snippets, selectedId]
  );

  const toggleFolder = (name) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleSelect = (sn) => {
    setSelectedId(sn.id);
    onPaste?.(sn.command);
  };

  const handleActivate = (sn) => {
    setSelectedId(sn.id);
    onActivate?.(sn.command);
  };

  const handleAddClick = () => {
    const seed = getPrefillCommand ? getPrefillCommand() : '';
    setModalInitial({
      title: '',
      command: seed,
      tags: [],
      scope: 'user',
    });
    setModalMode('add');
  };

  const handleEditClick = () => {
    if (!selected) return;
    setModalInitial({
      title: selected.title,
      command: selected.command,
      tags: selected.tags || [],
      scope: selected.scope,
    });
    setModalMode('edit');
  };

  const handleDeleteClick = async () => {
    if (!selected || pendingDelete) return;
    const confirmed = window.confirm(
      `Delete snippet "${selected.title}"? This cannot be undone.`
    );
    if (!confirmed) return;
    setPendingDelete(true);
    try {
      await remove(selected.id);
      setSelectedId(null);
    } finally {
      setPendingDelete(false);
    }
  };

  const handleRunClick = () => {
    if (selected) onActivate?.(selected.command);
  };

  const handleModalSave = async (payload) => {
    if (modalMode === 'add') {
      await create(payload);
    } else if (modalMode === 'edit' && selected) {
      await update(selected.id, payload);
    }
    setModalMode(null);
    setModalInitial(null);
  };

  // Footer button disable state: selection-based, plus permission gate
  // for global edits.
  const editAndDeleteEnabled = selected ? selected.can_edit : false;
  const runEnabled = !!selected;

  return (
    <div className="snippets-panel">
      <div className="snippets-panel__header">
        <span className="snippets-panel__title">Snippets</span>
        {onRequestClose && (
          <IconButton
            kind="ghost"
            size="sm"
            label="Hide snippets"
            onClick={onRequestClose}
          >
            <Close />
          </IconButton>
        )}
      </div>

      <div className="snippets-panel__search-row">
        <Search
          id="snippets-panel-search"
          size="sm"
          labelText=""
          placeholder="Search snippets…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery('')}
        />
        <div className="snippets-panel__help-wrap" ref={helpButtonRef}>
          <IconButton
            kind="ghost"
            size="sm"
            label="Search help"
            onClick={() => setHelpOpen((o) => !o)}
          >
            <Help />
          </IconButton>
          <SearchHelpPopover open={helpOpen} onClose={() => setHelpOpen(false)} />
        </div>
      </div>

      <div className="snippets-panel__list">
        {loading && (
          <div className="snippets-panel__loading">
            <InlineLoading description="Loading…" />
          </div>
        )}
        {error && (
          <div className="snippets-panel__error" title={error}>
            Failed to load snippets.
          </div>
        )}
        {!loading && !error && snippets.length === 0 && (
          <div className="snippets-panel__empty">
            No snippets yet. Click <strong>+</strong> to add one.
          </div>
        )}
        {!loading && !error && snippets.length > 0 && filtered.length === 0 && (
          <div className="snippets-panel__empty">No matches.</div>
        )}

        {grouped.untagged.length > 0 && (
          <div className="snippets-panel__group snippets-panel__group--untagged">
            {grouped.untagged.map((sn) => (
              <SnippetRow
                key={sn.id}
                snippet={sn}
                selected={sn.id === selectedId}
                onSelect={handleSelect}
                onActivate={handleActivate}
              />
            ))}
          </div>
        )}

        {grouped.folders.map((folder) => {
          const collapsed = collapsedFolders.has(folder.name);
          return (
            <div
              key={folder.name}
              className={`snippets-panel__folder${collapsed ? ' snippets-panel__folder--collapsed' : ''}`}
            >
              <button
                type="button"
                className="snippets-panel__folder-header"
                onClick={() => toggleFolder(folder.name)}
              >
                {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <span className="snippets-panel__folder-name">{folder.name}</span>
                <span className="snippets-panel__folder-count">{folder.items.length}</span>
              </button>
              {!collapsed && (
                <div className="snippets-panel__folder-items">
                  {folder.items.map((sn) => (
                    <SnippetRow
                      key={`${folder.name}:${sn.id}`}
                      snippet={sn}
                      selected={sn.id === selectedId}
                      onSelect={handleSelect}
                      onActivate={handleActivate}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="snippets-panel__footer">
        <IconButton
          kind="ghost"
          size="sm"
          label="Run selected"
          onClick={handleRunClick}
          disabled={!runEnabled}
        >
          <Play />
        </IconButton>
        <IconButton
          kind="ghost"
          size="sm"
          label="Edit selected"
          onClick={handleEditClick}
          disabled={!editAndDeleteEnabled}
        >
          <Edit />
        </IconButton>
        <div className="snippets-panel__footer-spacer" />
        <IconButton
          kind="ghost"
          size="sm"
          label="Delete selected"
          onClick={handleDeleteClick}
          disabled={!editAndDeleteEnabled || pendingDelete}
        >
          <TrashCan />
        </IconButton>
        <IconButton
          kind="ghost"
          size="sm"
          label="Add snippet"
          onClick={handleAddClick}
        >
          <Add />
        </IconButton>
      </div>

      <SnippetEditModal
        open={modalMode !== null}
        mode={modalMode}
        initial={modalInitial}
        canCreateGlobal={canCreateGlobal}
        onClose={() => {
          setModalMode(null);
          setModalInitial(null);
        }}
        onSave={handleModalSave}
      />
    </div>
  );
}
