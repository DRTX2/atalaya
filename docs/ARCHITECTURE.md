# Atalaya architecture

## Shape

```mermaid
flowchart LR
  subgraph Nimbus[Nimbus · Go]
    D[Detectors over SQS/Lambda/DLQ windows] --> I[Incidents] --> W[Workflow engine<br/>Postgres leases, outbox]
  end
  subgraph Flagship[Flagship · NestJS + Angular]
    A[Automation endpoint] --> FS[Flag service<br/>version, audit, pg_notify] --> SSE[SSE fan-out]
  end
  subgraph Hookrelay[Hookrelay · NestJS + Next.js]
    IN[Inbound endpoint] --> ING[Ingest: message + deliveries in 1 tx] --> Q[BullMQ workers]
  end
  W -- "signed HTTP step" --> A
  W -- "signed HTTP step" --> IN
  FS -. "flag.* events" .-> ING
  SSE --> SDK[SDKs in customer services]
  Q --> EXT[Customer endpoints]
  subgraph Bitacora[Bitácora · Lambda + DynamoDB]
    BI[ingest λ] --> BT[(timeline, metrics)] --> BP[postmortem]
  end
  Q -- "Standard Webhooks" --> BI
```

Four codebases, three PostgreSQL databases (plus Redis for Hookrelay) and one DynamoDB table, one Docker network in `compose.yaml`. Nothing is shared except a signing secret; `bootstrap.mjs` does the one-time wiring an operator would do (tenant, API key, subscription).

## Integration contracts

### Nimbus → Flagship: `POST /automation/nimbus/flags/{key}/envs/{env}`
- Body: the Nimbus incident event (`incidentId`, `event: opened|recovered`, `pipelineName`, `summary`, …).
- Auth: `Nimbus-Signature: t=<unix>,v1=<hex>` = HMAC-SHA256(`NIMBUS_WEBHOOK_SECRET`, `<unix>.<raw body>`). Rejected outside ±300 s. Several `v1` values allow secret rotation.
- `opened`: if the flag is on, turn it off through the normal write path (validation, version bump, audit entry `killed by nimbus incident <id>`, `pg_notify`, SSE). Already off → no-op.
- `recovered`: restore the configuration from before that kill **only if the latest audit entry is still that kill**. Otherwise no-op.
- Always `200` with `{ changed, action | reason }`, so a workflow step succeeds on replays.

### Nimbus → Hookrelay: `POST /v1/inbound/nimbus/{appId}`
- Same signature scheme. The incident becomes a message `incident.opened` / `incident.recovered` for that tenant.
- Idempotency key `nimbus:<incidentId>:<event>`: a replayed step returns the original message and schedules nothing.
- From there it's ordinary Hookrelay delivery: per-endpoint Standard Webhooks signature, retries with backoff, circuit breaker, DLQ, replay.

### Flagship → Hookrelay (optional): `POST /v1/messages`
- After each committed flag change: `flag.created | flag.updated | flag.archived`, bearer API key, idempotency key `flagship:<type>:<flag>:<env>:<version>`.
- Fire-and-forget after COMMIT with a 3 s timeout. Never blocks or fails a flag change.

### Hookrelay → Bitácora: `POST /webhooks/hookrelay/{sourceId}`
- An ordinary Hookrelay endpoint subscribed to `incident.*` and `flag.*`. Bitácora verifies the Standard Webhooks signature (5-minute replay window) and deduplicates by `webhook-id`.
- Correlation: Flagship's kill audit text `killed by nimbus incident <id>` with actor `nimbus (automation)` links the flag to the incident; the automation's `rolled back to #…` on that flag is the restore; anyone else's change during the incident is recorded as manual.
- Incident times come from Nimbus' `occurredAt` (the notify step runs after the flag step, so delivery time would put "opened" after "mitigated").
- Order-independent and idempotent: a kill that arrives before its incident, or a redelivery, produces the same timeline.

## Failure modes

| Failure | What happens |
|---|---|
| Flagship down when the incident opens | The Nimbus step fails as retryable and is retried with backoff (attempts are visible in the run). The Hookrelay notification is a separate step and still goes out |
| Hookrelay down | The notify step retries. The kill switch is unaffected |
| Nimbus retries a step that already succeeded | Flagship answers `changed: false`; Hookrelay answers `duplicate: true`. No double effects |
| An engineer edits the flag during the incident | On recovery Flagship leaves it alone and says why |
| Customer endpoint down | Hookrelay retries, then parks the delivery in the DLQ for replay |
| Bitácora down or throttled | Hookrelay retries its deliveries like any endpoint (DLQ + replay after that). Nothing else is affected |
| Bitácora loses its data (local DynamoDB recreated) | `bootstrap.mjs` reconnects a new source to the same tenant, so Flagship keeps its key |
| Signing secret leaked | Rotate: all three accept a previous secret during the overlap (`v1` list / `NIMBUS_WEBHOOK_PREVIOUS_SECRET`) |
| Forged or replayed request | 401: bad signature or timestamp outside the window |

## Why not merge them
- Different problems, data models and scaling profiles: Hookrelay is write-heavy and queue-driven, Flagship is read-mostly with long-lived streams, Nimbus is a scheduler and state machine.
- Different stacks on purpose (Go for Nimbus, TypeScript for the other two): integration through contracts is what makes that a non-issue.
- A merged codebase would turn three clear products into one unclear one, and every release would become a coordinated release.

## Running in AWS
Each product deploys on its own (ECS Fargate + RDS for Hookrelay, Flagship and Nimbus; Lambda + DynamoDB for Bitácora; Terraform in each repo). To connect them, expose the two automation endpoints through each product's ALB, set the same `NIMBUS_WEBHOOK_SECRET` in the three secret stores, and add the Flagship and Hookrelay hostnames to Nimbus' `NIMBUS_OUTBOUND_ALLOWED_HOSTS`.
