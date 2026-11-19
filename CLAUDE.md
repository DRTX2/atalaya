# Atalaya (umbrella)

Runs Nimbus, Flagship, Hookrelay and Bitácora together. Their repos must be checked out next to this one (`../nimbus`, `../flagship`, `../hookrelay`, `../bitacora`). Contracts and failure modes: `docs/ARCHITECTURE.md`.

## Run and verify
```bash
docker compose up -d --build --wait   # includes bootstrap.mjs (tenant, API key, Bitácora subscription)
node demo.mjs                         # asserted end-to-end scenario; writes docs/demo-output.txt, docs/postmortem-example.md
docker compose down                   # always stop it afterwards
```
Run the demo after any change that crosses products: it caught bugs the per-repo suites could not (delivery time vs event time, stale API key after a partial reset).

Then the game days: `node chaos/run.mjs` (all) or `node chaos/run.mjs <name>`. Experiments are JSON in `chaos/experiments/`; faults go through Toxiproxy (`chaos/toxiproxy.json`, API on :8474); shared scenario code is `lib/atalaya.mjs` (also used by the demo). A failing experiment is a finding: fix the product, add a regression test in that repo, record it in `docs/GAME_DAYS.md`.

Console: `console/` (Next.js 16 BFF, :3100), sign-in through Keycloak (:8180, realm in `keycloak/`; `olivia`/`operator`, `victor`/`viewer`). `npm test` covers the pure parts (`lib/timeline.ts`, `lib/markdown.ts`, `lib/roles.ts`). Product access stays in `lib/api.ts` (server-only), auth in `lib/auth.ts`, actions in `app/actions.ts` (authorize, validate, audit). Never swallow Next's redirects in a catch: `settle()` uses `unstable_rethrow`.

Orders app (`orders/`): the protected workload; experiments 6–7 break it for real. Tracing: Jaeger :16686, trace ID = incident ID. AWS: `deploy/aws/atalaya-aws.sh` (plan by default; never run `up` without the user's explicit go-ahead: it costs money).

## Rules
- Products integrate only through signed, idempotent HTTP. Never share a database, queue or code between them.
- `bootstrap.mjs` must stay idempotent and repair only the side that lost its data (Flagship keeps its key; it re-reads `HOOKRELAY_API_KEY_FILE` on every publish).
- Healthchecks must test readiness, not "container started".
