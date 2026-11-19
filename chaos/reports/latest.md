# Game day: 2026-11-19 04:01 UTC

| Experiment | Result | Hypothesis |
|---|---|---|
| `flagship-blip` | ✅ passed | Nimbus retries absorb a short Flagship outage (a deploy, a restart): the flag is still killed and on-call is still notified. |
| `hookrelay-slow` | ✅ passed | Mitigation does not wait for notification: the kill switch lands as fast as usual and the notification arrives late but intact. |
| `oncall-down` | ✅ passed | A dead customer endpoint never blocks the platform: deliveries retry, park in the DLQ, Bitácora is unaffected, and a replay delivers everything once the endpoint is back. |
| `bitacora-down` | ✅ passed | The learning step is never on the critical path: the incident is mitigated and recovered as usual, and after a DLQ replay Bitácora rebuilds the same, correctly ordered timeline from late, out-of-order deliveries. |
| `publish-path-down` | ✅ passed | A flag change is never lost: the kill still reaches Bitácora once Hookrelay is reachable again, so the postmortem shows the mitigation. |
| `orders-consumer-crash` | ✅ passed | Nimbus detects the stall from real queue metrics, the kill switch moves customers to the synchronous v1 checkout so no order fails, and everything is restored when the consumer is back. |
| `orders-flagship-db-down` | ✅ passed | Two failures at once: a database outage delays the kill switch but never breaks checkout. SDKs keep serving the last known rules, and Nimbus' retries land the kill once the database is back. |
| `flagship-unreachable` | ✅ passed | When automation cannot mitigate, it says so: after its ~90 s retry budget Nimbus escalates, on-call and Bitácora receive incident.escalated, and the postmortem records that a human had to act. |

## ✅ Flagship unreachable for 15 s while an incident opens

**Faults:** `nimbus-flagship` down from stall for 15 s

- ✅ `flagKilled` within 60 s: flag off 16297 ms after the incident's second degraded window
- ✅ `delivered` incident.opened → oncall within 30 s: incident.opened → oncall: delivered after 1 attempt(s)
- ✅ `flagRestored` within 30 s: flag back on 780 ms after recovery
- ✅ `timeline` within 60 s: Bitácora timeline: incident.opened → flag.killed → incident.recovered → flag.restored
- duration 20 s

## ✅ Every call from Nimbus to Hookrelay takes 3 extra seconds

**Faults:** `nimbus-hookrelay` latency 3000 ms from stall until end

- ✅ `flagKilled` within 5 s: flag off 711 ms after the incident's second degraded window
- ✅ `delivered` incident.opened → oncall within 40 s: incident.opened → oncall: delivered after 1 attempt(s)
- ✅ `flagRestored` within 10 s: flag back on 845 ms after recovery
- ✅ `delivered` incident.recovered → oncall within 40 s: incident.recovered → oncall: delivered after 1 attempt(s)
- duration 9 s

## ✅ The customer's on-call endpoint is down for the whole incident

**Faults:** `hookrelay-oncall` down from stall until end

- ✅ `flagKilled` within 10 s: flag off 990 ms after the incident's second degraded window
- ✅ `timeline` within 60 s: Bitácora timeline: incident.opened → flag.killed → incident.recovered → flag.restored
- ✅ `deadLettered` incident.recovered → oncall within 60 s: incident.recovered → oncall: in the DLQ after 4 attempts
- ✅ `delivered` incident.opened → oncall within 30 s: incident.opened → oncall: delivered after 5 attempt(s)
- ✅ `delivered` incident.recovered → oncall within 30 s: incident.recovered → oncall: delivered after 5 attempt(s)
- replayed 2 dead-lettered deliveries
- duration 27 s

## ✅ Bitácora is unreachable for the whole incident

**Faults:** `hookrelay-bitacora` down from stall until end

- ✅ `flagKilled` within 10 s: flag off 973 ms after the incident's second degraded window
- ✅ `delivered` incident.opened → oncall within 20 s: incident.opened → oncall: delivered after 1 attempt(s)
- ✅ `flagRestored` within 10 s: flag back on 863 ms after recovery
- ✅ `deadLettered` incident.recovered → bitacora within 60 s: incident.recovered → bitacora: in the DLQ after 4 attempts
- ✅ `timeline` within 60 s: Bitácora timeline: incident.opened → flag.killed → incident.recovered → flag.restored
- replayed 3 dead-lettered deliveries
- duration 28 s

## ✅ Flagship cannot reach Hookrelay for 10 s around the kill

**Faults:** `flagship-hookrelay` down from stall for 10 s

- ✅ `flagKilled` within 10 s: flag off 673 ms after the incident's second degraded window
- ✅ `timeline` within 60 s: Bitácora timeline: incident.opened → flag.killed → incident.recovered → flag.restored
- duration 20 s

## ✅ The real orders consumer crashes under customer traffic

**Faults:** `orders-consumer` stop from start until recover

- ✅ `incidentOpened` within 150 s: Nimbus opened consumer_stalled from real metrics 60 s after the fault
- ✅ `flagOff` within 15 s: Nimbus opened the incident 60 s after the fault; checkout-v2 OFF 1 s later
- ✅ `servedByV1` within 20 s: 3 orders served by the synchronous v1 path while v2 was off
- ✅ `ordersNeverFailed` within 5 s: 0 failed orders; 606 accepted since the fault
- ✅ `recovered` within 120 s: Nimbus recovered the incident 56 s after the fault was healed
- ✅ `flagRestored` within 130 s: checkout-v2 back ON 57 s after the fault was healed
- ✅ `queueDrained` within 60 s: orders queue drained to 0
- ✅ `ordersNeverFailed` within 5 s: 0 failed orders; 621 accepted since the fault
- ✅ `timeline` within 60 s: Bitácora timeline: incident.opened → flag.killed → incident.recovered → flag.restored
- duration 125 s

## ✅ Flagship's database goes down just as the kill switch is needed

**Faults:** `orders-consumer` stop from start until recover; `flagship-postgres` stop from start for 40 s

- ✅ `incidentOpened` within 150 s: Nimbus opened consumer_stalled from real metrics 55 s after the fault
- ✅ `flagOff` within 90 s: Nimbus opened the incident 55 s after the fault; checkout-v2 OFF 47 s later
- ✅ `ordersNeverFailed` within 5 s: 0 failed orders; 566 accepted since the fault
- ✅ `servedByV1` within 100 s: 1 orders served by the synchronous v1 path while v2 was off
- ✅ `recovered` within 120 s: Nimbus recovered the incident 38 s after the fault was healed
- ✅ `flagRestored` within 130 s: checkout-v2 back ON 39 s after the fault was healed
- ✅ `ordersNeverFailed` within 5 s: 0 failed orders; 1057 accepted since the fault
- ✅ `timeline` within 90 s: Bitácora timeline: incident.opened → flag.killed → incident.recovered → flag.restored
- duration 150 s

## ✅ Flagship is unreachable for the whole incident: the kill switch cannot be pulled

**Faults:** `nimbus-flagship` down from stall until end

- ✅ `delivered` incident.escalated → oncall within 150 s: incident.escalated → oncall: delivered after 1 attempt(s)
- ✅ `delivered` incident.escalated → bitacora within 170 s: incident.escalated → bitacora: delivered after 1 attempt(s)
- ✅ `timeline` within 170 s: Bitácora timeline: incident.opened → incident.escalated
- ✅ `timeline` within 60 s: Bitácora timeline: incident.opened → incident.escalated → incident.recovered
- ✅ `postmortemSays` within 10 s: postmortem says "escalated to on-call"
- duration 97 s
