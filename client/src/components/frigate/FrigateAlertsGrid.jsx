// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import PropTypes from 'prop-types';
import { Modal, Loading, InlineNotification, Tag } from '@carbon/react';
import apiClient from '../../api/client';
import { useRegisterRefreshable } from '../../context/RefreshableComponentsContext';
import './FrigateAlertsGrid.scss';

/**
 * FrigateAlertsGrid
 *
 * Responsive thumbnail grid of unreviewed Frigate review segments.
 * Polls the backend Frigate proxy on a configurable interval. Click a
 * thumbnail to open a modal with the review clip (falls back to the
 * thumbnail itself if the clip fails).
 *
 * Data source: GET /api/frigate/:id/reviews?reviewed=0&limit=N
 * Thumbnail: GET /api/frigate/:id/review/:review_id/thumbnail
 * Clip: GET /api/frigate/:id/review/:review_id/clip
 *
 * Frigate review segment shape (relevant fields):
 *   {
 *     id: "1699999999.1234-abcdef",
 *     camera: "front_door",
 *     start_time: 1699999999.1,
 *     end_time: 1700000100.5,
 *     severity: "alert" | "detection",
 *     data: { objects: ["person"], ... },
 *     has_been_reviewed: false,
 *   }
 */
function FrigateAlertsGrid({ config, dashboardCommand, canControl = true, refreshTick = 0 }) {
  const connectionId = config?.frigate_connection_id;
  // This display self-polls Frigate's review endpoint on a timer,
  // so it benefits from the dashboard's manual refresh button.
  // Register while a connection is configured; no-op outside a
  // RefreshableComponentsProvider.
  useRegisterRefreshable(!!connectionId);
  const maxThumbnails = Math.max(1, Math.min(50, config?.max_thumbnails || 8));
  const cameraFilter = config?.default_camera || '';
  const severity = config?.alert_severity || 'alert';
  const pollIntervalMs = config?.snapshot_interval || 10000;

  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedReview, setSelectedReview] = useState(null);
  const [clipError, setClipError] = useState(false);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState(null);
  const intervalRef = useRef(null);
  const mountedRef = useRef(true);

  const fetchReviews = useMemo(() => async () => {
    if (!connectionId) return;
    try {
      const data = await apiClient.getFrigateReviews(connectionId, {
        limit: maxThumbnails,
        camera: cameraFilter || undefined,
        severity: severity || undefined,
        reviewed: 0,
      });
      if (!mountedRef.current) return;
      const list = Array.isArray(data) ? data : (data?.reviews || data?.items || []);
      setReviews(list.slice(0, maxThumbnails));
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err?.message || 'Failed to load alerts');
    }
  }, [connectionId, maxThumbnails, cameraFilter, severity]);

  // Initial load + polling loop
  useEffect(() => {
    mountedRef.current = true;
    if (!connectionId) {
      setReviews([]);
      return;
    }
    setLoading(true);
    fetchReviews().finally(() => {
      if (mountedRef.current) setLoading(false);
    });

    intervalRef.current = setInterval(fetchReviews, Math.max(2000, pollIntervalMs));
    return () => {
      mountedRef.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [connectionId, fetchReviews, pollIntervalMs]);

  // Honor the dashboard's manual refresh button. Skip the initial
  // mount (refreshTick=0) since the load above already covers it.
  useEffect(() => {
    if (!connectionId || refreshTick === 0) return;
    fetchReviews();
  }, [refreshTick, connectionId, fetchReviews]);

  const handleThumbClick = (review) => {
    setClipError(false);
    setMarkError(null);
    setSelectedReview(review);
  };

  const handleClose = () => {
    setSelectedReview(null);
    setClipError(false);
    setMarkError(null);
  };

  // Mark the currently-open review as viewed in Frigate, then optimistically
  // drop it from the local list and close the modal. If the API call fails,
  // leave the review in place and surface the error inside the modal.
  const handleMarkReviewed = async () => {
    if (!selectedReview || marking || !canControl) return;
    const id = selectedReview.id;
    setMarking(true);
    setMarkError(null);
    try {
      await apiClient.markFrigateReviewsViewed(connectionId, [id]);
      if (!mountedRef.current) return;
      // Optimistic local update so the grid reflects the change
      // immediately without waiting for the next poll.
      setReviews((prev) => prev.filter((r) => r.id !== id));
      setSelectedReview(null);
      setClipError(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setMarkError(err?.message || 'Failed to mark reviewed');
    } finally {
      if (mountedRef.current) setMarking(false);
    }
  };

  // Handle dashboard commands targeting frigate-alert
  useEffect(() => {
    if (!dashboardCommand || dashboardCommand.target !== 'frigate-alert') return;

    const { action } = dashboardCommand;

    switch (action) {
      case 'show':
      case 'show_alert':
        // Open the first (most recent) unreviewed alert
        if (reviews.length > 0 && !selectedReview) {
          setSelectedReview(reviews[0]);
          setClipError(false);
          setMarkError(null);
        }
        break;

      case 'reviewed':
      case 'dismiss':
        // Mark the currently displayed alert as reviewed. Skip when
        // the current user lacks the control capability — the server
        // would 403 the call anyway and the kiosk would see a stale
        // alert with no feedback. Better to no-op visibly.
        if (selectedReview && canControl) {
          handleMarkReviewed();
        }
        break;

      case 'next':
        // Show next alert in the list
        if (selectedReview && reviews.length > 0) {
          const currentIdx = reviews.findIndex(r => r.id === selectedReview.id);
          const nextIdx = currentIdx + 1;
          if (nextIdx < reviews.length) {
            setSelectedReview(reviews[nextIdx]);
            setClipError(false);
            setMarkError(null);
          }
        } else if (!selectedReview && reviews.length > 0) {
          setSelectedReview(reviews[0]);
        }
        break;

      case 'previous':
        // Show previous alert in the list
        if (selectedReview && reviews.length > 0) {
          const currentIdx = reviews.findIndex(r => r.id === selectedReview.id);
          const prevIdx = currentIdx - 1;
          if (prevIdx >= 0) {
            setSelectedReview(reviews[prevIdx]);
            setClipError(false);
            setMarkError(null);
          }
        }
        break;

      case 'close':
        // Close the modal without marking reviewed
        handleClose();
        break;

      default:
        break;
    }
  }, [dashboardCommand]);

  const formatTime = (epochSec) => {
    if (!epochSec) return '';
    const d = new Date(epochSec * 1000);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  if (!connectionId) {
    return (
      <div className="frigate-alerts-grid frigate-alerts-grid--empty">
        <div className="frigate-alerts-grid__message">
          No Frigate connection configured.
        </div>
      </div>
    );
  }

  return (
    <div className="frigate-alerts-grid">
      {error && (
        <InlineNotification
          kind="error"
          title="Failed to load alerts"
          subtitle={error}
          hideCloseButton
          lowContrast
          className="frigate-alerts-grid__error"
        />
      )}

      {loading && reviews.length === 0 && (
        <div className="frigate-alerts-grid__loading">
          <Loading withOverlay={false} small description="Loading alerts..." />
        </div>
      )}

      {!loading && reviews.length === 0 && !error && (
        <div className="frigate-alerts-grid__empty">
          <div className="frigate-alerts-grid__empty-title">No unreviewed alerts</div>
          <div className="frigate-alerts-grid__empty-subtitle">
            New alerts will appear here automatically.
          </div>
        </div>
      )}

      {reviews.length > 0 && (
        <div className="frigate-alerts-grid__tiles">
          {reviews.map((review) => {
            const objects = review?.data?.objects || review?.objects || [];
            const label = objects.length > 0 ? objects.join(', ') : review?.severity || 'alert';
            return (
              <button
                key={review.id}
                type="button"
                className="frigate-alerts-grid__tile"
                onClick={(e) => {
                  e.stopPropagation();
                  handleThumbClick(review);
                }}
                aria-label={`Alert on ${review.camera}: ${label}`}
              >
                <img
                  src={apiClient.getFrigateReviewThumbnailUrl(connectionId, review.id, review.camera)}
                  alt={label}
                  className="frigate-alerts-grid__thumb"
                  loading="lazy"
                  onError={(e) => {
                    // Swap broken thumbnails for a neutral placeholder so
                    // the whole grid doesn't collapse on one bad image.
                    e.currentTarget.style.visibility = 'hidden';
                  }}
                />
                <div className="frigate-alerts-grid__overlay">
                  <span className="frigate-alerts-grid__camera">{review.camera}</span>
                  <span className="frigate-alerts-grid__time">{formatTime(review.start_time)}</span>
                </div>
                {objects.length > 0 && (
                  <div className="frigate-alerts-grid__tags">
                    {objects.slice(0, 2).map((obj) => (
                      <Tag key={obj} type="red" size="sm">{obj}</Tag>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Portal the modal to <body> so its DOM node doesn't live inside
          the dashboard grid. Carbon Modal v11 renders in-place (no portal),
          which means the modal's position:fixed overlay is a child of the
          dashboard panel's flex layout. In stretch-to-fill fullscreen mode,
          this inflates the grid container's measured height and causes a
          layout shift when the modal opens/closes. */}
      {createPortal(
        <Modal
          open={!!selectedReview}
          onRequestClose={handleClose}
          onRequestSubmit={handleMarkReviewed}
          modalHeading={selectedReview ? `${selectedReview.camera} — ${formatTime(selectedReview.start_time)}` : ''}
          primaryButtonText={marking ? 'Marking…' : 'Mark Reviewed'}
          secondaryButtonText="Close"
          primaryButtonDisabled={marking || !canControl}
          size="lg"
          className="frigate-alerts-grid__modal"
        >
          {selectedReview && (() => {
            const clipUrl = apiClient.getFrigateReviewClipUrl(connectionId, selectedReview);
            const hasClip = !!clipUrl && !clipError;
            return (
              <div className="frigate-alerts-grid__player">
                {hasClip ? (
                  <video
                    key={selectedReview.id}
                    src={clipUrl}
                    controls
                    autoPlay
                    muted
                    playsInline
                    onError={() => setClipError(true)}
                    className="frigate-alerts-grid__video"
                  />
                ) : (
                  <img
                    src={apiClient.getFrigateReviewThumbnailUrl(connectionId, selectedReview.id, selectedReview.camera)}
                    alt="Review thumbnail"
                    className="frigate-alerts-grid__modal-image"
                  />
                )}
                {selectedReview?.data?.objects?.length > 0 && (
                  <div className="frigate-alerts-grid__modal-tags">
                    {selectedReview.data.objects.map((obj) => (
                      <Tag key={obj} type="red" size="md">{obj}</Tag>
                    ))}
                  </div>
                )}
                {!canControl && (
                  <InlineNotification
                    kind="info"
                    title="Read-only"
                    subtitle="Your user can view alerts but not mark them reviewed. Ask an admin to grant the control capability."
                    hideCloseButton
                    lowContrast
                    className="frigate-alerts-grid__mark-error"
                  />
                )}
                {markError && (
                  <InlineNotification
                    kind="error"
                    title="Couldn't mark as reviewed"
                    subtitle={markError}
                    hideCloseButton
                    lowContrast
                    className="frigate-alerts-grid__mark-error"
                  />
                )}
              </div>
            );
          })()}
        </Modal>,
        document.body
      )}
    </div>
  );
}

FrigateAlertsGrid.propTypes = {
  config: PropTypes.shape({
    frigate_connection_id: PropTypes.string,
    default_camera: PropTypes.string,
    alert_severity: PropTypes.string,
    max_thumbnails: PropTypes.number,
    snapshot_interval: PropTypes.number,
  }).isRequired,
  dashboardCommand: PropTypes.object, // { target, action, ... } from MQTT command topic
  canControl: PropTypes.bool,
  refreshTick: PropTypes.number,
};

export default FrigateAlertsGrid;
