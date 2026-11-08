# Deployment

[Русский](DEPLOYMENT.md) · [Home](README.en.md)

For local use, Docker Compose and the `.env` described in the README are enough.
A server also needs Linux, Git, Docker Compose, a domain and trusted HTTPS. Keep
`.env`, backups and release packages out of public repositories and web directories.

## Configuration

Copy `.env.example` to `.env` and run `chmod 600 .env`. Set separate random values
for `APP_SECRET` (at least 32 characters), `POSTGRES_PASSWORD` and
`REGISTRATION_PASSWORD`. Store them safely. Editing the password in `.env` does
not change the password of an existing PostgreSQL database; update both together.

`API_PORT` defaults to 18080 and binds to loopback. Set `OPENROUTER_API_KEY` for the
assistant; manual entry works without it. Set `OPENROUTER_MODEL` and
`AI_DAILY_BUDGET_USD` as needed. Do not set `APP_IMAGE` or `APP_VERSION` manually
when using the update scripts.

For host Nginx, including Hestia, set in `.env`:

```dotenv
COMPOSE_FILE=compose.yaml:deploy/compose.hestia.yaml
PUBLIC_URL=https://finance.example.org
API_PORT=18080
```

Configure DNS and TLS, point a dedicated domain to `127.0.0.1:18080`, and forward
`Host`, `X-Forwarded-Proto` and `X-Forwarded-For`. Hestia templates are in
`deploy/hestia/`: replace `__FINANCE_PORT__`, install the templates for a dedicated
domain, run `nginx -t` and reload Nginx. The override enables secure cookies and
proxy trust; do not expose the API directly to the Internet.

For a Docker proxy, use `deploy/compose.production.yaml` and `PROXY_NETWORK`.
Use a network dedicated to the proxy and Finance: the `api` alias may collide with
another application on a shared network.

## Updates

To deploy from a clean server Git checkout:

```sh
sh scripts/update.sh
docker compose exec -T api /finance healthcheck
```

The script builds an image, saves a checked PostgreSQL dump, runs migrations and
checks startup. Inspect `docker compose logs api` and verify external HTTPS, sign-in
and synchronization. On Windows, `scripts/Deploy.ps1 -Server user@host` builds a
release and sends it over SSH to an existing installation. The server must be
specified explicitly and both checkouts must share Git history.

`Build-Release.ps1` includes a `git bundle --all` containing all local refs and
history. Do not publish its archive without a separate inspection. A clean public
history cannot fast-forward an older checkout; moving an installation requires a
separate plan.

After currency data is added, older clients or application versions may not
understand the book. Do not roll back to one; use a compatible version. Save open
forms and finish recording audio before updating. Do not clear browser data to
force an update.

## Backups

After deploying with `scripts/update.sh`, create a checked server snapshot:

```sh
sh scripts/backup.sh
```

The script saves a dump, `.env`, revisions and checksums in `backups/`. These files
contain private data and secrets; keep an off-server copy and test restoration.
The script needs the running image's Git revision, so first deploy an image built
with plain `docker compose up --build` using `update.sh`. Redis is not backed up;
rate-limit counters reset. Changes not yet sent from phones are not in the server
backup: synchronize each device or download its local JSON backup.

For daily backups of an installation in `/opt/finance`:

```sh
install -d -m 700 /opt/finance/backups
install -m 644 deploy/finance-backup.service deploy/finance-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now finance-backup.timer
systemctl start finance-backup.service
```

Check `systemctl status finance-backup.service` and the off-server copy. See
[deploy/RESTORE.md](deploy/RESTORE.md) for Hestia setup and recovery. Restoring
onto a running server is a separate operation: save its current state first and
verify the selected dump before replacing data.
