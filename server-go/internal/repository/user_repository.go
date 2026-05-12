// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package repository

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// UserRepository handles user database operations
type UserRepository struct {
	collection *mongo.Collection
}

// NewUserRepository creates a new user repository
func NewUserRepository(db *mongo.Database) *UserRepository {
	return &UserRepository{
		collection: db.Collection("users"),
	}
}

// CreateIndexes creates indexes for the users collection
func (r *UserRepository) CreateIndexes(ctx context.Context) error {
	indexes := []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "guid", Value: 1}},
			Options: options.Index().SetUnique(true),
		},
		{
			Keys:    bson.D{{Key: "name", Value: 1}},
			Options: options.Index().SetUnique(true),
		},
		{
			Keys: bson.D{{Key: "active", Value: 1}},
		},
		// Auth path: GetByGUID filters on both guid and active together.
		// Compound supplements the single-field unique `guid` index for this
		// specific lookup pattern.
		{
			Keys: bson.D{{Key: "guid", Value: 1}, {Key: "active", Value: 1}},
		},
		// Clerk-linked sign-in path: FindByClerkID is the hot lookup
		// after first JIT-link. Sparse so users without a clerk_user_id
		// (everyone in non-Clerk deployments) don't create a unique-key
		// collision on empty strings.
		{
			Keys:    bson.D{{Key: "clerk_user_id", Value: 1}},
			Options: options.Index().SetUnique(true).SetSparse(true),
		},
		// Email lookup is the JIT-link path on first Clerk sign-in.
		// Sparse because email is optional on User records. NOT marked
		// unique — historical users may share an email (defensive); the
		// app layer enforces uniqueness on create when it matters.
		{
			Keys:    bson.D{{Key: "email", Value: 1}},
			Options: options.Index().SetSparse(true),
		},
	}

	_, err := r.collection.Indexes().CreateMany(ctx, indexes)
	return err
}

// Create creates a new user
func (r *UserRepository) Create(ctx context.Context, user *models.User) error {
	if user.ID == "" {
		user.ID = uuid.New().String()
	}
	if user.GUID == "" {
		user.GUID = uuid.New().String()
	}
	now := time.Now()
	user.Created = now
	user.Updated = now

	// Ensure at least VIEW capability
	hasView := false
	for _, cap := range user.Capabilities {
		if cap == models.CapabilityView {
			hasView = true
			break
		}
	}
	if !hasView {
		user.Capabilities = append([]models.Capability{models.CapabilityView}, user.Capabilities...)
	}

	_, err := r.collection.InsertOne(ctx, user)
	return err
}

// GetByID retrieves a user by ID
func (r *UserRepository) GetByID(ctx context.Context, id string) (*models.User, error) {
	var user models.User
	err := r.collection.FindOne(ctx, bson.M{"_id": id}).Decode(&user)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return nil, err
	}
	return &user, nil
}

// GetByGUID retrieves a user by GUID (for authentication)
func (r *UserRepository) GetByGUID(ctx context.Context, guid string) (*models.User, error) {
	var user models.User
	err := r.collection.FindOne(ctx, bson.M{"guid": guid, "active": true}).Decode(&user)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return nil, err
	}
	return &user, nil
}

// GetByName retrieves a user by name
func (r *UserRepository) GetByName(ctx context.Context, name string) (*models.User, error) {
	var user models.User
	err := r.collection.FindOne(ctx, bson.M{"name": name}).Decode(&user)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return nil, err
	}
	return &user, nil
}

// Update updates an existing user
func (r *UserRepository) Update(ctx context.Context, user *models.User) error {
	user.Updated = time.Now()

	result, err := r.collection.ReplaceOne(
		ctx,
		bson.M{"_id": user.ID},
		user,
	)
	if err != nil {
		return err
	}
	if result.MatchedCount == 0 {
		return errors.New("user not found")
	}
	return nil
}

// Delete deletes a user by ID
func (r *UserRepository) Delete(ctx context.Context, id string) error {
	result, err := r.collection.DeleteOne(ctx, bson.M{"_id": id})
	if err != nil {
		return err
	}
	if result.DeletedCount == 0 {
		return errors.New("user not found")
	}
	return nil
}

// List returns a paginated list of users
func (r *UserRepository) List(ctx context.Context, page, pageSize int) ([]models.User, int64, error) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 10
	}

	// Count total
	total, err := r.collection.CountDocuments(ctx, bson.M{})
	if err != nil {
		return nil, 0, err
	}

	// Find with pagination
	opts := options.Find().
		SetSkip(int64((page - 1) * pageSize)).
		SetLimit(int64(pageSize)).
		SetSort(bson.D{{Key: "name", Value: 1}})

	cursor, err := r.collection.Find(ctx, bson.M{}, opts)
	if err != nil {
		return nil, 0, err
	}
	defer cursor.Close(ctx)

	var users []models.User
	if err := cursor.All(ctx, &users); err != nil {
		return nil, 0, err
	}

	return users, total, nil
}

// ListByKind returns every user matching the given kind, no
// pagination. Used by the system-users admin page (which expects to
// show every system principal) and for the regular users list when
// the caller wants to exclude system users from the human directory.
// "" for kind matches every kind, including records that pre-date
// the field (treated as human by IsSystem).
func (r *UserRepository) ListByKind(ctx context.Context, kind models.UserKind) ([]models.User, error) {
	filter := bson.M{}
	if kind == models.UserKindSystem {
		filter = bson.M{"kind": string(kind)}
	} else if kind == models.UserKindHuman {
		// Human means: kind=="human" OR field missing. The migration
		// fixes the missing case but we don't rely on it.
		filter = bson.M{"$or": []bson.M{
			{"kind": string(models.UserKindHuman)},
			{"kind": bson.M{"$exists": false}},
		}}
	}
	cursor, err := r.collection.Find(ctx, filter, options.Find().SetSort(bson.D{{Key: "name", Value: 1}}))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var users []models.User
	if err := cursor.All(ctx, &users); err != nil {
		return nil, err
	}
	return users, nil
}

// UpsertByName creates or updates a user by name (for seeding)
func (r *UserRepository) UpsertByName(ctx context.Context, user *models.User) error {
	now := time.Now()
	user.Updated = now

	filter := bson.M{"name": user.Name}
	update := bson.M{
		"$set": bson.M{
			"guid":         user.GUID,
			"email":        user.Email,
			"capabilities": user.Capabilities,
			"active":       user.Active,
			"updated":      now,
		},
		"$setOnInsert": bson.M{
			"_id":     user.ID,
			"name":    user.Name,
			"created": now,
		},
	}

	opts := options.Update().SetUpsert(true)
	_, err := r.collection.UpdateOne(ctx, filter, update, opts)
	return err
}

// Count returns the total number of users
func (r *UserRepository) Count(ctx context.Context) (int64, error) {
	return r.collection.CountDocuments(ctx, bson.M{})
}

// FindByClerkID returns the active user whose ClerkUserID matches the
// given Clerk subject claim (`sub` from a verified JWT). Returns
// (nil, nil) when no row matches — the caller falls back to email-
// based JIT linking in that case.
func (r *UserRepository) FindByClerkID(ctx context.Context, clerkID string) (*models.User, error) {
	if clerkID == "" {
		return nil, nil
	}
	var user models.User
	err := r.collection.FindOne(ctx, bson.M{
		"clerk_user_id": clerkID,
		"active":        true,
	}).Decode(&user)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return nil, err
	}
	return &user, nil
}

// FindByEmail returns the active user whose stored email matches
// (case-insensitive). Used by the Clerk JIT-linking path on first
// sign-in. Returns (nil, nil) when no row matches.
func (r *UserRepository) FindByEmail(ctx context.Context, email string) (*models.User, error) {
	if email == "" {
		return nil, nil
	}
	// Case-insensitive exact match. The collection collation isn't
	// guaranteed to apply here, so we use a regex-anchored compare.
	// Email is short and the index is sparse; this is fast in practice.
	pattern := "^" + regexEscape(email) + "$"
	var user models.User
	err := r.collection.FindOne(ctx, bson.M{
		"email":  bson.M{"$regex": pattern, "$options": "i"},
		"active": true,
	}).Decode(&user)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return nil, err
	}
	return &user, nil
}

// SetClerkID writes the given Clerk subject onto the user record.
// Used by the JIT-linking path: when a Clerk JWT's email matches a
// User but the User has no ClerkUserID yet, we persist the link so
// future sign-ins resolve via the (more stable) ClerkUserID lookup.
// Pass "" to clear the link (admin override).
func (r *UserRepository) SetClerkID(ctx context.Context, userID, clerkID string) error {
	update := bson.M{"updated": time.Now()}
	if clerkID == "" {
		// $unset rather than $set:"" so the sparse index doesn't trip.
		_, err := r.collection.UpdateOne(
			ctx,
			bson.M{"_id": userID},
			bson.M{
				"$set":   update,
				"$unset": bson.M{"clerk_user_id": ""},
			},
		)
		return err
	}
	update["clerk_user_id"] = clerkID
	_, err := r.collection.UpdateOne(
		ctx,
		bson.M{"_id": userID},
		bson.M{"$set": update},
	)
	return err
}

// regexEscape quotes regex metacharacters for safe inclusion in a
// `$regex` filter. Lifted to package-level so we don't pay the
// allocation on every email lookup.
func regexEscape(s string) string {
	const meta = `\.+*?()[]{}|^$`
	out := make([]byte, 0, len(s)+8)
	for i := 0; i < len(s); i++ {
		c := s[i]
		for j := 0; j < len(meta); j++ {
			if c == meta[j] {
				out = append(out, '\\')
				break
			}
		}
		out = append(out, c)
	}
	return string(out)
}
