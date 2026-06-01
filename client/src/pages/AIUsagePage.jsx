// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useCallback } from 'react';
import {
  Loading,
  InlineNotification,
  Button,
  Modal,
  NumberInput,
  RadioButtonGroup,
  RadioButton,
  Tag,
  Tile,
  StructuredListWrapper,
  StructuredListHead,
  StructuredListBody,
  StructuredListRow,
  StructuredListCell,
} from '@carbon/react';
import { Edit, Reset } from '@carbon/icons-react';
import apiClient from '../api/client';
import './AIUsagePage.scss';

// Compact token formatter: 1234567 → "1.23M", 12345 → "12.3K".
function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

function pct(used, cap) {
  if (!cap) return 0;
  return Math.min(100, Math.round((used / cap) * 100));
}

// One axis (input/output) usage bar.
function UsageBar({ label, used, cap }) {
  const p = pct(used, cap);
  const danger = p >= 100;
  const warn = !danger && p >= 80;
  const color = danger ? 'var(--cds-support-error)' : warn ? 'var(--cds-support-warning)' : 'var(--cds-support-success)';
  return (
    <div className="usage-axis">
      <div className="usage-axis__label">
        <span>{label}</span>
        <span className="usage-axis__nums">{fmtTokens(used)} / {fmtTokens(cap)} ({p}%)</span>
      </div>
      <div className="usage-axis__track">
        <div className="usage-axis__fill" style={{ width: `${p}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

function AIUsagePage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null); // guid whose history is open

  // Extend modal state
  const [editUser, setEditUser] = useState(null);
  const [editInput, setEditInput] = useState(0);
  const [editOutput, setEditOutput] = useState(0);
  const [editScope, setEditScope] = useState('today');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.getAIUsage();
      setData(res);
    } catch (err) {
      setError(err.message || 'Failed to load usage');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openExtend = (u) => {
    setEditUser(u);
    // Seed from existing override, else the effective caps.
    setEditInput(u.override?.input || u.effective_input_cap || 0);
    setEditOutput(u.override?.output || u.effective_output_cap || 0);
    setEditScope(u.override?.scope || 'today');
  };

  const closeExtend = () => { setEditUser(null); setSaving(false); };

  const saveExtend = async () => {
    if (!editUser) return;
    setSaving(true);
    try {
      await apiClient.setAIBudgetOverride(editUser.guid, {
        input: Number(editInput) || 0,
        output: Number(editOutput) || 0,
        scope: editScope,
      });
      await load();
      closeExtend();
    } catch (err) {
      setError(err.message || 'Failed to set override');
      setSaving(false);
    }
  };

  const clearOverride = async (u) => {
    try {
      await apiClient.setAIBudgetOverride(u.guid, { clear: true });
      await load();
    } catch (err) {
      setError(err.message || 'Failed to clear override');
    }
  };

  if (loading) {
    return <div className="ai-usage-page"><Loading description="Loading AI usage..." withOverlay={false} /></div>;
  }

  return (
    <div className="ai-usage-page">
      <div className="page-header">
        <h1>AI API Usage</h1>
        <Button kind="ghost" size="sm" renderIcon={Reset} onClick={load}>Refresh</Button>
      </div>

      {data?.metered_note && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Dashboard Assistant only"
          subtitle={data.metered_note}
          style={{ maxWidth: '100%', marginBottom: '1rem' }}
        />
      )}

      {error && (
        <InlineNotification
          kind="error"
          lowContrast
          title="Error"
          subtitle={error}
          onCloseButtonClick={() => setError(null)}
          style={{ maxWidth: '100%', marginBottom: '1rem' }}
        />
      )}

      <p className="caps-note">
        Global daily caps: {fmtTokens(data?.global_input_cap)} input / {fmtTokens(data?.global_output_cap)} output per user.
        Resets at UTC midnight. History shows the last {data?.history_days} days.
      </p>

      <div className="user-cards">
        {(data?.users || []).map((u) => {
          const hasOverride = !!u.override;
          const isOpen = expanded === u.guid;
          return (
            <Tile key={u.guid} className="user-card">
              <div className="user-card__head">
                <div className="user-card__name">
                  {u.name || u.guid}
                  {hasOverride && (
                    <Tag type="purple" size="sm" title={`Override: ${u.override.scope}`}>
                      override · {u.override.scope}
                    </Tag>
                  )}
                </div>
                <div className="user-card__actions">
                  <Button kind="tertiary" size="sm" renderIcon={Edit} onClick={() => openExtend(u)}>
                    {hasOverride ? 'Adjust budget' : 'Extend budget'}
                  </Button>
                  {hasOverride && (
                    <Button kind="ghost" size="sm" onClick={() => clearOverride(u)}>Clear</Button>
                  )}
                </div>
              </div>

              <UsageBar label="Input (today)" used={u.today_input} cap={u.effective_input_cap} />
              <UsageBar label="Output (today)" used={u.today_output} cap={u.effective_output_cap} />

              <Button
                kind="ghost"
                size="sm"
                onClick={() => setExpanded(isOpen ? null : u.guid)}
                className="history-toggle"
              >
                {isOpen ? 'Hide history' : `Show ${data?.history_days}-day history`}
              </Button>

              {isOpen && (
                <StructuredListWrapper isCondensed className="history-list">
                  <StructuredListHead>
                    <StructuredListRow head>
                      <StructuredListCell head>Date (UTC)</StructuredListCell>
                      <StructuredListCell head>Input</StructuredListCell>
                      <StructuredListCell head>Output</StructuredListCell>
                    </StructuredListRow>
                  </StructuredListHead>
                  <StructuredListBody>
                    {(u.history || []).length === 0 ? (
                      <StructuredListRow>
                        <StructuredListCell>No usage in the last {data?.history_days} days</StructuredListCell>
                        <StructuredListCell>—</StructuredListCell>
                        <StructuredListCell>—</StructuredListCell>
                      </StructuredListRow>
                    ) : (
                      u.history.map((d) => (
                        <StructuredListRow key={d.date_utc}>
                          <StructuredListCell>{d.date_utc}</StructuredListCell>
                          <StructuredListCell>{fmtTokens(d.input_tokens)}</StructuredListCell>
                          <StructuredListCell>{fmtTokens(d.output_tokens)}</StructuredListCell>
                        </StructuredListRow>
                      ))
                    )}
                  </StructuredListBody>
                </StructuredListWrapper>
              )}
            </Tile>
          );
        })}
        {(data?.users || []).length === 0 && (
          <p className="empty">No users found.</p>
        )}
      </div>

      {editUser && (
        <Modal
          open
          modalHeading={`Budget override — ${editUser.name || editUser.guid}`}
          primaryButtonText={saving ? 'Saving…' : 'Save'}
          secondaryButtonText="Cancel"
          primaryButtonDisabled={saving || ((Number(editInput) || 0) <= 0 && (Number(editOutput) || 0) <= 0)}
          onRequestClose={closeExtend}
          onRequestSubmit={saveExtend}
          size="sm"
        >
          <p className="modal-note">
            Raise this user&apos;s daily caps above the global default. Set an axis to 0 to leave it at the global cap.
          </p>
          <NumberInput
            id="ov-input"
            label="Daily input-token cap"
            min={0}
            step={50000}
            value={editInput}
            onChange={(e, { value }) => setEditInput(value ?? e?.target?.value ?? 0)}
          />
          <div style={{ height: '1rem' }} />
          <NumberInput
            id="ov-output"
            label="Daily output-token cap"
            min={0}
            step={10000}
            value={editOutput}
            onChange={(e, { value }) => setEditOutput(value ?? e?.target?.value ?? 0)}
          />
          <div style={{ height: '1rem' }} />
          <RadioButtonGroup
            legendText="Scope"
            name="ov-scope"
            valueSelected={editScope}
            onChange={(v) => setEditScope(v)}
            orientation="vertical"
          >
            <RadioButton labelText="Today only (clears at UTC midnight)" value="today" id="scope-today" />
            <RadioButton labelText="Ongoing (until changed/cleared)" value="ongoing" id="scope-ongoing" />
          </RadioButtonGroup>
        </Modal>
      )}
    </div>
  );
}

export default AIUsagePage;
