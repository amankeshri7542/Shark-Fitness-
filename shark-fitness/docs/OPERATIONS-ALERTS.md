# Operations alerts

What should wake somebody up, how each condition is detected, and where the alert goes. Written for the one-server pilot in [PILOT-HOSTING.md](PILOT-HOSTING.md) (UptimeRobot, healthchecks.io, ntfy), with the Prometheus rules to use once a metrics scraper exists. No alert account, DSN project or scraper has been created; every value below that names one is a placeholder.

## The signals the app gives you

| Signal | Where | Configured by |
| --- | --- | --- |
| `/health` | Liveness: the process answers. Cheap, no database. | always on |
| `/ready` | Readiness: database reachable, schema current, `release` = deployed commit. 503 otherwise. | always on |
| Error reports | One report per unexpected server error, scheduler job failure, unhandled rejection, uncaught exception (production exits and Docker restarts it) and browser crash (`POST /v1/client-errors`, `source=admin` or `member`). Redacted: type, message, stack frames, release, environment, request id, route template, tenant and actor ids. Never bodies, cookies, contact fields. | `SHARK_ERROR_REPORTER` (`auto` by default): `SHARK_ERROR_DSN` → Sentry protocol; else `SHARK_ERROR_REPORTING_ENDPOINT` → JSON POST (ntfy); else console in development, nothing in production. Capped per process at 60 server reports a minute and, separately, 60 browser reports a minute, so a flood of browser reports cannot crowd out server errors. |
| `GET /metrics` | Prometheus text format: `http_requests_total{method,route,status}`, `http_request_duration_seconds` (histogram), `job_runs_total{job,outcome}`, `job_last_success_timestamp_seconds{job}`, `outbox_undelivered_events`, `sqlite_db_size_bytes`, `data_filesystem_size_bytes`, `data_filesystem_avail_bytes`, process CPU and memory, `app_build_info{release}`. Labels never carry ids or personal data: `route` is the route template. | `SHARK_METRICS_TOKEN` (at least 32 characters in production). Unset, `/metrics` is a 404. Scrapers send `Authorization: Bearer <token>`. |
| Backup pings | `backup.sh nightly` pings `/start`, then success or `/fail` (including a failed off-site upload). | `SHARK_BACKUP_PING_URL` |
| Logs | One JSON line per request and per job run, on stdout; `docker compose logs app`. | always on |

The boot log line `api_listening` names the active error reporter (`errorReporter`) and whether metrics are on, so a deploy shows what it will alert through.

## Alert rules

| # | Condition | Severity | Pilot (free, no scraper) | With a Prometheus scraper |
| --- | --- | --- | --- | --- |
| A1 | `/ready` fails for 5 minutes (app down, database unreachable, migration failed) | page | UptimeRobot keyword monitor on `https://<domain>/ready` for `"status":"ready"`, 5-minute interval, email + mobile push | `SharkNotReady` (blackbox probe) and `SharkScrapeDown` |
| A2 | 5xx responses above 2 % of traffic and at least 3 a minute, for 10 minutes | page | Each 5xx is an error report: ntfy notification per error, or a Sentry alert rule "more than 10 events in 5 minutes" | `SharkHigh5xxRate` |
| A3 | Any unexpected server or browser error | notify | ntfy notification per report; in Sentry, an alert on every *new issue* | — (error reports, not metrics) |
| A4 | A scheduled job failed twice in an hour | notify | Each failure is an error report tagged `job=<name>`; also visible in the console's platform health | `SharkJobFailing` |
| A5 | A scheduled job has not succeeded for twice its interval (stale scheduler, stuck process) | page | Not detectable without a scraper; check platform health weekly | `SharkJobStale` |
| A6 | Nightly backup missed, failed, or its off-site upload failed | page | healthchecks.io check: period 1 day, grace 1 hour. `/fail` emails at once; silence emails after the grace | — (healthchecks.io stays the source) |
| A7 | Disk holding the database over 80 % full for 15 minutes | page | DigitalOcean Monitoring (free): tick **Monitoring** when creating the droplet, then an alert policy "Disk Utilization above 80 % for 15 minutes" | `SharkDiskAlmostFull` |
| A8 | Memory above 75 % of a 1 GiB droplet for 15 minutes | notify | DigitalOcean Monitoring alert policy "Memory Utilization above 75 %" | `SharkMemoryHigh` |
| A9 | Realtime events stuck undelivered for 30 minutes | notify | — | `SharkOutboxStuck` |

*Page* means a phone notification that someone acts on the same day; *notify* means look within a working day. For the pilot, everything goes to the owner's phone (UptimeRobot app, healthchecks.io email, ntfy app). The ntfy topic must be long and random (`openssl rand -hex 16`): anyone who knows it can read it.

### What to do when one fires

- **A1** — `docker compose ps` and `docker compose logs --tail 100 app` in `/srv/shark-fitness/src/deploy/pilot`. A failed migration after a deploy: roll back (PILOT-HOSTING §11). A full disk: A7.
- **A2/A3** — open the report; its `request_id` is the `x-request-id` the browser saw and the `requestId` in the JSON log line, so `docker compose logs app | grep <id>` gives the request. A browser report's reference (`ERR-XXXX-XXXX`) is what the person sees on the recovery screen, so a front-desk complaint can be matched to it.
- **A4/A5** — the console's Platform → Health lists recent job runs with their error category. `job_runs` keeps the history.
- **A6** — `journalctl -u shark-backup -n 100`. An off-site failure says `offsite=failed`; every local copy is kept until an upload succeeds, so fix the remote or its credentials (`sudo rclone config`), then `backup.sh manual`.
- **A7** — `du -sh /srv/shark-fitness/{data,backups}/*` and `docker system df`. Lower `SHARK_BACKUP_KEEP_DAYS` or prune old images with `docker image prune -a` (keep the current and previous commit).

## Prometheus rules

For a scraper such as Grafana Alloy shipping to Grafana Cloud's free tier, or a self-hosted Prometheus. Scrape `https://<domain>/metrics` every 60 s with the bearer token, as job `shark-fitness`; probe `/ready` with the blackbox exporter as job `shark-ready`.

```yaml
# Scrape config (Prometheus syntax; Alloy's prometheus.scrape takes the same fields)
scrape_configs:
  - job_name: shark-fitness
    scheme: https
    metrics_path: /metrics
    scrape_interval: 60s
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/shark-metrics-token   # the SHARK_METRICS_TOKEN value
    static_configs:
      - targets: ['pilot.example.com']
```

```yaml
groups:
  - name: shark-fitness
    rules:
      - alert: SharkScrapeDown
        expr: up{job="shark-fitness"} == 0
        for: 5m
        labels: { severity: page }
        annotations: { summary: "Shark Fitness /metrics has not answered for 5 minutes" }

      - alert: SharkNotReady
        expr: probe_success{job="shark-ready"} == 0
        for: 5m
        labels: { severity: page }
        annotations: { summary: "/ready is failing" }

      - alert: SharkHigh5xxRate
        expr: |
          sum(rate(http_requests_total{job="shark-fitness",status=~"5.."}[5m]))
            / clamp_min(sum(rate(http_requests_total{job="shark-fitness"}[5m])), 1e-9) > 0.02
          and sum(rate(http_requests_total{job="shark-fitness",status=~"5.."}[5m])) * 60 >= 3
        for: 10m
        labels: { severity: page }
        annotations: { summary: "More than 2% of requests are failing with 5xx" }

      - alert: SharkSlowRequests
        expr: |
          histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job="shark-fitness"}[10m]))) > 1
        for: 15m
        labels: { severity: notify }
        annotations: { summary: "p95 request time above 1 s" }

      - alert: SharkJobFailing
        expr: increase(job_runs_total{job="shark-fitness",outcome="failure"}[1h]) >= 2
        labels: { severity: notify }
        annotations: { summary: "Scheduled job {{ $labels.exported_job }} failed at least twice in an hour" }

      # Twice each job's interval (apps/api/src/jobs/scheduler.ts). The app's
      # `job` label (the scheduled job's name) collides with the scrape job's
      # `job` label, so Prometheus stores it as `exported_job`.
      - alert: SharkJobStale
        expr: |
          (time() - job_last_success_timestamp_seconds{exported_job=~"deliver-automation-queue|expire-waitlist-offers|release-expired-holds"} > 2 * 60)
          or (time() - job_last_success_timestamp_seconds{exported_job="run-dunning"} > 2 * 15 * 60)
          or (time() - job_last_success_timestamp_seconds{exported_job="close-stale-check-ins"} > 2 * 30 * 60)
          or (time() - job_last_success_timestamp_seconds{exported_job="run-automations"} > 2 * 3600)
          or (time() - job_last_success_timestamp_seconds{exported_job=~"expire-memberships|roll-up-metrics|extend-class-series"} > 2 * 6 * 3600)
          or (time() - job_last_success_timestamp_seconds{exported_job="prune-operational-data"} > 2 * 86400)
        for: 10m
        labels: { severity: page }
        annotations: { summary: "Job {{ $labels.exported_job }} has not succeeded for twice its interval" }

      - alert: SharkDiskAlmostFull
        expr: 1 - data_filesystem_avail_bytes{job="shark-fitness"} / data_filesystem_size_bytes{job="shark-fitness"} > 0.80
        for: 15m
        labels: { severity: page }
        annotations: { summary: "The database disk is over 80% full" }

      - alert: SharkMemoryHigh
        expr: process_resident_memory_bytes{job="shark-fitness"} > 0.75 * 1024 * 1024 * 1024
        for: 15m
        labels: { severity: notify }
        annotations: { summary: "The API process uses more than 75% of a 1 GiB droplet" }

      - alert: SharkOutboxStuck
        expr: outbox_undelivered_events{job="shark-fitness"} > 50
        for: 30m
        labels: { severity: notify }
        annotations: { summary: "Realtime events are not being fanned out" }
```

`job_runs_total` counts runs since the process started, so it resets on every deploy; `increase()` handles that. `job_last_success_timestamp_seconds` and the database gauges are read from SQLite at scrape time, so they survive restarts.

## Testing each channel

| Channel | Test |
| --- | --- |
| UptimeRobot | `docker compose stop app`, wait for the alert (5–10 minutes), `docker compose start app`, wait for recovery. |
| healthchecks.io | `systemctl start shark-backup`; the check turns green. Set a wrong `SHARK_BACKUP_OFFSITE_REMOTE` and run `backup.sh nightly`: it pings `/fail`. Put the right value back. |
| ntfy | `curl -d "Shark pilot test" https://ntfy.sh/<topic>` from the server. |
| Sentry-compatible DSN | Open the member app, run `dispatchEvent(new ErrorEvent('error', { error: new Error('alert test') }))` in the browser console, and the report arrives with `source=member`. |
| `/metrics` | `curl -fsS -H "Authorization: Bearer $SHARK_METRICS_TOKEN" https://<domain>/metrics \| head` on the server. Without the header it answers 401. |
