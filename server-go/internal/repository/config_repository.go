// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package repository

import (
	"context"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// ConfigRepository handles database operations for app configuration
type ConfigRepository struct {
	collection *mongo.Collection
}

// NewConfigRepository creates a new ConfigRepository
func NewConfigRepository(db *mongo.Database) *ConfigRepository {
	return &ConfigRepository{
		collection: db.Collection("app_config"),
	}
}

// GetSystemConfig retrieves the system configuration
func (r *ConfigRepository) GetSystemConfig(ctx context.Context) (*models.AppConfig, error) {
	var config models.AppConfig
	err := r.collection.FindOne(ctx, bson.M{
		"scope": models.ConfigScopeSystem,
	}).Decode(&config)

	if err == mongo.ErrNoDocuments {
		// Return empty config if none exists
		return &models.AppConfig{
			ID:       "system",
			Scope:    models.ConfigScopeSystem,
			Settings: make(map[string]interface{}),
			Created:  time.Now(),
			Updated:  time.Now(),
		}, nil
	}

	if err != nil {
		return nil, err
	}

	return &config, nil
}

// UpsertSystemConfig updates or creates the system configuration (merges settings)
func (r *ConfigRepository) UpsertSystemConfig(ctx context.Context, settings map[string]interface{}) (*models.AppConfig, error) {
	now := time.Now()

	// Build $set for each key in settings to merge instead of replace
	setFields := bson.M{
		"updated": now,
	}
	for key, value := range settings {
		setFields["settings."+key] = value
	}

	filter := bson.M{"scope": models.ConfigScopeSystem}
	update := bson.M{
		"$set": setFields,
		"$setOnInsert": bson.M{
			"_id":     "system",
			"scope":   models.ConfigScopeSystem,
			"created": now,
		},
	}

	opts := options.FindOneAndUpdate().
		SetUpsert(true).
		SetReturnDocument(options.After)

	var config models.AppConfig
	err := r.collection.FindOneAndUpdate(ctx, filter, update, opts).Decode(&config)
	if err != nil {
		return nil, err
	}

	return &config, nil
}

// UpdateSystemConfigKey updates a single key in system configuration
func (r *ConfigRepository) UpdateSystemConfigKey(ctx context.Context, key string, value interface{}) error {
	now := time.Now()

	filter := bson.M{"scope": models.ConfigScopeSystem}
	update := bson.M{
		"$set": bson.M{
			"settings." + key: value,
			"updated":         now,
		},
		"$setOnInsert": bson.M{
			"_id":     "system",
			"scope":   models.ConfigScopeSystem,
			"created": now,
		},
	}

	opts := options.Update().SetUpsert(true)
	_, err := r.collection.UpdateOne(ctx, filter, update, opts)
	return err
}

// GetUserConfig retrieves configuration for a specific user
func (r *ConfigRepository) GetUserConfig(ctx context.Context, userID string) (*models.AppConfig, error) {
	var config models.AppConfig
	err := r.collection.FindOne(ctx, bson.M{
		"scope":   models.ConfigScopeUser,
		"user_id": userID,
	}).Decode(&config)

	if err == mongo.ErrNoDocuments {
		// Return empty config if none exists
		return &models.AppConfig{
			ID:       "user_" + userID,
			Scope:    models.ConfigScopeUser,
			UserID:   userID,
			Settings: make(map[string]interface{}),
			Created:  time.Now(),
			Updated:  time.Now(),
		}, nil
	}

	if err != nil {
		return nil, err
	}

	return &config, nil
}

// UpsertUserConfig updates or creates user configuration (merges settings)
func (r *ConfigRepository) UpsertUserConfig(ctx context.Context, userID string, settings map[string]interface{}) (*models.AppConfig, error) {
	now := time.Now()

	// Build $set for each key in settings to merge instead of replace
	setFields := bson.M{
		"updated": now,
	}
	for key, value := range settings {
		setFields["settings."+key] = value
	}

	filter := bson.M{
		"scope":   models.ConfigScopeUser,
		"user_id": userID,
	}
	update := bson.M{
		"$set": setFields,
		"$setOnInsert": bson.M{
			"_id":     "user_" + userID,
			"scope":   models.ConfigScopeUser,
			"user_id": userID,
			"created": now,
		},
	}

	opts := options.FindOneAndUpdate().
		SetUpsert(true).
		SetReturnDocument(options.After)

	var config models.AppConfig
	err := r.collection.FindOneAndUpdate(ctx, filter, update, opts).Decode(&config)
	if err != nil {
		return nil, err
	}

	return &config, nil
}

// UpdateUserConfigKey updates a single key in user configuration
func (r *ConfigRepository) UpdateUserConfigKey(ctx context.Context, userID string, key string, value interface{}) error {
	now := time.Now()

	filter := bson.M{
		"scope":   models.ConfigScopeUser,
		"user_id": userID,
	}
	update := bson.M{
		"$set": bson.M{
			"settings." + key: value,
			"updated":         now,
		},
		"$setOnInsert": bson.M{
			"_id":     "user_" + userID,
			"scope":   models.ConfigScopeUser,
			"user_id": userID,
			"created": now,
		},
	}

	opts := options.Update().SetUpsert(true)
	_, err := r.collection.UpdateOne(ctx, filter, update, opts)
	return err
}

// DeleteUserConfig removes the per-user config row, if any. Idempotent —
// returns nil when no row exists. Used by user-delete cascade.
func (r *ConfigRepository) DeleteUserConfig(ctx context.Context, userID string) error {
	filter := bson.M{
		"scope":   models.ConfigScopeUser,
		"user_id": userID,
	}
	_, err := r.collection.DeleteOne(ctx, filter)
	return err
}

// CreateIndexes creates necessary indexes for the config collection
func (r *ConfigRepository) CreateIndexes(ctx context.Context) error {
	indexes := []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "scope", Value: 1}},
			Options: options.Index(),
		},
		{
			Keys:    bson.D{{Key: "scope", Value: 1}, {Key: "user_id", Value: 1}},
			Options: options.Index().SetUnique(true).SetPartialFilterExpression(bson.M{"user_id": bson.M{"$exists": true}}),
		},
	}

	_, err := r.collection.Indexes().CreateMany(ctx, indexes)
	return err
}

// SettingsItemRepository handles database operations for individual settings
type SettingsItemRepository struct {
	collection *mongo.Collection
}

// NewSettingsItemRepository creates a new SettingsItemRepository
func NewSettingsItemRepository(db *mongo.Database) *SettingsItemRepository {
	return &SettingsItemRepository{
		collection: db.Collection("settings"),
	}
}

// GetAllSettings retrieves all configuration items
func (r *SettingsItemRepository) GetAllSettings(ctx context.Context) ([]models.ConfigItem, error) {
	cursor, err := r.collection.Find(ctx, bson.M{})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var items []models.ConfigItem
	if err := cursor.All(ctx, &items); err != nil {
		return nil, err
	}
	return items, nil
}

// GetSettingByKey retrieves a single setting by key
func (r *SettingsItemRepository) GetSettingByKey(ctx context.Context, key string) (*models.ConfigItem, error) {
	var item models.ConfigItem
	err := r.collection.FindOne(ctx, bson.M{"_id": key}).Decode(&item)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

// UpsertSetting creates or updates a setting
func (r *SettingsItemRepository) UpsertSetting(ctx context.Context, item *models.ConfigItem) error {
	now := time.Now()
	item.Updated = now

	filter := bson.M{"_id": item.ID}
	update := bson.M{
		"$set": bson.M{
			"key":         item.Key,
			"value":       item.Value,
			"category":    item.Category,
			"description": item.Description,
			"updated":     now,
		},
		"$setOnInsert": bson.M{
			"created": now,
		},
	}

	opts := options.Update().SetUpsert(true)
	_, err := r.collection.UpdateOne(ctx, filter, update, opts)
	return err
}

// UpdateSettingValue updates only the value of a setting (not hidden flag)
func (r *SettingsItemRepository) UpdateSettingValue(ctx context.Context, key string, value interface{}) error {
	now := time.Now()

	filter := bson.M{"_id": key}
	update := bson.M{
		"$set": bson.M{
			"value":   value,
			"updated": now,
		},
	}

	result, err := r.collection.UpdateOne(ctx, filter, update)
	if err != nil {
		return err
	}
	if result.MatchedCount == 0 {
		return mongo.ErrNoDocuments
	}
	return nil
}

// DeleteSetting removes a setting by key
func (r *SettingsItemRepository) DeleteSetting(ctx context.Context, key string) error {
	_, err := r.collection.DeleteOne(ctx, bson.M{"_id": key})
	return err
}

// CreateIndexes creates necessary indexes for the settings collection
func (r *SettingsItemRepository) CreateIndexes(ctx context.Context) error {
	indexes := []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "category", Value: 1}},
			Options: options.Index(),
		},
	}

	_, err := r.collection.Indexes().CreateMany(ctx, indexes)
	return err
}
