// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Modal,
  TextArea,
  Button,
  Loading,
  InlineNotification,
  Tag,
  TextInput,
  Link
} from '@carbon/react';
import {
  Send,
  WatsonxAi,
  User,
  Checkmark,
  Close,
  ChartBar,
  Information
} from '@carbon/icons-react';
import DynamicComponentLoader from './DynamicComponentLoader';
import { useAISession } from '../hooks/useAISession';
import { generateChartCode } from '../utils/chartCodeGenerator';
import './AIBuilderModal.scss';

/**
 * AIBuilderModal Component
 *
 * AI-powered chart builder with:
 * - Split layout: Chat panel (left) + Preview panel (right)
 * - Real-time updates via SSE
 * - Message history with user/assistant messages
 * - Live chart preview
 * - Save/discard actions
 */
function AIBuilderModal({
  isOpen,
  onClose,
  chartId = null,
  onSave
}) {
  const [input, setInput] = useState('');
  const [chartName, setChartName] = useState('');
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saving, setSaving] = useState(false);
  const messagesEndRef = useRef(null);

  const {
    session,
    messages,
    chart,
    loading,
    sending,
    error,
    thinking,
    connected,
    startSession,
    sendMessage,
    saveSession,
    cancelSession,
    clearError
  } = useAISession(chartId);

  // Start session when modal opens
  useEffect(() => {
    if (isOpen && !session) {
      startSession();
    }
  }, [isOpen, session, startSession]);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, thinking]);

  // Update chart name from chart data
  useEffect(() => {
    if (chart?.name && !chartName) {
      setChartName(chart.name);
    }
  }, [chart?.name, chartName]);

  // Generate preview code from chart config
  // This supports ANY ECharts configuration - not limited to predefined types
  const previewCode = useMemo(() => {
    const code = generateChartCode(chart);
    // Debug: log chart state and generated code
    console.log('[AIBuilder] Chart state:', chart?.id, 'type:', chart?.chart_type, 'datasource:', chart?.connection_id);
    console.log('[AIBuilder] Data mapping:', chart?.data_mapping);
    console.log('[AIBuilder] Generated code:', code ? code.substring(0, 200) + '...' : 'null');
    return code;
  }, [chart]);

  const handleSend = useCallback(() => {
    if (input.trim() && !sending) {
      sendMessage(input);
      setInput('');
    }
  }, [input, sending, sendMessage]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSave = async () => {
    if (!chartName.trim()) return;

    setSaving(true);
    try {
      const result = await saveSession(chartName.trim());
      onSave?.(result);
      onClose();
    } catch {
      // Error is handled by the hook
    } finally {
      setSaving(false);
      setShowSaveDialog(false);
    }
  };

  const handleDiscard = async () => {
    await cancelSession();
    onClose();
  };

  const formatTimestamp = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const renderMessage = (message, index) => {
    const isUser = message.role === 'user';
    const isAssistant = message.role === 'assistant';
    const isSystem = message.role === 'system';

    return (
      <div
        key={message.id || index}
        className={`message ${isUser ? 'user' : ''} ${isAssistant ? 'assistant' : ''} ${isSystem ? 'system' : ''}`}
      >
        <div className="message-avatar">
          {isUser ? <User size={20} /> : <WatsonxAi size={20} />}
        </div>
        <div className="message-content">
          <div className="message-header">
            <span className="message-role">{isUser ? 'You' : 'AI Assistant'}</span>
            <span className="message-time">{formatTimestamp(message.timestamp)}</span>
          </div>
          <div className="message-text">{message.content}</div>
          {message.tool_calls && message.tool_calls.length > 0 && (
            <div className="tool-calls">
              {message.tool_calls.map((tool, i) => (
                <Tag key={i} type="blue" size="sm">
                  {tool.name}
                </Tag>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <Modal
      open={isOpen}
      onRequestClose={handleDiscard}
      modalHeading={
        <div className="modal-heading">
          <WatsonxAi size={24} />
          <span>{chartId ? 'Edit Chart with AI' : 'Create Chart with AI'}</span>
          {connected && <Tag type="green" size="sm">Connected</Tag>}
        </div>
      }
      primaryButtonText={saving ? 'Saving...' : 'Save Chart'}
      secondaryButtonText="Discard"
      onRequestSubmit={() => setShowSaveDialog(true)}
      onSecondarySubmit={handleDiscard}
      primaryButtonDisabled={loading || !chart}
      size="lg"
      className="ai-builder-modal"
      hasScrollingContent
    >
      <div className="ai-builder-content">
        {/* Chat Panel (Left) */}
        <div className="chat-panel">
          {/* Messages Area */}
          <div className="messages-container">
            {loading ? (
              <div className="loading-container">
                <Loading description="Starting AI session..." withOverlay={false} />
              </div>
            ) : (
              <>
                {/* Welcome message if no messages */}
                {messages.length === 0 && (
                  <div className="welcome-message">
                    <WatsonxAi size={48} />
                    <h3>Welcome to AI Chart Builder</h3>
                    <p>
                      Describe the chart you want to create, and I'll help you build it.
                      You can specify chart type, data source, styling, and more.
                    </p>
                    <div className="suggestions">
                      <p className="suggestions-label">Try saying:</p>
                      <ul>
                        <li>"Create a bar chart showing sales by region"</li>
                        <li>"Make a line chart for temperature over time"</li>
                        <li>"Show a pie chart of market share"</li>
                      </ul>
                    </div>
                  </div>
                )}

                {/* Message history */}
                {messages.map(renderMessage)}

                {/* Thinking indicator */}
                {thinking && (
                  <div className="message assistant thinking">
                    <div className="message-avatar">
                      <WatsonxAi size={20} />
                    </div>
                    <div className="message-content">
                      <div className="thinking-indicator">
                        <span></span>
                        <span></span>
                        <span></span>
                      </div>
                    </div>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* Error notification */}
          {error && (
            <InlineNotification
              kind="error"
              title="Error"
              subtitle={error}
              onCloseButtonClick={clearError}
              lowContrast
            />
          )}

          {/* Input Area */}
          <div className="input-area">
            <TextArea
              id="ai-input"
              labelText=""
              placeholder="Describe what you want to create or modify..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading || sending}
              rows={2}
            />
            <Button
              kind="primary"
              size="md"
              renderIcon={Send}
              onClick={handleSend}
              disabled={!input.trim() || loading || sending}
              hasIconOnly
              iconDescription="Send message"
            />
          </div>

          {/* ECharts reference link */}
          <div className="echarts-link">
            <Information size={16} />
            <span>Browse </span>
            <Link
              href="https://echarts.apache.org/examples/en/index.html"
              target="_blank"
              rel="noopener noreferrer"
            >
              ECharts Examples
            </Link>
            <span> for inspiration</span>
          </div>
        </div>

        {/* Preview Panel (Right) */}
        <div className="preview-panel">
          <div className="preview-header">
            <ChartBar size={20} />
            <h4>Live Preview</h4>
          </div>

          <div className="preview-content">
            {previewCode ? (
              <DynamicComponentLoader
                code={previewCode}
                props={{}}
              />
            ) : (
              <div className="preview-placeholder">
                <ChartBar size={48} />
                <p>Chart preview will appear here</p>
              </div>
            )}
          </div>

          {/* Chart Info */}
          {chart && (
            <div className="chart-info">
              <div className="info-row">
                <span className="label">Name:</span>
                <span className="value">{chart.name || 'Untitled'}</span>
              </div>
              {chart.chart_type && (
                <div className="info-row">
                  <span className="label">Type:</span>
                  <Tag type="blue" size="sm">{chart.chart_type.toUpperCase()}</Tag>
                </div>
              )}
              {chart.connection_id && (
                <div className="info-row">
                  <span className="label">Data Source:</span>
                  <span className="value">{chart.connection_id}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Save Dialog */}
      {showSaveDialog && (
        <Modal
          open={true}
          onRequestClose={() => setShowSaveDialog(false)}
          onRequestSubmit={handleSave}
          modalHeading="Save Chart"
          primaryButtonText={saving ? 'Saving...' : 'Save'}
          secondaryButtonText="Cancel"
          primaryButtonDisabled={!chartName.trim() || saving}
          size="sm"
        >
          <TextInput
            id="chart-name"
            labelText="Chart Name"
            placeholder="Enter a name for your chart"
            value={chartName}
            onChange={(e) => setChartName(e.target.value)}
            invalid={chartName.toLowerCase().startsWith('untitled')}
            invalidText="Please provide a proper name for the chart"
          />
          <p className="save-dialog-note">
            This will save your chart and make it available in the charts library.
          </p>
        </Modal>
      )}
    </Modal>
  );
}

export default AIBuilderModal;
