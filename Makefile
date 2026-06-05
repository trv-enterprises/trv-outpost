.PHONY: help build build-client build-server build-docs tarballs docker-push release release-tag clean version-bump api-docs api-docs-check gh-release

# Configuration
REGISTRY := ghcr.io
GITHUB_OWNER ?= $(shell git remote get-url origin | sed -n 's/.*github.com[:/]\([^/]*\)\/.*/\1/p')
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
BUILD_NUM ?= $(shell cat client/build.json 2>/dev/null | grep buildNumber | awk '{print $$2}' | tr -d ',' || echo "0")

# Architectures for tarballs
ARCHS := linux-amd64 linux-arm64 darwin-arm64

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo ''
	@echo 'Release workflow:'
	@echo '  1. make release VERSION=v0.3.0    # Build, tag, push'
	@echo '  2. git push origin main v0.3.0    # Triggers ghcr.io publish'
	@echo ''
	@echo 'Current: $(VERSION)+$(BUILD_NUM)'
	@echo 'Registry: $(REGISTRY)/$(GITHUB_OWNER)'

build: build-client build-docs build-server ## Build client, docs, and server

build-client: ## Build client
	@echo "Building client..."
	cd client && npm ci --legacy-peer-deps && npm run build
	@echo "✓ Client built"

build-docs: ## Build Docusaurus docs site
	@echo "Building docs..."
	cd udoc && npm ci && npm run build
	@echo "✓ Docs built"

build-server: ## Build server binaries (multi-arch)
	@echo "Building server binaries..."
	cd server-go && make release-build VERSION=$(VERSION) BUILD_NUM=$(BUILD_NUM)
	@echo "✓ Server binaries built"

api-docs: ## Regenerate Swagger spec + Postman collection from Go annotations
	@echo "Regenerating Swagger spec..."
	cd server-go && $(MAKE) swagger
	@echo "Rebuilding Postman collection..."
	cd docs/postman && node build-collection.js
	@echo "✓ API docs regenerated (server-go/docs/swagger.{json,yaml}, docs/postman/trv-outpost.postman_collection.json)"

# Guardrail used by `release`: regenerate the API docs and fail if the
# working tree picks up changes — that means the committed Swagger
# spec or Postman collection was stale. Forces the developer to
# refresh + commit before tagging, rather than shipping a tag that
# disagrees with the running server.
api-docs-check: api-docs
	@if [ -n "$$(git status --porcelain server-go/docs/swagger.json server-go/docs/swagger.yaml server-go/docs/docs.go docs/postman/trv-outpost.postman_collection.json 2>/dev/null)" ]; then \
		echo ""; \
		echo "❌  API docs are out of date. Diff:"; \
		git status --short server-go/docs/swagger.json server-go/docs/swagger.yaml server-go/docs/docs.go docs/postman/trv-outpost.postman_collection.json; \
		echo ""; \
		echo "    Review the regenerated files, then commit them:"; \
		echo "      git add server-go/docs/ docs/postman/trv-outpost.postman_collection.json"; \
		echo "      git commit -m 'Regenerate API docs'"; \
		exit 1; \
	fi
	@echo "✓ API docs are current"

tarballs: build ## Create architecture-specific tarballs
	@echo "Creating release tarballs for $(VERSION)..."
	@mkdir -p dist
	@for arch in $(ARCHS); do \
		echo "  Creating dashboard-$(VERSION)-$$arch.tar.gz..."; \
		mkdir -p dist/dashboard-$(VERSION)-$$arch; \
		cp server-go/dist/server-$$(echo $$arch | tr '-' ' ' | awk '{print $$1"-"$$2}' | sed 's/linux-/linux-/;s/darwin-/darwin-/') dist/dashboard-$(VERSION)-$$arch/server 2>/dev/null || \
		cp server-go/dist/server-$$arch dist/dashboard-$(VERSION)-$$arch/server 2>/dev/null || true; \
		cp -r client/dist dist/dashboard-$(VERSION)-$$arch/client-dist; \
		cp docker-compose.prod.yml dist/dashboard-$(VERSION)-$$arch/ 2>/dev/null || true; \
		cp .env.example dist/dashboard-$(VERSION)-$$arch/ 2>/dev/null || true; \
		tar -czf dist/dashboard-$(VERSION)-$$arch.tar.gz -C dist dashboard-$(VERSION)-$$arch; \
		rm -rf dist/dashboard-$(VERSION)-$$arch; \
	done
	@echo "✓ Tarballs created:"
	@ls -lh dist/*.tar.gz

docker-push: ## Build and push multi-arch images to ghcr.io
	@echo "Building and pushing multi-arch images to $(REGISTRY)/$(GITHUB_OWNER)..."
	@echo "Logging in to ghcr.io..."
	@echo "$$GITHUB_TOKEN" | docker login ghcr.io -u $(GITHUB_OWNER) --password-stdin
	@# Ensure buildx builder exists
	@docker buildx inspect multiarch-builder >/dev/null 2>&1 || \
		docker buildx create --name multiarch-builder --driver docker-container
	@docker buildx use multiarch-builder
	@echo "Building dashboard-server..."
	docker buildx build --platform linux/amd64,linux/arm64 \
		-f ./server-go/Dockerfile \
		-t $(REGISTRY)/$(GITHUB_OWNER)/dashboard-server:$(VERSION) \
		-t $(REGISTRY)/$(GITHUB_OWNER)/dashboard-server:latest \
		--push .
	@echo "Building dashboard-client..."
	docker buildx build --platform linux/amd64,linux/arm64 \
		-t $(REGISTRY)/$(GITHUB_OWNER)/dashboard-client:$(VERSION) \
		-t $(REGISTRY)/$(GITHUB_OWNER)/dashboard-client:latest \
		--push ./client
	@echo "✓ Images pushed to $(REGISTRY)/$(GITHUB_OWNER)"

version-bump: ## Update package.json version (use with VERSION=vX.Y.Z)
	@if [ "$(VERSION)" = "dev" ] || [ -z "$(VERSION)" ]; then \
		echo "Error: VERSION must be set (e.g., make version-bump VERSION=v0.3.0)"; \
		exit 1; \
	fi
	@PKG_VERSION=$$(echo $(VERSION) | sed 's/^v//'); \
	echo "Updating client/package.json to $$PKG_VERSION..."; \
	cd client && npm version --no-git-tag-version $$PKG_VERSION
	@echo "✓ Version updated"

release-tag: ## Create and push git tag (use with VERSION=vX.Y.Z)
	@if [ "$(VERSION)" = "dev" ] || [ -z "$(VERSION)" ]; then \
		echo "Error: VERSION must be set (e.g., make release-tag VERSION=v0.3.0)"; \
		exit 1; \
	fi
	@if git rev-parse "$(VERSION)" >/dev/null 2>&1; then \
		echo "Error: Tag $(VERSION) already exists"; \
		exit 1; \
	fi
	@echo "Creating tag $(VERSION)..."
	git add client/package.json client/build.json
	git commit -m "Release $(VERSION) (BUILD $(BUILD_NUM))" || true
	git tag -a "$(VERSION)" -m "Release $(VERSION) (BUILD $(BUILD_NUM))"
	@echo "✓ Tag $(VERSION) created"
	@echo ""
	@echo "Next: git push origin main $(VERSION)"

release: ## Full release: build, tarballs, commit, tag, push (use with VERSION=vX.Y.Z)
	@if [ "$(VERSION)" = "dev" ] || [ -z "$(VERSION)" ]; then \
		echo "Error: VERSION must be set"; \
		echo "Usage: make release VERSION=v0.3.0"; \
		exit 1; \
	fi
	@if git rev-parse "$(VERSION)" >/dev/null 2>&1; then \
		echo "Error: Tag $(VERSION) already exists"; \
		exit 1; \
	fi
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "Error: You have uncommitted changes. Commit or stash them first."; \
		git status --short; \
		exit 1; \
	fi
	@echo "============================================"
	@echo "Starting release $(VERSION)+$(BUILD_NUM)"
	@echo "============================================"
	@$(MAKE) api-docs-check
	@$(MAKE) version-bump VERSION=$(VERSION)
	@$(MAKE) tarballs VERSION=$(VERSION)
	@echo ""
	@echo "Committing version changes..."
	git add client/package.json client/package-lock.json
	git commit -m "Release $(VERSION) (BUILD $(BUILD_NUM))"
	@echo ""
	@echo "Creating tag $(VERSION)..."
	git tag -a "$(VERSION)" -m "Release $(VERSION) (BUILD $(BUILD_NUM))"
	@echo ""
	@echo "Pushing to origin..."
	git push origin main
	git push origin "$(VERSION)"
	@$(MAKE) gh-release VERSION=$(VERSION)
	@echo ""
	@echo "============================================"
	@echo "Release $(VERSION) complete!"
	@echo "============================================"
	@echo ""
	@echo "Tarballs:"
	@ls dist/*.tar.gz 2>/dev/null | sed 's/^/  /'
	@echo ""
	@echo "GitHub Actions is now publishing to ghcr.io:"
	@echo "  - $(REGISTRY)/$(GITHUB_OWNER)/dashboard-server:$(VERSION)"
	@echo "  - $(REGISTRY)/$(GITHUB_OWNER)/dashboard-client:$(VERSION)"

# Publish (or update) the GitHub Release entry for VERSION sourced from
# the annotated tag's body. Idempotent: if the release already exists
# (e.g. backfilled by hand or re-run), we update its notes instead of
# failing. Failures here are warned-not-fatal so an auth / network
# hiccup never undoes the rest of the release flow — the tag and
# images are already pushed by the time this runs.
#
# Marks the release as `--latest` explicitly because GitHub picks
# "Latest" by *creation timestamp*, not version number — backfilling
# old releases later would otherwise demote the current one.
gh-release: ## Publish GitHub Release entry from the annotated tag (auto-called by `release`)
	@if [ -z "$(VERSION)" ]; then \
		echo "Error: VERSION must be set"; exit 1; \
	fi
	@echo ""
	@echo "Publishing GitHub Release for $(VERSION)..."
	@notes="$$(git tag -l $(VERSION) --format='%(contents)')"; \
	if [ -z "$$notes" ]; then \
		echo "  ⚠️  Tag $(VERSION) has no annotation — using version string as notes."; \
		notes="$(VERSION)"; \
	fi; \
	title="$$(echo "$$notes" | head -1)"; \
	if [ -z "$$title" ]; then title="$(VERSION)"; fi; \
	if gh release view "$(VERSION)" >/dev/null 2>&1; then \
		echo "  · Release exists; refreshing notes."; \
		gh release edit "$(VERSION)" --title "$$title" --notes "$$notes" --latest 2>&1 || \
			echo "  ⚠️  gh release edit failed (continuing)."; \
	else \
		gh release create "$(VERSION)" --title "$$title" --notes "$$notes" --latest 2>&1 || \
			echo "  ⚠️  gh release create failed (continuing). Run manually:  gh release create $(VERSION) --notes \"\$$(git tag -l $(VERSION) --format='%(contents)')\""; \
	fi

clean: ## Clean build artifacts
	rm -rf dist/
	rm -rf server-go/dist/
	rm -rf client/dist/
	@echo "✓ Cleaned"

# ---------------------------------------------------------------------------
# Electron sidebar test helpers
# ---------------------------------------------------------------------------
# The desktop app stores user data under macOS's per-app userData dir.
# These targets help test the bootstrap / credential / workspace paths
# without needing to manually rm -rf the right files.
#
# Platform note: paths below are macOS-specific. When we ship Linux /
# Windows builds, USERDATA_DIR will need to branch on `uname`.
USERDATA_DIR := $$HOME/Library/Application Support/trve-dashboards
SIDEBAR_WORKSPACE := $(USERDATA_DIR)/sidebar-workspace
SIDEBAR_CONFIG := $(USERDATA_DIR)/trve-dashboards-config.json

sidebar-clear-creds: ## Wipe just the dashboard credentials (forces sign-in next launch)
	@if pgrep -fl "dashboard/electron" >/dev/null 2>&1; then \
		echo "⚠️  TRV Outpost Electron app appears to be running."; \
		echo "    Quit it first (Cmd-Q in the app) — electron-store writes"; \
		echo "    state on exit and may resurrect the file you're deleting."; \
		exit 1; \
	fi
	@if [ ! -f "$(SIDEBAR_CONFIG)" ]; then \
		echo "· No config file at $(SIDEBAR_CONFIG) — nothing to clear."; \
	else \
		rm -f "$(SIDEBAR_CONFIG)"; \
		echo "✓ Deleted $(SIDEBAR_CONFIG)"; \
		echo "  Next dashboard launch will prompt for server URL + API key."; \
		echo "  Sidebar will fall back to its own key (if set) or to the no-creds error."; \
	fi

sidebar-reset-workspace: ## Re-copy .mcp.json + CLAUDE.md from the packaged template
	@if [ ! -d "$(SIDEBAR_WORKSPACE)" ]; then \
		echo "· No workspace at $(SIDEBAR_WORKSPACE) — nothing to reset."; \
		echo "  Next sidebar open will bootstrap from the template."; \
	else \
		rm -rf "$(SIDEBAR_WORKSPACE)"; \
		echo "✓ Deleted $(SIDEBAR_WORKSPACE)"; \
		echo "  Next sidebar open will re-copy from"; \
		echo "  electron/resources/sidebar-workspace-template/"; \
	fi

sidebar-clean-all: ## Nuke ALL Electron app userData (cookies, cache, store, workspace)
	@if pgrep -fl "dashboard/electron" >/dev/null 2>&1; then \
		echo "⚠️  TRV Outpost Electron app appears to be running."; \
		echo "    Quit it first (Cmd-Q) — running renderers hold open files"; \
		echo "    that this rm -rf would leave half-deleted."; \
		exit 1; \
	fi
	@if [ ! -d "$(USERDATA_DIR)" ]; then \
		echo "· No userData dir at $(USERDATA_DIR) — nothing to clean."; \
	else \
		echo "⚠️  Removing $(USERDATA_DIR)"; \
		echo "    This nukes credentials, cookies, localStorage, cache,"; \
		echo "    sidebar workspace, and all other Electron state."; \
		rm -rf "$(USERDATA_DIR)"; \
		echo "✓ Cleaned. Next app launch is a fully-fresh install."; \
	fi

sidebar-inspect: ## Show what's currently in the Electron userData dir
	@echo "userData dir: $(USERDATA_DIR)"
	@if [ ! -d "$(USERDATA_DIR)" ]; then \
		echo "  (does not exist)"; \
	else \
		echo "  contents:"; \
		ls -la "$(USERDATA_DIR)" | sed 's/^/    /'; \
		echo ""; \
		if [ -d "$(SIDEBAR_WORKSPACE)" ]; then \
			echo "sidebar workspace contents:"; \
			ls -la "$(SIDEBAR_WORKSPACE)" | sed 's/^/    /'; \
		else \
			echo "sidebar workspace: not yet created (will be on first sidebar open)"; \
		fi; \
	fi

.DEFAULT_GOAL := help
