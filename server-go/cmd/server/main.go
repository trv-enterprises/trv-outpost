// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/config"
	"github.com/trv-enterprises/trve-dashboard/internal/ai"
	"github.com/trv-enterprises/trve-dashboard/internal/auth"
	"github.com/trv-enterprises/trve-dashboard/internal/auth/idp"
	"github.com/trv-enterprises/trve-dashboard/internal/database"
	"github.com/trv-enterprises/trve-dashboard/internal/handlers"
	"github.com/trv-enterprises/trve-dashboard/internal/hub"
	"github.com/trv-enterprises/trve-dashboard/internal/mcp"
	"github.com/trv-enterprises/trve-dashboard/internal/middleware"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
	"github.com/trv-enterprises/trve-dashboard/internal/streaming"
	"github.com/trv-enterprises/trve-dashboard/internal/version"

	swaggerFiles "github.com/swaggo/files"
	ginSwagger "github.com/swaggo/gin-swagger"

	_ "github.com/trv-enterprises/trve-dashboard/docs"       // Swagger docs
	"github.com/trv-enterprises/trve-dashboard/internal/connection" // Registers adapters via init() and exposes SetAllowInsecureTLS for deployment policy
)

// @title TRVE Dashboards API
// @version 1.0
// @description Dashboard system with AI-powered chart generation
// @contact.name Dashboard Team
// @contact.email support@example.com
// @host localhost:3001
// @BasePath /api
func main() {
	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Set Gin mode
	if cfg.Server.Mode == "release" {
		gin.SetMode(gin.ReleaseMode)
	} else {
		gin.SetMode(gin.DebugMode)
	}

	// Wire deployment-wide API adapter policy. Per-connection
	// insecure_skip_verify flags are only honored when this is true;
	// default is false (full TLS verification everywhere).
	connection.SetAllowInsecureTLS(cfg.API.AllowInsecureTLS)

	// Initialize MongoDB
	mongodb, err := database.NewMongoDB(cfg.MongoDB)
	if err != nil {
		log.Fatalf("Failed to connect to MongoDB: %v", err)
	}
	defer mongodb.Disconnect()

	// Startup context for migrations and index creation.
	// Longer timeout to accommodate one-time collation migration on first boot
	// after deploy.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// Run data migrations BEFORE creating indexes. The collation migration
	// rebuilds collections, which drops any indexes that were created on the
	// old collection; running indexes after migrations avoids wasted work and
	// ensures new indexes inherit the collection's collation.
	if err := database.RunMigrations(ctx, mongodb.Database); err != nil {
		log.Fatalf("Failed to run migrations: %v", err)
	}

	// Create indexes for datasources + dashboards (managed via mongodb.go).
	if err := mongodb.CreateIndexes(ctx); err != nil {
		log.Fatalf("Failed to create MongoDB indexes: %v", err)
	}

	// Create Gin router
	router := gin.Default()

	// Setup CORS
	// When AllowCredentials is true, the browser rejects Access-Control-Allow-Origin: "*".
	// If the config includes "*" in allowed origins, use AllowOriginFunc to echo the
	// requesting origin back (spec-compliant with credentials).
	corsConfig := cors.Config{
		AllowMethods:     cfg.CORS.AllowedMethods,
		AllowHeaders:     cfg.CORS.AllowedHeaders,
		ExposeHeaders:    cfg.CORS.ExposeHeaders,
		AllowCredentials: cfg.CORS.AllowCredentials,
		MaxAge:           time.Duration(cfg.CORS.MaxAge) * time.Second,
	}
	hasWildcard := false
	for _, o := range cfg.CORS.AllowedOrigins {
		if o == "*" {
			hasWildcard = true
			break
		}
	}
	if hasWildcard && cfg.CORS.AllowCredentials {
		corsConfig.AllowOriginFunc = func(origin string) bool { return true }
	} else {
		corsConfig.AllowOrigins = cfg.CORS.AllowedOrigins
	}
	router.Use(cors.New(corsConfig))

	// Health check endpoint
	router.GET("/health", healthCheck(mongodb))

	// Version endpoint
	router.GET("/version", func(c *gin.Context) {
		c.JSON(http.StatusOK, version.Info())
	})

	// Initialize repositories
	connectionRepo := repository.NewConnectionRepository(mongodb.Database)
	componentRepo := repository.NewComponentRepository(mongodb.Database)
	dashboardRepo := repository.NewDashboardRepository(mongodb.Database)
	aiSessionRepo := repository.NewAISessionRepository(mongodb.Database)
	configRepo := repository.NewConfigRepository(mongodb.Database)
	userRepo := repository.NewUserRepository(mongodb.Database)
	settingsRepo := repository.NewSettingsItemRepository(mongodb.Database)
	deviceTypeRepo := repository.NewDeviceTypeRepository(mongodb.Database)
	deviceRepo := repository.NewDeviceRepository(mongodb.Database)
	namespaceRepo := repository.NewNamespaceRepository(mongodb.Database)
	apiKeyRepo := repository.NewAPIKeyRepository(mongodb.Database)
	alertRepo := repository.NewAlertRepository(mongodb.Database)

	// Create chart indexes
	if err := componentRepo.CreateIndexes(ctx); err != nil {
		log.Printf("Warning: Failed to create chart indexes: %v", err)
	}

	// Create AI session indexes
	if err := aiSessionRepo.CreateIndexes(ctx); err != nil {
		log.Printf("Warning: Failed to create AI session indexes: %v", err)
	}

	// Create config indexes
	if err := configRepo.CreateIndexes(ctx); err != nil {
		log.Printf("Warning: Failed to create config indexes: %v", err)
	}

	// Create user indexes
	if err := userRepo.CreateIndexes(ctx); err != nil {
		log.Printf("Warning: Failed to create user indexes: %v", err)
	}

	// Create settings indexes
	if err := settingsRepo.CreateIndexes(ctx); err != nil {
		log.Printf("Warning: Failed to create settings indexes: %v", err)
	}

	// Create device type indexes
	if err := deviceTypeRepo.CreateIndexes(ctx); err != nil {
		log.Printf("Warning: Failed to create device type indexes: %v", err)
	}

	// Create device indexes
	if err := deviceRepo.CreateIndexes(ctx); err != nil {
		log.Printf("Warning: Failed to create device indexes: %v", err)
	}

	// Create namespace indexes
	if err := namespaceRepo.CreateIndexes(ctx); err != nil {
		log.Printf("Warning: Failed to create namespace indexes: %v", err)
	}

	// Create API key indexes
	if err := apiKeyRepo.CreateIndexes(ctx); err != nil {
		log.Printf("Warning: Failed to create API key indexes: %v", err)
	}

	// Create alert indexes (incl. TTL for retention sweep)
	if err := alertRepo.CreateIndexes(ctx); err != nil {
		log.Printf("Warning: Failed to create alert indexes: %v", err)
	}

	// Read Clerk env vars early — both feed into services constructed
	// below. CLERK_SECRET_KEY drives the verifier (and is the soft
	// switch for Clerk mode). CLERK_PUBLISHABLE_KEY is forwarded to
	// the SPA via /api/config/system so the React SDK can initialize.
	// Both must be set for Clerk mode to be useful end-to-end; we
	// don't enforce that here so admins can stage rollouts.
	clerkSecret := os.Getenv("CLERK_SECRET_KEY")
	clerkPublishable := os.Getenv("CLERK_PUBLISHABLE_KEY")

	// Initialize services
	connectionService := service.NewConnectionService(connectionRepo, componentRepo, deviceRepo)
	componentService := service.NewComponentService(componentRepo, dashboardRepo)
	dashboardService := service.NewDashboardService(dashboardRepo, mongodb.Database, componentRepo, connectionRepo)
	aiSessionService := service.NewAISessionService(aiSessionRepo, componentRepo, dashboardRepo)
	configService := service.NewConfigService(configRepo, settingsRepo, cfg, clerkPublishable)
	userService := service.NewUserService(userRepo, apiKeyRepo, configRepo)
	deviceTypeService := service.NewDeviceTypeService(deviceTypeRepo)
	deviceService := service.NewDeviceService(deviceRepo, deviceTypeRepo, connectionRepo)
	deviceDiscoveryService := service.NewDeviceDiscoveryService(connectionRepo, deviceTypeRepo, deviceRepo)
	apiKeyService := service.NewAPIKeyService(apiKeyRepo)

	// Namespace service with the three entity repos wired in. Each repo
	// implements CountByNamespace + RenameNamespace so the service's
	// delete-guard and rename-cascade paths work end-to-end.
	namespaceService := service.NewNamespaceService(namespaceRepo, connectionRepo, componentRepo, dashboardRepo)
	if err := namespaceService.SeedDefault(ctx); err != nil {
		log.Printf("Warning: Failed to seed default namespace: %v", err)
	} else {
		fmt.Println("✓ Default namespace ensured")
	}

	// Load user-configurable settings from separate YAML file
	userConfig, err := config.LoadUserConfigurableSettings()
	if err != nil {
		log.Printf("Warning: Failed to load user-configurable settings: %v", err)
		userConfig = nil // Will use empty settings
	}
	settingsService := service.NewSettingsService(settingsRepo, userConfig)

	// Sync user-configurable settings from YAML file to MongoDB on startup
	if err := settingsService.SyncSettingsFromConfig(ctx); err != nil {
		log.Printf("Warning: Failed to sync settings from config: %v", err)
	} else {
		fmt.Println("✓ User-configurable settings synced to MongoDB")
	}

	// Wire the registry TypeFilter on top of the settings service. The
	// adapter implements both EnabledTypesProvider (for the filter) and
	// EnabledTypesUpdater (for the seed routine). The filter's Invalidate
	// hook is wired in below so admin saves take effect immediately.
	var typeFilter *registry.SettingsTypeFilter
	enabledTypesAdapter := service.NewEnabledTypesAdapter(settingsService, func() {
		if typeFilter != nil {
			typeFilter.Invalidate()
		}
	})
	typeFilter = registry.NewSettingsTypeFilter(enabledTypesAdapter)
	settingsService.SetEnabledTypesObserver(func(key string) {
		if key == service.EnabledTypesKey {
			typeFilter.Invalidate()
		}
	})

	// Seed known/enabled types so newly-shipped types in this release land
	// enabled by default while admin disables persist across upgrades.
	if err := registry.SeedKnownAndEnabledTypes(ctx, enabledTypesAdapter); err != nil {
		log.Printf("Warning: Failed to seed enabled/known types: %v", err)
	} else {
		fmt.Println("✓ Type availability ledger seeded (enabled_types/known_types)")
	}

	// Seed pseudo users (Admin, Designer, Support)
	if err := userService.SeedPseudoUsers(ctx); err != nil {
		log.Printf("Warning: Failed to seed pseudo users: %v", err)
	} else {
		fmt.Println("✓ Pseudo users seeded (Admin, Designer, Support)")
	}

	// Seed built-in device types
	if err := deviceTypeService.SeedBuiltInDeviceTypes(ctx); err != nil {
		log.Printf("Warning: Failed to seed built-in device types: %v", err)
	} else {
		fmt.Println("✓ Built-in device types seeded (zigbee-switch, zigbee-dimmer, caseta-switch, caseta-dimmer, caseta-shade, caseta-fan)")
	}

	// Get the global ChartHub for real-time chart update broadcasts
	chartHub := hub.GetComponentHub()
	fmt.Println("✓ ChartHub initialized for real-time chart updates")

	// Initialize StreamManager for socket datasource streaming
	streamManager := streaming.NewManager(connectionRepo, streaming.DefaultManagerConfig())
	fmt.Println("✓ StreamManager initialized for socket datasource streaming")

	// Initialize inbound WebSocket handler for ts-store push connections
	inboundHandler := streaming.GetInboundHandler()
	_ = inboundHandler // Used in routes below
	// Hand the configured port to the streaming package so its
	// DASHBOARD_HOST autodiscovery fallback can build the inbound
	// callback URL with the right port.
	streaming.SetServerPort(cfg.Server.Port)
	fmt.Println("✓ InboundHandler initialized for ts-store push connections")

	// Initialize AI agent (optional - requires ANTHROPIC_API_KEY)
	toolExecutor := ai.NewToolExecutor(componentRepo, connectionRepo, connectionService, deviceTypeRepo, chartHub)
	deviceTypeLister := &service.DeviceTypeListerAdapter{Service: deviceTypeService}
	catalogProvider := service.NewCatalogProvider(deviceTypeLister, typeFilter)
	var aiAgent *ai.Agent
	agent, err := ai.NewAgent(toolExecutor, aiSessionService, catalogProvider, nil) // nil config uses defaults
	if err != nil {
		log.Printf("⚠️  AI Agent disabled: %v", err)
		log.Printf("   Set ANTHROPIC_API_KEY environment variable to enable AI features")
	} else {
		aiAgent = agent
		fmt.Println("✓ AI Agent enabled (Anthropic SDK)")
	}

	// Initialize handlers
	connectionHandler := handlers.NewConnectionHandler(connectionService)
	componentHandler := handlers.NewComponentHandler(componentService)
	dashboardHandler := handlers.NewDashboardHandler(dashboardService)
	aiSessionHandler := handlers.NewAISessionHandler(aiSessionService, aiAgent, chartHub)
	debugHandler := handlers.NewDebugHandler()
	streamHandler := handlers.NewStreamHandler(streamManager)
	configHandler := handlers.NewConfigHandler(configService)
	authHandler := handlers.NewAuthHandler(userService)
	settingsHandler := handlers.NewSettingsHandler(settingsService)
	commandHandler := handlers.NewCommandHandler(connectionService, componentService, deviceTypeService)
	frigateHandler := handlers.NewFrigateHandler(connectionService)
	registryHandler := handlers.NewRegistryHandler(deviceTypeService, typeFilter)
	deviceTypeHandler := handlers.NewDeviceTypeHandler(deviceTypeService)
	deviceHandler := handlers.NewDeviceHandler(deviceService, deviceDiscoveryService)
	namespaceHandler := handlers.NewNamespaceHandler(namespaceService)
	apiKeyHandler := handlers.NewAPIKeyHandler(apiKeyService)
	systemUserHandler := handlers.NewSystemUserHandler(userService, apiKeyService)
	eventHub := service.NewEventHub()
	eventsHandler := handlers.NewEventsHandler(eventHub)
	alertService := service.NewAlertService(alertRepo)
	alertHandler := handlers.NewAlertHandler(alertService)
	webhookHandler := handlers.NewWebhookHandler(connectionService, eventHub, alertService)
	statusHandler := handlers.NewStatusHandler(mongodb, streamManager)
	tagHandler := handlers.NewTagHandler(mongodb.Database)

	// Initialize Clerk verifier when CLERK_SECRET_KEY is set. Same
	// soft-switch pattern as the AI agent on DASHBOARD_ANTHROPIC_API_KEY:
	// the env var's presence is the activation signal. Empty → fall
	// through to API-key + legacy auth only. (clerkSecret/clerkPublishable
	// are read at the top of services init so configService can pipe
	// the publishable key to the SPA.)
	var identityVerifier auth.IdentityVerifier
	if clerkSecret != "" {
		cv, err := auth.NewClerkVerifier(clerkSecret)
		if err != nil {
			log.Printf("⚠️  Clerk verifier init failed: %v — Clerk auth disabled", err)
		} else {
			identityVerifier = cv
			fmt.Println("✓ Clerk identity verifier enabled (CLERK_SECRET_KEY detected)")
			if clerkPublishable == "" {
				log.Printf("⚠️  CLERK_PUBLISHABLE_KEY is empty — the SPA can't initialize Clerk without it")
			}
		}
	} else {
		fmt.Println("· Clerk identity verifier disabled (CLERK_SECRET_KEY not set)")
	}

	// Initialize the session-token plumbing. After v0.17.0, every
	// authenticated request to /api/* carries a dashboard-issued
	// access JWT — the four inbound credential channels (Clerk JWT,
	// API key, X-User-ID, ?user_id=) only ride to /api/auth/session
	// where they're traded for a JWT pair. The bootstrap handler
	// walks the IdP registry; the registry order is deliberate (API
	// keys win over Clerk over legacy GUID).
	jwtSecret := cfg.Auth.JWTSecret
	if jwtSecret == "" {
		// Dev fallback: generate a random 64-byte secret at boot. This
		// invalidates every issued token on restart — fine for local
		// dev but DON'T run a production deployment this way.
		buf := make([]byte, 64)
		if _, err := rand.Read(buf); err != nil {
			log.Fatalf("Failed to seed random JWT secret: %v", err)
		}
		jwtSecret = hex.EncodeToString(buf)
		log.Println("⚠️  AUTH: jwt_secret not configured — using ephemeral random secret. All sessions invalidate on restart.")
	}
	tokenSigner, err := auth.NewTokenSigner(jwtSecret, cfg.Auth.Issuer)
	if err != nil {
		log.Fatalf("Failed to init token signer: %v", err)
	}
	revokedFamiliesRepo := repository.NewRevokedFamiliesRepository(mongodb.Database)
	if err := revokedFamiliesRepo.CreateIndexes(context.Background()); err != nil {
		log.Printf("⚠️  revoked_refresh_families index creation: %v", err)
	}
	sessionService := auth.NewSessionService(tokenSigner, revokedFamiliesRepo, settingsService)

	// IdP registry — order matters: API key first (unambiguous prefix
	// wins), Clerk JWT second (when configured), legacy GUID last
	// (anyone-who-knows-the-GUID-becomes-them; gated on
	// cfg.Auth.AllowLegacyGUID so production deployments with a real
	// IdP don't accept a header-asserted identity).
	idps := []idp.IdentityProvider{
		idp.NewAPIKeyIdP(apiKeyService, userService),
	}
	if identityVerifier != nil {
		idps = append(idps, idp.NewClerkJWTIdP(identityVerifier, userRepo))
	}
	if cfg.Auth.AllowLegacyGUID {
		idps = append(idps, idp.NewLegacyGUIDIdP(userService))
		fmt.Println("⚠️  Legacy GUID auth ENABLED (auth.allow_legacy_guid=true). X-User-ID and ?user_id= are honored at /api/auth/session. Disable in production.")
	} else {
		fmt.Println("· Legacy GUID auth disabled (auth.allow_legacy_guid=false). X-User-ID and ?user_id= are NOT honored at /api/auth/session.")
	}
	idpRegistry := idp.NewRegistry(idps...)

	// Bootstrap handler — /api/auth/session, /api/auth/refresh,
	// /api/auth/logout. Registered as PUBLIC below; the inbound
	// credentials are read inside the handler via the registry.
	cookieCfg := handlers.DefaultRefreshCookie()
	cookieCfg.Secure = cfg.Auth.CookieSecure
	switch strings.ToLower(cfg.Auth.CookieSameSite) {
	case "strict":
		cookieCfg.SameSite = http.SameSiteStrictMode
	case "none":
		cookieCfg.SameSite = http.SameSiteNoneMode
	default:
		cookieCfg.SameSite = http.SameSiteLaxMode
	}
	authSessionHandler := handlers.NewAuthSessionHandler(sessionService, idpRegistry, userService, cookieCfg)

	authMiddleware := middleware.NewAuthMiddleware(userService, sessionService, apiKeyService)

	// Initialize MCP
	mcpRegistry := mcp.NewToolRegistry(connectionService, dashboardService, componentService, deviceTypeService, typeFilter)
	mcpHandler := mcp.NewHandler(mcpRegistry)

	// PUBLIC bootstrap routes — must be reachable BEFORE the auth
	// middleware runs because they accept the inbound credentials
	// (Clerk JWT, API key, X-User-ID, ?user_id=) that the middleware
	// no longer knows about. Mounted on the bare router so neither
	// Authenticate nor Authorize fires.
	publicAuth := router.Group("/api/auth")
	{
		publicAuth.POST("/session", authSessionHandler.CreateSession)
		publicAuth.POST("/refresh", authSessionHandler.Refresh)
		publicAuth.POST("/logout", authSessionHandler.Logout)
	}

	// API routes with authentication and authorization middleware.
	// Every route in this group requires a valid access JWT (presented
	// as Authorization: Bearer or ?st= for SSE/WS). Routes that need
	// to answer pre-auth (e.g. /api/auth/me's "you have no identity"
	// response, /api/health) are flagged Public:true in the route-
	// rules table; Authorize() lets them through unauthenticated.
	api := router.Group("/api")
	api.Use(authMiddleware.Authenticate())
	api.Use(authMiddleware.Authorize())
	{
		// Health check
		api.GET("/health", healthCheck(mongodb))

		// Auth routes (for getting current user capabilities)
		auth := api.Group("/auth")
		{
			auth.GET("/me", authHandler.GetMe)
		}

		// User management routes. Writes (POST/PUT/DELETE) and the
		// full-directory GET require Manage. The single-record GETs
		// (`/:id` and `/by-guid/:guid`) stay open to any authenticated
		// caller so the SPA bootstrap can resolve a GUID claim into a
		// User record for the in-app header; both return a redacted
		// view for non-Manage callers (see auth_handler.go::redactUser).
		users := api.Group("/users")
		{
			users.GET("", authHandler.ListUsers)
			users.GET("/by-guid/:guid", authHandler.GetUserByGUID) // before /:id so the router doesn't shadow it
			users.GET("/:id", authHandler.GetUser)
			users.POST("", authHandler.CreateUser)
			users.PUT("/:id", authHandler.UpdateUser)
			users.DELETE("/:id", authHandler.DeleteUser)
		}

		// System users — non-interactive service principals used by
		// inbound integrations (ts-store webhook receiver, etc.).
		// Every route here is gated to Manage by the route rules in
		// middleware/auth.go. The route group is separate from /users
		// so an admin can grant integration-specific permissions
		// without touching the human-user routes.
		systemUsers := api.Group("/system-users")
		{
			systemUsers.GET("", systemUserHandler.ListSystemUsers)
			systemUsers.POST("", systemUserHandler.CreateSystemUser)
			systemUsers.DELETE("/:id", systemUserHandler.DeleteSystemUser)
			systemUsers.GET("/:id/api-keys", systemUserHandler.ListSystemUserAPIKeys)
			systemUsers.POST("/:id/api-keys", systemUserHandler.CreateSystemUserAPIKey)
		}

		// Events — SSE fan-out of in-process events (alerts, etc.)
		// to logged-in clients. One stream per browser tab; events
		// are scoped by namespace when authz lands (today: every
		// authenticated subscriber sees every event).
		events := api.Group("/events")
		{
			events.GET("/stream", eventsHandler.Stream)
		}

		// Alerts — persisted bell-panel records. The SSE stream
		// above pushes alerts live to currently-connected clients;
		// these endpoints back the bell-on-load hydrate plus
		// per-row dismiss / pin actions. "First reader clears it"
		// semantics with a per-record Pinned override so a user
		// can keep an alert visible until someone unpins it.
		alerts := api.Group("/alerts")
		{
			alerts.GET("", alertHandler.ListAlerts)
			alerts.POST("/:id/seen", alertHandler.MarkSeen)
			alerts.POST("/:id/pin", alertHandler.Pin)
			alerts.DELETE("/:id/pin", alertHandler.Unpin)
		}

		// Inbound webhooks — external integrations POST alert
		// payloads here. Auth runs via the standard API-key
		// middleware (Bearer trve_... on a system-user key). The
		// handler validates the connection_id in the path against
		// the payload's store_name so a misconfigured rule can't
		// surface as a notification against the wrong connection.
		webhooks := api.Group("/webhooks")
		{
			webhooks.POST("/tsstore/:connection_id", webhookHandler.HandleTSStoreAlert)
		}

		// Connection routes (new terminology - preferred)
		connections := api.Group("/connections")
		{
			connections.POST("", connectionHandler.CreateConnection)
			connections.GET("", connectionHandler.ListConnections)
			connections.GET("/streams", streamHandler.ListActiveStreams) // Before /:id to avoid conflict
			connections.GET("/:id", connectionHandler.GetConnection)
			connections.PUT("/:id", connectionHandler.UpdateConnection)
			connections.DELETE("/:id", connectionHandler.DeleteConnection)
			connections.POST("/test", connectionHandler.TestConnection)
			connections.POST("/:id/health", connectionHandler.CheckConnectionHealth)
			connections.POST("/:id/query", connectionHandler.QueryConnection)
			connections.GET("/:id/schema", connectionHandler.GetConnectionSchema)
			connections.GET("/:id/prometheus/labels/:label/values", connectionHandler.GetPrometheusLabelValues) // Prometheus label values
			connections.GET("/:id/edgelake/databases", connectionHandler.GetEdgeLakeDatabases)                     // EdgeLake databases
			connections.GET("/:id/edgelake/tables", connectionHandler.GetEdgeLakeTables)                           // EdgeLake tables
			connections.GET("/:id/edgelake/schema", connectionHandler.GetEdgeLakeSchema)                           // EdgeLake table schema
			connections.GET("/:id/mqtt/topics", connectionHandler.GetMQTTTopics)                                // MQTT topic discovery
			connections.GET("/:id/mqtt/sample", connectionHandler.SampleMQTTTopic)                              // MQTT topic schema sample
			connections.GET("/:id/stream", streamHandler.StreamConnection)                                      // SSE streaming
			connections.GET("/:id/stream/status", streamHandler.GetStreamStatus)                 // Stream status
			connections.POST("/:id/stream/aggregated", streamHandler.StreamAggregatedConnection) // SSE aggregated streaming
			connections.GET("/aggregators", streamHandler.GetAggregatorStats)                    // Aggregator stats
			connections.POST("/:id/command", commandHandler.ExecuteCommand)                     // Bidirectional command execution
			connections.POST("/:id/discover-devices", deviceHandler.DiscoverDevices)              // Device discovery
		}

		// Registry routes - unified type catalog (connection types, component
		// subtypes, device types). This is the single source of truth that
		// the AI builder and MCP server both read from.
		registryRoutes := api.Group("/registry")
		{
			registryRoutes.GET("/connections", registryHandler.ListConnectionTypes)
			registryRoutes.GET("/connections/:typeId", registryHandler.GetConnectionType)
			registryRoutes.GET("/categories", registryHandler.ListCategories)
			registryRoutes.GET("/components", registryHandler.ListComponentTypes)
			registryRoutes.GET("/components/:typeId", registryHandler.GetComponentType)
			registryRoutes.GET("/catalog", registryHandler.GetCatalog)
			registryRoutes.GET("/catalog.md", registryHandler.GetCatalogMarkdown)
			registryRoutes.GET("/integrations", registryHandler.ListIntegrations)
		}

		// Component routes (umbrella for chart, control, and display sub-types)
		components := api.Group("/components")
		{
			components.GET("/summaries", componentHandler.GetComponentSummaries)
			components.POST("", componentHandler.CreateComponent)
			components.GET("", componentHandler.ListComponents)
			components.GET("/:id", componentHandler.GetComponent)
			components.PUT("/:id", componentHandler.UpdateComponent)
			components.DELETE("/:id", componentHandler.DeleteComponent)
			// Versioning endpoints
			components.GET("/:id/versions", componentHandler.ListComponentVersions)
			components.GET("/:id/versions/:version", componentHandler.GetComponentVersion)
			components.DELETE("/:id/versions/:version", componentHandler.DeleteComponentVersion)
			components.GET("/:id/version-info", componentHandler.GetComponentVersionInfo)
			components.GET("/:id/draft", componentHandler.GetComponentDraft)
			components.DELETE("/:id/draft", componentHandler.DeleteComponentDraft)
		}

		// Control routes (controls are components with component_type="control")
		controls := api.Group("/controls")
		{
			controls.POST("/:id/execute", commandHandler.ExecuteControlCommand)
		}

		// Frigate NVR proxy routes
		frigate := api.Group("/frigate/:connection_id")
		{
			frigate.GET("/cameras", frigateHandler.GetCameras)
			frigate.GET("/snapshot/:camera", frigateHandler.GetSnapshot)
			frigate.GET("/events/:camera", frigateHandler.GetEvents)
			frigate.GET("/event/:event_id/clip", frigateHandler.GetEventClip)
			frigate.GET("/event/:event_id/snapshot", frigateHandler.GetEventSnapshot)
			frigate.GET("/reviews", frigateHandler.GetReviews)
			frigate.POST("/reviews/viewed", frigateHandler.MarkReviewsViewed)
			frigate.GET("/review/:review_id/thumbnail", frigateHandler.GetReviewThumbnail)
			frigate.GET("/info", frigateHandler.GetInfo)
			frigate.GET("/live/:camera", frigateHandler.ProxyLiveStream)
		}

		// API key routes. POST/GET/DELETE all live under /api/api-keys.
		// Owners can manage their own keys; admins (manage capability) can
		// list every key and revoke any key — gated by the route rules in
		// auth middleware.
		apiKeys := api.Group("/api-keys")
		{
			apiKeys.GET("", apiKeyHandler.ListMyAPIKeys)
			apiKeys.POST("", apiKeyHandler.CreateAPIKey)
			apiKeys.GET("/all", apiKeyHandler.ListAllAPIKeys) // admin
			apiKeys.DELETE("/:id", apiKeyHandler.RevokeAPIKey)
		}

		// Namespace routes
		namespaces := api.Group("/namespaces")
		{
			namespaces.GET("", namespaceHandler.ListNamespaces)
			namespaces.POST("", namespaceHandler.CreateNamespace)
			namespaces.GET("/:id", namespaceHandler.GetNamespace)
			namespaces.PUT("/:id", namespaceHandler.UpdateNamespace)
			namespaces.DELETE("/:id", namespaceHandler.DeleteNamespace)
			namespaces.GET("/:id/usage", namespaceHandler.GetUsage)
		}

		// Device Type routes
		deviceTypes := api.Group("/device-types")
		{
			deviceTypes.GET("", deviceTypeHandler.ListDeviceTypes)
			deviceTypes.POST("", deviceTypeHandler.CreateDeviceType)
			deviceTypes.GET("/categories", deviceTypeHandler.GetCategories)
			deviceTypes.GET("/control-types", deviceTypeHandler.GetControlTypes)
			deviceTypes.GET("/:id", deviceTypeHandler.GetDeviceType)
			deviceTypes.PUT("/:id", deviceTypeHandler.UpdateDeviceType)
			deviceTypes.DELETE("/:id", deviceTypeHandler.DeleteDeviceType)
		}

		// Device routes
		devices := api.Group("/devices")
		{
			devices.GET("", deviceHandler.ListDevices)
			devices.POST("", deviceHandler.CreateDevice)
			devices.POST("/import", deviceHandler.ImportDevices)
			devices.GET("/:id", deviceHandler.GetDevice)
			devices.PUT("/:id", deviceHandler.UpdateDevice)
			devices.DELETE("/:id", deviceHandler.DeleteDevice)
		}

		// Dashboard routes
		dashboards := api.Group("/dashboards")
		{
			dashboards.POST("", dashboardHandler.CreateDashboard)
			dashboards.GET("", dashboardHandler.ListDashboards)
			dashboards.GET("/:id", dashboardHandler.GetDashboard)
			dashboards.PUT("/:id", dashboardHandler.UpdateDashboard)
			dashboards.DELETE("/:id", dashboardHandler.DeleteDashboard)

			// Export — POST /api/dashboards/export[/preview]. Both POST
			// because they take a JSON body listing dashboard IDs.
			dashboards.POST("/export/preview", dashboardHandler.PreviewExport)
			dashboards.POST("/export", dashboardHandler.ExportDashboards)

			// Import — two phases. Preflight is read-only; apply writes.
			dashboards.POST("/import/preflight", dashboardHandler.PreflightImport)
			dashboards.POST("/import/apply", dashboardHandler.ApplyImport)
		}

		// AI Session routes
		aiSessions := api.Group("/ai/sessions")
		{
			aiSessions.POST("", aiSessionHandler.CreateSession)
			aiSessions.GET("/:id", aiSessionHandler.GetSession)
			aiSessions.POST("/:id/messages", aiSessionHandler.SendMessage)
			aiSessions.GET("/:id/ws", aiSessionHandler.HandleWebSocket)
			aiSessions.POST("/:id/save", aiSessionHandler.SaveSession)
			aiSessions.DELETE("/:id", aiSessionHandler.CancelSession)
		}

		// AI Debug routes
		aiDebug := api.Group("/ai/debug")
		{
			aiDebug.GET("", debugHandler.HandleDebugWebSocket)
			aiDebug.GET("/status", debugHandler.GetDebugStatus)
		}

		// Config routes
		configRoutes := api.Group("/config")
		{
			configRoutes.GET("/system", configHandler.GetSystemConfig)
			configRoutes.PUT("/system", configHandler.UpdateSystemConfig)
			configRoutes.GET("/user/:user_id", configHandler.GetUserConfig)
			configRoutes.PUT("/user/:user_id", configHandler.UpdateUserConfig)
		}

		// Settings routes (new settings management system)
		settingsHandler.RegisterRoutes(api)

		// Tags routes (shared tag pool across connections/components/dashboards)
		api.GET("/tags", tagHandler.ListTags)
	}

	// MCP routes — gated by the same Authenticate middleware as /api so
	// external agents (Claude Desktop via mcp-proxy, the dashboard-agent
	// CLI) must present a valid API key in `Authorization: Bearer
	// trve_...`. Routes intentionally stay at the top-level `/mcp/*` path
	// (not under /api) because mcp-proxy / Claude Desktop expect them
	// there. Authorization runs after Authenticate so the route
	// capability rules in auth middleware still apply.
	mcpGroup := router.Group("")
	mcpGroup.Use(authMiddleware.Authenticate())
	mcpGroup.Use(authMiddleware.Authorize())
	mcpHandler.SetupRoutes(mcpGroup)

	// Inbound WebSocket endpoint for ts-store push connections (outside /api group, no auth required)
	// ts-store dials out to this endpoint to push data
	router.GET("/api/streams/inbound/:connectionId", inboundHandler.HandleInboundWebSocket)

	// Status monitoring WebSocket (no auth required for monitoring tools)
	router.GET("/api/ws/status", statusHandler.HandleStatusWebSocket)

	// Swagger documentation
	if cfg.Swagger.Enabled {
		router.GET("/swagger/*any", ginSwagger.WrapHandler(swaggerFiles.Handler))
		fmt.Println("✓ Swagger UI enabled at http://localhost:3001/swagger/index.html")
	}

	fmt.Println("✓ MCP SSE endpoint enabled at http://localhost:3001/mcp/sse")
	fmt.Println("✓ AI Debug WebSocket enabled at ws://localhost:3001/api/ai/debug")
	fmt.Println("✓ TSStore inbound WebSocket at ws://localhost:3001/api/streams/inbound/:connectionId")
	fmt.Println("✓ Status WebSocket at ws://localhost:3001/api/ws/status?interval=5s")

	// Serve documentation site at /docs.
	// Resolve relative to the binary so the container image (where docs are
	// baked in next to the binary at /app/udoc/build) and local dev builds
	// (binary under server-go/bin/, docs under repo-root udoc/build) both work.
	docsPath := resolveDocsPath()
	if docsPath != "" {
		router.Static("/docs", docsPath)
		fmt.Printf("✓ Documentation site enabled at http://localhost:%d/docs\n", cfg.Server.Port)
	}

	// Static file serving for SPA (production mode)
	if cfg.StaticFiles.Enabled {
		staticPath := cfg.StaticFiles.Path
		if !filepath.IsAbs(staticPath) {
			// Make relative paths relative to the server-go directory
			staticPath = filepath.Join(".", staticPath)
		}

		// Verify the static files directory exists
		if _, err := os.Stat(staticPath); os.IsNotExist(err) {
			log.Printf("⚠️  Static files directory not found: %s", staticPath)
			log.Printf("   Run 'npm run build' in the client directory to create it")
		} else {
			// Serve static files for any route not matched by API endpoints
			router.NoRoute(func(c *gin.Context) {
				path := c.Request.URL.Path

				// Skip API routes - they should return 404 if not found
				if strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/mcp/") || strings.HasPrefix(path, "/swagger/") {
					c.JSON(http.StatusNotFound, gin.H{"error": "Not found"})
					return
				}

				// Try to serve the exact file
				filePath := filepath.Join(staticPath, path)
				if info, err := os.Stat(filePath); err == nil && !info.IsDir() {
					c.File(filePath)
					return
				}

				// For SPA routing: serve index.html for all other routes
				indexPath := filepath.Join(staticPath, "index.html")
				c.File(indexPath)
			})

			// Serve static assets directory
			router.Static("/assets", filepath.Join(staticPath, "assets"))

			fmt.Printf("✓ Static file serving enabled from %s\n", staticPath)
		}
	}

	// Create HTTP server
	srv := &http.Server{
		Addr:         fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port),
		Handler:      router,
		ReadTimeout:  cfg.Server.ReadTimeout,
		WriteTimeout: cfg.Server.WriteTimeout,
	}

	// Start server in goroutine
	go func() {
		fmt.Printf("\n🚀 Dashboard Server starting on http://%s:%d\n", cfg.Server.Host, cfg.Server.Port)
		fmt.Printf("📡 Mode: %s\n", cfg.Server.Mode)
		fmt.Printf("📊 MongoDB: %s\n", cfg.MongoDB.Database)
		fmt.Print("\nPress Ctrl+C to stop\n\n")

		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Failed to start server: %v", err)
		}
	}()

	// Wait for interrupt signal for graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	fmt.Println("\n🛑 Shutting down server...")

	// Stop StreamManager
	streamManager.Stop()
	fmt.Println("✓ StreamManager stopped")

	// Graceful shutdown
	ctx, cancel = context.WithTimeout(context.Background(), cfg.Server.ShutdownTimeout)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("Server forced to shutdown: %v", err)
	}

	fmt.Println("✓ Server stopped gracefully")
}

// healthCheck returns a health check handler
// @Summary Health check
// @Description Check if the server and dependencies are healthy
// @Tags System
// @Produce json
// @Success 200 {object} map[string]interface{}
// @Failure 503 {object} map[string]interface{}
// @Router /health [get]
func healthCheck(mongodb *database.MongoDB) gin.HandlerFunc {
	return func(c *gin.Context) {
		status := gin.H{
			"status":    "ok",
			"timestamp": time.Now().Format(time.RFC3339),
			"version":   version.Full(),
			"services":  gin.H{},
		}

		// Check MongoDB
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		defer cancel()

		if err := mongodb.Client.Ping(ctx, nil); err != nil {
			status["status"] = "degraded"
			status["services"].(gin.H)["mongodb"] = gin.H{
				"status": "unhealthy",
				"error":  err.Error(),
			}
		} else {
			status["services"].(gin.H)["mongodb"] = gin.H{
				"status": "healthy",
			}
		}

		// Return appropriate status code
		if status["status"] == "ok" {
			c.JSON(http.StatusOK, status)
		} else {
			c.JSON(http.StatusServiceUnavailable, status)
		}
	}
}

// resolveDocsPath finds the Docusaurus build output relative to the server
// binary. Returns "" if no docs directory is found.
//
// Container layout (baked by Dockerfile):    /app/server  +  /app/udoc/build
// Dev layout (go build -o bin/server):       server-go/bin/server  +  udoc/build (one dir above server-go)
func resolveDocsPath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	exeDir := filepath.Dir(exe)
	candidates := []string{
		filepath.Join(exeDir, "udoc", "build"),          // container: /app/udoc/build
		filepath.Join(exeDir, "..", "udoc", "build"),    // dev: server-go/bin -> server-go/udoc (unused today)
		filepath.Join(exeDir, "..", "..", "udoc", "build"), // dev: server-go/bin/server -> repo/udoc
	}
	for _, p := range candidates {
		if info, err := os.Stat(p); err == nil && info.IsDir() {
			return p
		}
	}
	return ""
}
