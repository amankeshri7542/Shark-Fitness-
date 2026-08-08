# Free preview deployment

The repository includes a root `Dockerfile` that builds both React applications and serves them from the Hono API under one origin:

- member app: `/`
- admin console: `/admin/`
- API: `/v1/*`
- health check: `/health`

Keeping everything on one origin avoids third-party-cookie and cross-origin WebSocket problems.

## Koyeb preview

1. Create a Web Service from this GitHub repository.
2. Choose the repository root as the build context and use the root `Dockerfile`.
3. Expose the platform-provided `PORT`; the app reads it automatically.
4. Choose the Free instance.
5. Set these secrets and variables:

```text
NODE_ENV=production
SHARK_PUBLIC_ORIGIN=https://YOUR-SERVICE.koyeb.app
SHARK_ALLOWED_ORIGINS=https://YOUR-SERVICE.koyeb.app
SHARK_PASS_SECRET=<at least 48 random bytes>
SHARK_READER_KEYS_JSON={}
SHARK_ECHO_OTP=false
SHARK_ALLOW_BEARER_AUTH=false
```

6. Set the health-check path to `/health`.
7. Deploy, then open `/` for the member app and `/admin/` for staff.

The container creates, migrates and seeds SQLite only when its database file does not exist.

## Important limitation

This is a disposable demo deployment. Free instances do not provide durable attached storage for the local SQLite file. A restart, replacement or scale-to-zero cycle can recreate the seeded database and erase changes. Do not onboard real gyms, accept real payments, store health data, or treat this deployment as a backup.

Before selling the product, move the database and realtime layer to durable managed infrastructure, add an OTP delivery provider, provision physical reader identities, and complete the remaining security and operational review.
