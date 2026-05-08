// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useCallback } from 'react';
import {
  Button,
  InlineLoading,
  InlineNotification,
  Tag,
  Checkbox,
  TextInput,
} from '@carbon/react';
import { Renew, Add, TrashCan } from '@carbon/icons-react';
import api from '../api/client';
import './MQTTTopicSelector.scss';

/**
 * MQTTTopicSelector - Visual MQTT topic selector for chart editor
 *
 * Discovers available topics from the broker and lets the user
 * select one or more topics. Selected topics are joined with commas
 * and passed to onQueryChange as the query raw string.
 */
function MQTTTopicSelector({ connectionId, onQueryChange, initialQuery = '#', singleSelect = false }) {
  const [topics, setTopics] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedTopics, setSelectedTopics] = useState(() => {
    if (!initialQuery || initialQuery === '#') return [];
    return initialQuery.split(',').map(t => t.trim()).filter(Boolean);
  });
  const [customTopic, setCustomTopic] = useState('');

  const fetchTopics = useCallback(async () => {
    if (!connectionId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getMQTTTopics(connectionId);
      setTopics(result.topics || []);
    } catch (err) {
      setError(err.message || 'Failed to discover topics');
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    fetchTopics();
  }, [fetchTopics]);

  // Update parent whenever selection changes
  useEffect(() => {
    if (selectedTopics.length === 0) {
      onQueryChange('#');
    } else {
      onQueryChange(selectedTopics.join(','));
    }
  }, [selectedTopics, onQueryChange]);

  const toggleTopic = (topic) => {
    setSelectedTopics(prev => {
      if (singleSelect) {
        // Single select: toggle off if already selected, otherwise replace
        return prev.includes(topic) ? [] : [topic];
      }
      if (prev.includes(topic)) {
        return prev.filter(t => t !== topic);
      }
      return [...prev, topic];
    });
  };

  const addCustomTopic = () => {
    const trimmed = customTopic.trim();
    if (trimmed && !selectedTopics.includes(trimmed)) {
      setSelectedTopics(singleSelect ? [trimmed] : prev => [...prev, trimmed]);
      setCustomTopic('');
    }
  };

  const removeTopic = (topic) => {
    setSelectedTopics(prev => prev.filter(t => t !== topic));
  };

  // Group topics by first segment for easier browsing
  const topicGroups = {};
  topics.forEach(topic => {
    const firstSegment = topic.split('/')[0];
    if (!topicGroups[firstSegment]) {
      topicGroups[firstSegment] = [];
    }
    topicGroups[firstSegment].push(topic);
  });

  return (
    <div className="mqtt-topic-selector">
      <div className="mqtt-topic-selector__header">
        <h4>MQTT Topics</h4>
        <Button
          kind="ghost"
          size="sm"
          renderIcon={Renew}
          onClick={fetchTopics}
          disabled={loading}
          hasIconOnly
          iconDescription="Refresh topics"
          tooltipPosition="left"
        />
      </div>

      {/* Selected topics */}
      <div className="mqtt-topic-selector__selected">
        <span className="label">Subscribed topics:</span>
        {selectedTopics.length === 0 ? (
          <Tag type="gray" size="sm"># (all topics)</Tag>
        ) : (
          <div className="selected-tags">
            {selectedTopics.map(topic => (
              <Tag
                key={topic}
                type="blue"
                size="sm"
                filter
                onClose={() => removeTopic(topic)}
              >
                {topic}
              </Tag>
            ))}
          </div>
        )}
      </div>

      {/* Custom topic input */}
      <div className="mqtt-topic-selector__custom">
        <TextInput
          id="mqtt-custom-topic"
          size="sm"
          labelText=""
          placeholder="Enter topic or pattern (e.g. sensors/+/temperature)"
          value={customTopic}
          onChange={(e) => setCustomTopic(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addCustomTopic();
            }
          }}
        />
        <Button
          kind="ghost"
          size="sm"
          renderIcon={Add}
          onClick={addCustomTopic}
          disabled={!customTopic.trim()}
          hasIconOnly
          iconDescription="Add topic"
        />
      </div>

      <p className="mqtt-topic-selector__hint">
        Wildcards: <code>+</code> matches one level, <code>#</code> matches all remaining levels
      </p>

      {/* Topic discovery results */}
      {loading && (
        <InlineLoading description="Discovering topics from broker (3s)..." />
      )}

      {error && (
        <InlineNotification
          kind="error"
          title="Discovery failed"
          subtitle={error}
          lowContrast
          hideCloseButton
        />
      )}

      {!loading && topics.length > 0 && (
        <div className="mqtt-topic-selector__list">
          <span className="label">Available topics ({topics.length}):</span>
          {Object.entries(topicGroups).map(([group, groupTopics]) => (
            <div key={group} className="topic-group">
              {Object.keys(topicGroups).length > 1 && (
                <span className="topic-group__label">{group}/</span>
              )}
              {groupTopics.map(topic => (
                <Checkbox
                  key={topic}
                  id={`mqtt-topic-${topic.replace(/[/#+]/g, '-')}`}
                  labelText={topic}
                  checked={selectedTopics.includes(topic)}
                  onChange={() => toggleTopic(topic)}
                  className="topic-checkbox"
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {!loading && topics.length === 0 && !error && (
        <p className="mqtt-topic-selector__empty">
          No topics discovered. The broker may have no active publishers, or topics may require manual entry above.
        </p>
      )}
    </div>
  );
}

export default MQTTTopicSelector;
