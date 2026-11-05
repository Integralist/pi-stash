# pi-stash — development tasks.

.DEFAULT_GOAL := help
.PHONY: help install test watch typecheck verify try clean

PI ?= pi

help: ## List the available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

test: ## Run the test suite once
	npx vitest --run

watch: ## Run the test suite and re-run on changes
	npx vitest

typecheck: ## Check types without emitting anything
	npx tsc --noEmit

verify: test typecheck ## Run test and typecheck

try: ## Open a pi session with this extension loaded, for isolated testing
	$(PI) -ne -e ./extensions/stash.ts

clean: ## Remove build scratch and cache
	rm -rf dist node_modules/.vite
