// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Button,
  TextArea,
  Loading,
  InlineNotification,
  Tag,
  TextInput,
  Modal,
  Link
} from '@carbon/react';
import {
  ArrowLeft,
  Send,
  User,
  Save,
  Close,
  Information
} from '@carbon/icons-react';
import AiIcon from '../components/icons/AiIcon';
import AIComponentPreview from '../components/AIComponentPreview';
import { useAISession } from '../hooks/useAISession';
import apiClient from '../api/client';
import './AIBuilderPage.scss';

/**
 * AIBuilderPage Component
 *
 * Full-page AI builder for creating and editing charts with AI assistance.
 * Features:
 * - Split layout: Chat panel (left) + Preview panel (right)
 * - Real-time updates via SSE
 * - Message history with user/assistant messages
 * - Live chart preview
 * - Save/discard actions
 *
 * Routes:
 * - /design/components/ai/new - Create new chart with AI
 * - /design/components/ai/:chartId - Edit existing chart with AI
 */
function AIBuilderPage() {
  const { chartId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isNewChart = chartId === 'new';

  // Extract pre-flight context from location.state
  const preflightContext = location.state || {};
  const {
    componentType,
    name: preflightName,
    description: preflightDescription,
    connectionId,
    connectionName,
    connectionType,
    chartType,
    controlType,
    dashboardId: _dashboardId,
    panelId
  } = preflightContext;

  // Determine return path - either from state (if coming from dashboard) or default to charts list
  const returnPath = preflightContext.from || '/design/components';

  const [input, setInput] = useState('');
  const [componentName, setComponentName] = useState(preflightName || '');
  const [componentNameInitialized, setComponentNameInitialized] = useState(!!preflightName);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const [saving, setSaving] = useState(false);
  const [initialMessageSent, setInitialMessageSent] = useState(false);
  const messagesEndRef = useRef(null);

  const {
    session,
    messages,
    component,
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
  } = useAISession(isNewChart ? null : chartId, isNewChart ? preflightContext : {});

  // Start session when page loads
  useEffect(() => {
    if (!session) {
      startSession();
    }
  }, [session, startSession]);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, thinking]);

  // Update component name from component data (only initialize once)
  useEffect(() => {
    if (component?.name && !componentNameInitialized) {
      setComponentName(component.name);
      setComponentNameInitialized(true);
    }
  }, [component?.name, componentNameInitialized]);

  // Send initial message based on pre-flight context
  useEffect(() => {
    if (session && connected && !initialMessageSent && isNewChart && componentType) {
      setInitialMessageSent(true);

      // Build initial message from pre-flight context
      const parts = [];

      // Component type label
      const typeLabels = { chart: 'chart', display: 'display', control: 'control' };
      const typeLabel = typeLabels[componentType] || 'component';
      parts.push(`Create a new ${typeLabel}`);

      // Specific sub-type
      if (componentType === 'chart' && chartType) {
        parts.push(`of type "${chartType}"`);
      } else if (componentType === 'control' && controlType) {
        parts.push(`of type "${controlType}"`);
      }

      // Name
      if (preflightName) {
        parts.push(`named "${preflightName}"`);
      }

      // Description
      if (preflightDescription) {
        parts.push(`that ${preflightDescription}`);
      }

      // Connection - include name and type so agent can skip list_datasources
      if (connectionId) {
        let connDesc = `using connection ID "${connectionId}"`;
        if (connectionName) {
          connDesc += ` (name: "${connectionName}", type: ${connectionType})`;
        }
        parts.push(connDesc);
      }

      const initialMessage = parts.join(' ') + '.';
      sendMessage(initialMessage);
    }
  }, [session, connected, initialMessageSent, isNewChart, componentType, chartType, controlType, preflightName, preflightDescription, connectionId, sendMessage]);

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
    if (!componentName.trim()) return;

    setSaving(true);
    try {
      const savedComponent = await saveSession(componentName.trim());
      // If launched from a dashboard panel, pass back the component ID so
      // the dashboard page can attach it to the panel in its unsaved state
      if (panelId && savedComponent?.id) {
        navigate(returnPath, {
          state: { attachComponentId: savedComponent.id, attachPanelId: panelId }
        });
      } else {
        navigate(returnPath);
      }
    } catch {
      // Error is handled by the hook
    } finally {
      setSaving(false);
      setShowSaveDialog(false);
    }
  };

  const handleDiscard = async () => {
    // For existing charts being edited, we need to delete the draft
    // Strategy: Delete draft by chart ID FIRST (catches orphaned drafts from previous sessions),
    // THEN cancel the current session (cleans up session state in Redis)

    // First, try to delete draft directly by chart ID
    // This catches orphaned drafts from previous sessions that weren't properly cleaned up
    if (!isNewChart && chartId) {
      try {
        await apiClient.deleteComponentDraft(chartId);
      } catch {
        // 404 is expected if no draft exists - ignore silently
      }
    }

    // Then cancel the current session (cleans up session in Redis, notifies WebSocket)
    // Note: This may also try to delete the draft, but it will be a no-op if already deleted
    await cancelSession();

    navigate(returnPath);
  };

  const handleBack = () => {
    if (messages.length > 0 || component) {
      setShowDiscardDialog(true);
    } else {
      navigate(returnPath);
    }
  };

  const formatTimestamp = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const renderMessage = (message, index) => {
    // Guard against undefined messages
    if (!message) return null;

    const isUser = message.role === 'user';
    const isAssistant = message.role === 'assistant';
    const isSystem = message.role === 'system';

    return (
      <div
        key={message.id || index}
        className={`message ${isUser ? 'user' : ''} ${isAssistant ? 'assistant' : ''} ${isSystem ? 'system' : ''}`}
      >
        <div className="message-avatar">
          {isUser ? <User size={20} /> : <AiIcon size={20} />}
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
    <div className="ai-builder-page">
      {/* Page Header */}
      <div className="page-header-bar">
        <div className="header-left">
          <Button
            kind="ghost"
            renderIcon={ArrowLeft}
            onClick={handleBack}
            size="md"
          >
            Back
          </Button>
          <h1>
            <AiIcon size={24} />
            {isNewChart
              ? `Create ${componentType === 'control' ? 'Control' : componentType === 'display' ? 'Display' : componentType === 'chart' ? 'Chart' : 'Component'} with AI`
              : 'Edit Component with AI'}
          </h1>
          {connected && <Tag type="green" size="sm">Connected</Tag>}
        </div>
        <div className="header-actions">
          <Button
            kind="secondary"
            renderIcon={Close}
            onClick={handleBack}
            size="md"
          >
            Cancel
          </Button>
          <Button
            kind="primary"
            renderIcon={Save}
            onClick={() => setShowSaveDialog(true)}
            disabled={loading || !component}
            size="md"
          >
            Save Component
          </Button>
        </div>
      </div>

      {/* Main Content */}
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
                    <AiIcon size={48} />
                    <h3>Welcome to AI Component Builder</h3>
                    <p>
                      Describe the component you want to create, and I'll help you build it.
                      I can create charts, displays, and controls.
                    </p>
                    <div className="suggestions">
                      <p className="suggestions-label">Try one of these:</p>
                      <div className="suggestion-buttons">
                        <button
                          className="suggestion-btn"
                          onClick={() => setInput('Create a bar chart showing sales by region')}
                        >
                          Bar chart for sales
                        </button>
                        <button
                          className="suggestion-btn"
                          onClick={() => setInput('Make a line chart for temperature over time')}
                        >
                          Line chart for temperature
                        </button>
                        <button
                          className="suggestion-btn"
                          onClick={() => setInput('Create a toggle control to turn a device on/off via MQTT')}
                        >
                          Toggle control for MQTT
                        </button>
                        <button
                          className="suggestion-btn"
                          onClick={() => setInput('Create a slider to set brightness level')}
                        >
                          Dimmer slider control
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Message history */}
                {messages.map(renderMessage)}

                {/* Thinking indicator */}
                {thinking && (
                  <div className="message assistant thinking">
                    <div className="message-avatar">
                      <AiIcon size={20} />
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
              rows={3}
            />
            <Button
              kind="primary"
              size="lg"
              renderIcon={Send}
              onClick={handleSend}
              disabled={!input.trim() || loading || sending}
            >
              Send
            </Button>
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
          <AIComponentPreview
            component={component}
            onNameChange={(newName) => setComponentName(newName)}
          />
        </div>
      </div>

      {/* Save Dialog */}
      {showSaveDialog && (
        <Modal
          open={true}
          onRequestClose={() => setShowSaveDialog(false)}
          onRequestSubmit={handleSave}
          modalHeading="Save Component"
          primaryButtonText={saving ? 'Saving...' : 'Save'}
          secondaryButtonText="Cancel"
          primaryButtonDisabled={!componentName.trim() || componentName.toLowerCase().startsWith('untitled') || saving}
          size="sm"
        >
          <TextInput
            id="component-name"
            labelText="Component Name"
            placeholder="Enter a name for your component"
            value={componentName}
            onChange={(e) => setComponentName(e.target.value)}
            invalid={componentName.toLowerCase().startsWith('untitled')}
            invalidText="Please provide a proper name for the component"
          />
          <p className="save-dialog-note">
            This will save your component and make it available in the components library.
          </p>
        </Modal>
      )}

      {/* Discard Dialog */}
      {showDiscardDialog && (
        <Modal
          open={true}
          onRequestClose={() => setShowDiscardDialog(false)}
          onRequestSubmit={handleDiscard}
          modalHeading="Discard Changes?"
          primaryButtonText="Discard"
          secondaryButtonText="Keep Editing"
          danger
          size="sm"
        >
          <p>
            You have unsaved changes. Are you sure you want to discard them?
            This action cannot be undone.
          </p>
        </Modal>
      )}
    </div>
  );
}

export default AIBuilderPage;
