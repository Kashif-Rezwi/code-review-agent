#!/bin/bash
# Vercel ignoreCommand for client — Root Directory is apps/client
# Exit 0 = skip build, 1 = build
# Production env: push to main  → Production deployment
# Preview env:    push to develop → Preview deployment
# Both support manual Redeploy from dashboard with no code changes.

# Manual redeploy (Dashboard → Redeploy → uncheck "Use existing Build Cache")
if [ "$VERCEL_FORCE_NO_BUILD_CACHE" = "1" ]; then
  exit 1
fi

# Redeploy of same commit (Vercel sets previous == current on dashboard Redeploy)
if [ -n "$VERCEL_GIT_PREVIOUS_SHA" ] && [ "$VERCEL_GIT_PREVIOUS_SHA" = "$VERCEL_GIT_COMMIT_SHA" ]; then
  exit 1
fi

# main → Production, develop → Preview (both always build, even if no client files changed)
if [ "$VERCEL_GIT_COMMIT_REF" = "main" ] || [ "$VERCEL_GIT_COMMIT_REF" = "develop" ]; then
  exit 1
fi

# Ignore all other branches (feature branches, PRs)
exit 0
