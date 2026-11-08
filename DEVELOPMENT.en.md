# Development

[Русский](DEVELOPMENT.md) · [Home](README.en.md)

Install the Go version in `go.mod`, Node.js 24, Docker and Compose v2. Run commands
from the repository root. See [DEPLOYMENT.en.md](DEPLOYMENT.en.md) for configuration.

## Client and server

```sh
npm ci
npm run build
```

Vite builds React into `backend/react-web/dist/`; Go embeds the result in the
binary. Docker builds the client automatically. Without dist, the server can still
serve the API and shared modules, but returns 503 for HTML and the Service Worker.

For UI development, start a test API at `http://127.0.0.1:18080`, then run:

```sh
npm run dev
```

Open the URL printed by Vite. It proxies API requests and shared browser modules
to the Go server; set `VITE_API_TARGET` to use another API address. React components
are in `frontend/src/`. `backend/web/` contains the single shared model, IndexedDB,
sync and Service Worker modules used by React and the server.

## Tests

```sh
npm run format:check
npm test
npm run build
go vet ./...
go test ./...
npx playwright install chromium webkit
npm run test:e2e
```

`npm run format` formats the React code. Browser tests need a separate test API at
`http://localhost:18080`, or the address in `TEST_URL`. Set
`TEST_REGISTRATION_PASSWORD` to the test API's registration password. Do not run
these tests against a working installation.

Without `TEST_DATABASE_URL` and `TEST_REDIS_URL`, some Go integration tests are
skipped. PostgreSQL tests create and drop a separate schema; Redis tests use database
15 and remove test keys. Use isolated services, not production.
`deploy/compose.test.yaml` exposes test ports 15432 and 16379 on loopback when
attached to a separate Compose project. Use `go test -race ./...` in an environment
with race detector support.

## Data and compatibility

IndexedDB stores a confirmed snapshot and a command queue applied on top of it.
Do not rewrite commands under existing UUIDs: the server uses their content to
make retries safe. Invalid or conflicting changes remain on the device. Old data
without a currency means RUB; totals in different currencies are not combined.

The server stores books as PostgreSQL JSONB and checks membership and versions
under a lock. New clients declare data version 4; incompatible clients receive 426
without losing their queues. JSON backups v4 include data, the queue and chat;
legacy RUB backups are supported. Test API and format changes against old queues
and backups too. Do not edit already-applied SQL migrations.

Use fabricated data for browser and backup tests. WebKit testing does not replace
testing Safari on a real iPhone.
