// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import {
  OverflowMenu,
  OverflowMenuItem,
  Toggletip,
  ToggletipButton,
  ToggletipContent,
} from '@carbon/react';
import { Checkmark, Settings, ChevronDown, Information } from '@carbon/icons-react';
import { useNavigate } from 'react-router-dom';
import { useNamespaces } from '../context/NamespaceContext';
import { namespaceChipStyle, NAMESPACE_DEFAULT_COLOR } from '../utils/namespaceColor';
import './NamespacePicker.scss';

/**
 * NamespacePicker
 *
 * Header widget showing the active namespace as a colored chip. Click
 * to open a list of all namespaces; pick one to switch context. Bottom
 * entry jumps to /manage/namespaces for CRUD.
 *
 * The chip's color is deterministic from the namespace's `color` field,
 * so users see the same color for the same namespace everywhere in the
 * app (column chips, editor pickers, header).
 */
export default function NamespacePicker() {
  const { namespaces, activeNamespace, setActiveNamespace, getNamespace } = useNamespaces();
  const navigate = useNavigate();

  const activeRecord = getNamespace(activeNamespace);
  const activeColor = activeRecord?.color || NAMESPACE_DEFAULT_COLOR;

  return (
    <div className="namespace-picker-wrap">
      <span className="namespace-picker__divider" aria-hidden="true" />
      <Toggletip align="bottom" className="namespace-picker__info-toggletip">
        <ToggletipButton label="About the namespace picker">
          <Information size={16} className="namespace-picker__info-icon" />
        </ToggletipButton>
        <ToggletipContent>
          <p>
            The active namespace is the default namespace assigned to{' '}
            <strong>newly created</strong> dashboards, components, and
            connections. You can still pick a different namespace per record
            when you create or edit one.
          </p>
          <p>
            Switching here only affects what shows up as the default in
            create/edit forms — it doesn't filter what you can see on the
            list pages.
          </p>
        </ToggletipContent>
      </Toggletip>

      <OverflowMenu
      aria-label="Active namespace"
      iconDescription="Default Namespace"
      // The pill sits in the fixed app header at the very top of the viewport.
      // Carbon's default tooltip align is "top", which renders the
      // iconDescription tooltip ABOVE the header — off-screen / clipped, so it
      // never appears. Anchor it bottom so it shows below the pill.
      align="bottom"
      className="namespace-picker"
      menuOptionsClass="namespace-picker-menu"
      flipped
      renderIcon={() => (
        <div className="namespace-picker__trigger">
          <span className="namespace-picker__chip" style={namespaceChipStyle(activeColor)}>
            <span className="namespace-picker__chip-name">{activeNamespace}</span>
          </span>
          <ChevronDown size={14} className="namespace-picker__caret" />
        </div>
      )}
    >
      {namespaces.map((ns) => (
        <OverflowMenuItem
          key={ns.id}
          itemText={
            <span className="namespace-picker__item">
              {activeNamespace === ns.name
                ? <Checkmark size={14} />
                : <span style={{ width: 14, display: 'inline-block' }} />}
              <span
                className="namespace-picker__item-swatch"
                // Match the chip exactly: use the mapped Carbon tag-background
                // color (not the raw hex) so the dropdown reads as a true key
                // for the chips it represents.
                style={{ backgroundColor: namespaceChipStyle(ns).backgroundColor }}
              />
              <span className="namespace-picker__item-name">{ns.name}</span>
            </span>
          }
          onClick={() => setActiveNamespace(ns.name)}
        />
      ))}
      <OverflowMenuItem
        itemText={
          <span className="namespace-picker__item">
            <Settings size={14} />
            <span style={{ marginLeft: '0.5rem' }}>Manage namespaces…</span>
          </span>
        }
        hasDivider
        onClick={() => navigate('/manage/namespaces')}
      />
    </OverflowMenu>
      <span className="namespace-picker__divider" aria-hidden="true" />
    </div>
  );
}
