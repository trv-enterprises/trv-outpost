// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"context"
	"fmt"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
)

// OverrideLookup resolves a user's per-user Assistant budget override
// by GUID. Satisfied by *repository.UserRepository (GetByGUID). Kept as
// a narrow interface so budget.go doesn't depend on the whole user repo
// surface and stays easy to fake in tests. May be nil — then no
// per-user override is applied (global caps only).
type OverrideLookup interface {
	GetByGUID(ctx context.Context, guid string) (*models.User, error)
}

// Per-conversation context budget. Soft limit emits a banner event
// to the client + a one-shot warning inserted into the model's next
// turn; hard limit refuses to call Anthropic at all and tells the
// user to start a new conversation.
//
// These are token *approximations* — Anthropic's tokenizer isn't
// available locally, so we use a rough proxy of 4 chars/token over
// the assembled system prompt + message bodies. Off by ~10-20% in
// either direction, but plenty good enough for thresholds that
// exist to prevent total context blowup, not to be precise.
const (
	ConversationSoftLimitTokens = 50_000
	ConversationHardLimitTokens = 150_000
)

// Per-user daily token budget. Defaults; the admin can override
// via the assistant.daily_token_budget setting (Step 7 also adds
// that setting).
const (
	DefaultDailyInputBudget  = 1_000_000
	DefaultDailyOutputBudget = 250_000
)

// Budget bundles the cost-guardrail dependencies. Constructed once
// at server startup; the chat agent reads through it before each
// Anthropic API call.
//
// May be nil — when not wired (tests, opt-out), the chat agent
// behaves as it did before step 7 (no caps). main.go always wires
// it when the chat agent is enabled.
type Budget struct {
	repo           *repository.ChatUsageRepository
	users          OverrideLookup
	dailyInputCap  int64
	dailyOutputCap int64
}

// NewBudget constructs a Budget. dailyInputCap and dailyOutputCap
// of 0 mean "use the package defaults"; admins typically pass the
// values from the assistant.daily_token_budget admin setting. `users`
// resolves per-user overrides (may be nil → global caps only).
func NewBudget(repo *repository.ChatUsageRepository, users OverrideLookup, dailyInputCap, dailyOutputCap int64) *Budget {
	if dailyInputCap <= 0 {
		dailyInputCap = DefaultDailyInputBudget
	}
	if dailyOutputCap <= 0 {
		dailyOutputCap = DefaultDailyOutputBudget
	}
	return &Budget{
		repo:           repo,
		users:          users,
		dailyInputCap:  dailyInputCap,
		dailyOutputCap: dailyOutputCap,
	}
}

// effectiveCaps returns the input/output caps in force for this user
// today: the global caps, with any applicable per-user override
// substituted per axis. An override axis of 0 means "no override for
// this axis" → keep the global cap.
func (b *Budget) effectiveCaps(ctx context.Context, callerGUID string, now time.Time) (inputCap, outputCap int64) {
	inputCap, outputCap = b.dailyInputCap, b.dailyOutputCap
	if b.users == nil || callerGUID == "" {
		return
	}
	user, err := b.users.GetByGUID(ctx, callerGUID)
	if err != nil || user == nil || user.AssistantBudgetOverride == nil {
		return
	}
	ov := user.AssistantBudgetOverride
	if !ov.AppliesOn(now.UTC().Format("2006-01-02")) {
		return
	}
	if ov.Input > 0 {
		inputCap = ov.Input
	}
	if ov.Output > 0 {
		outputCap = ov.Output
	}
	return
}

// CheckResult is the verdict the budget returns before each
// Anthropic call.
//
//   - Allowed=true means proceed.
//   - Allowed=false means refuse: surface Reason to the user.
//   - SoftWarn=true is advisory; the call proceeds but the client
//     gets a banner event.
type CheckResult struct {
	Allowed  bool
	SoftWarn bool
	Reason   string

	// Per-user daily counters at the time of the check, for
	// telemetry / future client surfacing.
	DailyInputUsed  int64
	DailyInputCap   int64
	DailyOutputUsed int64
	DailyOutputCap  int64
}

// CheckBeforeCall is invoked before each Anthropic API call. It
// inspects:
//
//  1. The approximate token count of the about-to-be-sent
//     conversation (sum of system prompt length + all message
//     content length / 4).
//  2. The caller's per-day token consumption against the daily cap.
//
// Returns a verdict the agent uses to either proceed, warn, or
// refuse.
//
// callerGUID may be empty (anonymous / test calls) — in that case
// the daily-budget check is skipped and only the conversation cap
// applies.
func (b *Budget) CheckBeforeCall(ctx context.Context, callerGUID string, approxContextTokens int) (*CheckResult, error) {
	res := &CheckResult{Allowed: true}

	// Conversation-level caps.
	if approxContextTokens >= ConversationHardLimitTokens {
		res.Allowed = false
		res.Reason = fmt.Sprintf(
			"This conversation is too long (~%d tokens, cap %d). Start a new chat to continue. Use the export buttons in the chat menu if you want to keep this conversation.",
			approxContextTokens, ConversationHardLimitTokens,
		)
		return res, nil
	}
	if approxContextTokens >= ConversationSoftLimitTokens {
		res.SoftWarn = true
		res.Reason = fmt.Sprintf(
			"This conversation is getting long (~%d tokens). Consider starting a new chat soon for performance.",
			approxContextTokens,
		)
	}

	// Per-user daily cap.
	if b == nil || b.repo == nil || callerGUID == "" {
		return res, nil
	}
	now := time.Now()
	usage, err := b.repo.GetToday(ctx, callerGUID, now)
	if err != nil {
		// Don't refuse the call on a repo read failure — fall open.
		// Worst case the admin doesn't see usage; better than
		// silently denying valid requests when Mongo hiccups.
		return res, nil
	}
	if usage != nil {
		res.DailyInputUsed = usage.InputTokens
		res.DailyOutputUsed = usage.OutputTokens
	}
	// Effective caps = global caps with any applicable per-user override.
	inputCap, outputCap := b.effectiveCaps(ctx, callerGUID, now)
	res.DailyInputCap = inputCap
	res.DailyOutputCap = outputCap

	if res.DailyInputUsed >= inputCap {
		res.Allowed = false
		res.Reason = fmt.Sprintf(
			"Daily input-token budget exhausted (%d / %d). Resets at UTC midnight, or ask an admin to raise your budget on the AI API Usage page.",
			res.DailyInputUsed, inputCap,
		)
		return res, nil
	}
	if res.DailyOutputUsed >= outputCap {
		res.Allowed = false
		res.Reason = fmt.Sprintf(
			"Daily output-token budget exhausted (%d / %d). Resets at UTC midnight, or ask an admin to raise your budget on the AI API Usage page.",
			res.DailyOutputUsed, outputCap,
		)
		return res, nil
	}

	return res, nil
}

// RecordUsage adds an Anthropic response's input/output token
// counts to today's per-user counter. Called after each successful
// API response (input + output known precisely from response.Usage).
//
// Best-effort: a failure here is logged but doesn't abort the
// in-flight message. The next CheckBeforeCall reads what's there.
func (b *Budget) RecordUsage(ctx context.Context, callerGUID string, inputTokens, outputTokens int64) error {
	if b == nil || b.repo == nil || callerGUID == "" {
		return nil
	}
	return b.repo.IncrementToday(ctx, callerGUID, time.Now(), inputTokens, outputTokens)
}

// EstimateContextTokens approximates the token count of the
// per-turn prompt as system prompt length + all message bodies
// (4 chars/token rule of thumb for English JSON-flavored text).
//
// This is the simplest possible heuristic and is intentionally
// conservative — it ignores tool definitions (small) and the
// overhead per message (small). For a 200k-token-precision world
// we'd need a tokenizer; for "don't blow up the context" thresholds
// it's plenty.
func EstimateContextTokens(systemPrompt string, messageContents []string) int {
	total := len(systemPrompt)
	for _, c := range messageContents {
		total += len(c)
	}
	return total / 4
}
