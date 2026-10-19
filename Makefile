.PHONY: install build test typecheck helm secrets hooks run

install:
	npm ci

build:
	npm run build

test:
	npm test

typecheck:
	npm run typecheck

helm:
	helm lint deploy/helm/neotags

secrets:
	@if command -v gitleaks >/dev/null 2>&1; then gitleaks git --config .gitleaks.toml --verbose .; else echo "gitleaks not installed; skipping (brew install gitleaks)"; fi

hooks:
	git config core.hooksPath .githooks && echo "git hooks enabled (.githooks/pre-commit runs gitleaks on staged changes)"

run:
	npm run dev
