# Game days

The failure-mode table in [ARCHITECTURE.md](ARCHITECTURE.md) used to be a list of claims. Each row is now an experiment that breaks something (a network link between products, a process, a database) and checks the claim against real product data. Eight experiments; they also run in CI ([`.github/workflows/game-day.yml`](../.github/workflows/game-day.yml)) on every push, on pull requests and weekly.

```bash
docker compose up -d --build --wait
node chaos/run.mjs                 # all experiments (~10 min); or: node chaos/run.mjs flagship-blip
docker compose down
```

## How an experiment works

Experiments are declarative JSON files in [`chaos/experiments/`](../chaos/experiments): what fails, how, when and for how long, plus the checks that make up the hypothesis.

- **Faults:** `down` and `latency` on a Toxiproxy link (`link`), or `stop` on a Docker Compose service (`service`: a crashed consumer, a database outage). `delaySeconds` injects part-way through, `seconds` heals on a timer, `until` heals at a phase.
- **Two scenarios.** *Fixture* (experiments 1–5, 8): a fresh flag, SDK stream, workflows and pipeline per run, with metrics pushed by the runner, so detection is instant and the experiment is about the response path. *Orders* (6–7): the fault hits the real protected app (k6 customers, SQS, a Lambda-style consumer) and Nimbus must detect it from the agent's real queue metrics.

1. **Steady state first.** All links clean and every product healthy, or the experiment is *aborted* instead of producing a misleading result.
2. **Fresh scenario.** A new flag, workflows and pipeline per experiment, so runs never interfere.
3. **Faults without touching the apps.** Every link between products goes through [Toxiproxy](https://github.com/Shopify/toxiproxy) (`chaos/toxiproxy.json`), which is transparent until an experiment disables a link or adds latency.
4. **Checks read real state:** the SDK's view of the flag, Hookrelay's delivery attempts and DLQ, Bitácora's timeline and postmortem.
5. **Always heal.** Links are reset in a `finally`, and an experiment that exceeds its time budget is aborted.
6. **Report** in `chaos/reports/latest.md`, plus one JSON file per run.

| Experiment | Link broken | Claim being tested |
|---|---|---|
| `flagship-blip` | Nimbus → Flagship down 15 s | A short Flagship outage doesn't stop mitigation or notification |
| `hookrelay-slow` | Nimbus → Hookrelay +3 s latency | Mitigation never waits for notification |
| `oncall-down` | Hookrelay → customer endpoint down | A dead customer endpoint never blocks the platform; DLQ + replay deliver everything |
| `bitacora-down` | Hookrelay → Bitácora down | Learning is off the critical path; a replay rebuilds the same ordered timeline |
| `publish-path-down` | Flagship → Hookrelay down 10 s | A flag change is never lost |

## Findings

The first game day (2026-11-18) passed **2 of 5**. Each failure was a real defect the per-repo test suites could not see, because each suite tests one product with its neighbours mocked.

### 1. A Flagship restart silently prevented mitigation (`flagship-blip`)
- **Observed:** the flag was never killed. The on-call team was notified (that step runs in parallel), so the incident looked handled.
- **Cause:** Nimbus' default step retry (3 attempts, 2 s backoff) gives up after ~6 s, shorter than a restart. When a step exhausts its retries Nimbus also cancels the steps still queued in that execution.
- **Fix:** the platform's response and recovery steps get an explicit ~90 s retry budget (8 attempts, 2→20 s backoff). Both steps are idempotent, so retrying longer is safe (`lib/atalaya.mjs`, `RESPONSE_RETRY`).
- **After:** passes. Mitigation lands about one second after the outage ends (16 s for a 15 s outage). Worth knowing: during a dependency outage, time to mitigate equals the outage.

### 2. A flag change was lost when Hookrelay was briefly unreachable (`publish-path-down`)
- **Observed:** Bitácora's timeline had no `flag.killed`, so the postmortem said nothing was mitigated.
- **Cause:** Flagship published to Hookrelay fire-and-forget (one attempt, 3 s timeout, after COMMIT).
- **Fix:** a transactional outbox in Flagship. The event is written in the same transaction as the flag change. A dispatcher on every replica claims due rows (`FOR UPDATE SKIP LOCKED` + lease), retries with exponential backoff, and parks a poison event after 25 attempts. The idempotency key keeps the effect exactly-once. Backlog size and age are exported as metrics. ([Flagship ADR-0007](https://github.com/DRTX2/flagship/blob/main/docs/adr/0007-transactional-outbox.md))
- **After:** passes. Covered by a Flagship integration test: the event waits during an outage and is delivered exactly once when Hookrelay returns.

### 3. Bitácora dropped a restore that arrived before its kill (`bitacora-down`)
- **Observed:** after the DLQ replay the timeline was missing `flag.restored`.
- **Cause:** a replay delivers in any order. A restore that arrived before the kill found no incident to link to and was dropped. Its ADR claimed order independence, which held for kill-before-incident but not for restore-before-kill.
- **Fix:** Bitácora keeps every change in a per-flag history. A kill adopts the follow-ups that arrived first (up to the next kill), and a follow-up links to the latest kill before it once that kill exists. ([Bitácora ADR-0002](https://github.com/DRTX2/bitacora/blob/main/docs/adr/0002-idempotency-and-ordering.md))
- **After:** passes. Covered by integration tests for restore- and manual-change-before-kill, and for two incidents on the same flag.

### 4. Flagship crashed when its database dropped connections (`orders-flagship-db-down`)
- **Observed:** after a 40 s database outage Flagship's process was gone; the kill switch never landed.
- **Cause:** the `pg` pool emits `error` when an idle client loses its connection. With no listener, Node treats it as an unhandled error and exits. Hookrelay had the same bug.
- **Fix:** both pools log the event and carry on (`pg` already discards the broken client). Regression tests terminate every backend connection mid-suite and assert the processes survive; without the fix they fail.

### 5. After a failover, SDKs stopped receiving flag changes (`orders-flagship-db-down`)
- **Observed:** the flag was turned off in Flagship, but the orders service kept routing to v2.
- **Cause:** the LISTEN connection that fans changes out to SDK streams retried once after 1 s. A failover lasts longer, so that replica silently stopped pushing changes forever.
- **Fix:** reconnect with exponential backoff (capped at 10 s: a kill switch must not stay stale), resync SDKs on reconnect, and a `flagship_listen_connected` gauge to alert on. Regression test: refuse connections for 3.5 s, then check an SDK on the other replica still sees a change.

### 6. Our own tooling revoked a production SDK key (`orders-*`)
- **Observed:** after an unrelated Flagship restart, the orders SDK logged `invalid SDK key, giving up` and served the fallback.
- **Cause:** every fixture scenario asked Flagship for a production SDK key, which **rotates** it. Open streams kept working, so nothing broke until the orders service reconnected with its now-revoked key.
- **Fix:** scenarios reuse the environment's key. Lesson kept: test tooling runs against the same credentials as the system it tests.

### 7. "Zero failed orders" was measured on the wrong side (`orders-consumer-crash`)
- **Observed:** an experiment found no incident at all.
- **Cause:** the orders service had restarted with a new IP and k6 kept the cached one: customers got `connection refused` while the server counted zero failures.
- **Fix:** k6 resolves DNS on every request, and the steady-state check now requires live customer traffic before anything is broken (otherwise the experiment aborts instead of passing or failing for the wrong reason).

### Escalation (`flagship-unreachable`, new behavior)
When Flagship stays down past the ~90 s retry budget, mitigation fails. Before, nothing happened next. Now Nimbus marks the incident escalated and runs the pipeline's escalation workflow, which only notifies (it must not depend on what failed): on-call receives `incident.escalated`, Bitácora's timeline shows it and the postmortem says a human had to act.

## Latest result

See [`chaos/reports/latest.md`](../chaos/reports/latest.md): **8 of 8 passed**. The first game day passed 2 of 5; the second (real app, process and database faults) found four more defects.

## Known limits
- Disk, clock and CPU faults are not modelled; process faults are clean stops, not `SIGKILL` mid-write.
- Experiments run sequentially against a local or CI stack; there is no approval workflow for a shared environment.
- Orders experiments take ~2 min each because detection needs two 30 s windows; fixture experiments trade that realism for speed.
