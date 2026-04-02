# Code Review Agent — Server

This is the NestJS backend for Code Review Agent.

> For full documentation, see the [project README](../../README.md) and the [`docs/`](../../docs/) directory.

### Quick start (standalone)

```bash
cp .env.example .env
# fill in .env

npx prisma migrate deploy
pnpm start:dev
```

API runs at `http://localhost:4000` by default.
