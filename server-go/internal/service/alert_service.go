// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
)

// alertRetention is how long a persisted alert lives before the
// MongoDB TTL index deletes it. 30 days is enough for a vacation
// plus a week to catch up. Pinned alerts are also subject to TTL —
// pinning is "stay visible," not "keep forever." If you actually
// want forever-keep, we'd need a separate flag (deliberate).
const alertRetention = 30 * 24 * time.Hour

// AlertService wraps the alert repo with the small amount of
// policy the handlers need — generating IDs, stamping timestamps,
// and computing ExpiresAt. Handlers stay agnostic of those concerns.
type AlertService struct {
	repo *repository.AlertRepository
}

// NewAlertService wires the service to its repo.
func NewAlertService(repo *repository.AlertRepository) *AlertService {
	return &AlertService{repo: repo}
}

// Record persists a freshly-received alert. The caller (the webhook
// handler today) provides the source-level fields; we fill in the
// ID, ReceivedAt, and ExpiresAt. Returns the persisted record so
// the producer can include the canonical ID when fanning the event
// out via the event hub.
func (s *AlertService) Record(ctx context.Context, a *models.Alert) (*models.Alert, error) {
	if a == nil {
		return nil, errors.New("alert is required")
	}
	if a.ID == "" {
		a.ID = uuid.NewString()
	}
	now := time.Now()
	if a.ReceivedAt.IsZero() {
		a.ReceivedAt = now
	}
	if a.FiredAt.IsZero() {
		a.FiredAt = a.ReceivedAt
	}
	if a.ExpiresAt.IsZero() {
		a.ExpiresAt = a.ReceivedAt.Add(alertRetention)
	}
	if err := s.repo.Insert(ctx, a); err != nil {
		return nil, err
	}
	return a, nil
}

// ListVisible returns the alerts the bell should currently render.
func (s *AlertService) ListVisible(ctx context.Context) (*models.AlertListResponse, error) {
	alerts, visible, err := s.repo.ListVisible(ctx, 0)
	if err != nil {
		return nil, err
	}
	return &models.AlertListResponse{
		Alerts:  alerts,
		Total:   int64(len(alerts)),
		Visible: visible,
	}, nil
}

// MarkSeen flips Seen=true. Idempotent.
func (s *AlertService) MarkSeen(ctx context.Context, alertID, userGUID string) error {
	return s.repo.MarkSeen(ctx, alertID, userGUID)
}

// Pin marks the alert pinned (and unseen, so it reappears on every
// bell). Idempotent.
func (s *AlertService) Pin(ctx context.Context, alertID, userGUID string) error {
	return s.repo.Pin(ctx, alertID, userGUID)
}

// Unpin clears the pin. Idempotent.
func (s *AlertService) Unpin(ctx context.Context, alertID string) error {
	return s.repo.Unpin(ctx, alertID)
}
