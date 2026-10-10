# Degree of Comfort CRM

Lead → proposal → sign → pay → schedule for Degree of Comfort (Cincinnati). See [SPEC.md](SPEC.md) for the full
plan, [CLAUDE.md](CLAUDE.md) for how the code is organized, and [CHANGELOG.md](CHANGELOG.md) for what's built.

## Run locally

```bash
npm install
cp .env.example .env        # fill in AUTH_SECRET, DATA_ENCRYPTION_KEY, OWNER_EMAIL; E2E_AUTH=1 for local test login
npm run db:local            # terminal 1: local Postgres (keep running)
npx prisma migrate deploy && npm run seed
npm run dev                 # terminal 2: http://localhost:3000
```

## Test

```bash
npm run lint && npm run typecheck && npm test && npm run test:e2e
```
