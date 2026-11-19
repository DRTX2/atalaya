# Postmortem: Queue backlog is aging while the Lambda consumer has no invocations

- **Incident:** 4d7d8775-21a3-4d69-9834-3096dcb349bc
- **Pipeline:** Orders async pipeline mwmz936jig6
- **Detector:** consumer_stalled · **Severity:** critical
- **Status:** recovered
- **Impact window:** 2026-11-19 03:15:11 UTC → 2026-11-19 03:15:12 UTC

## Response

| Step | Time |
|---|---|
| Opened → mitigated (flag off) | 661 ms |
| Opened → recovered | 1.1 s |
| Recovered → flag restored | 587 ms |

## Timeline

| Time | Event | Actor |
|---|---|---|
| 2026-11-19 03:15:11 UTC | Incident opened: Queue backlog is aging while the Lambda consumer has no invocations | nimbus |
| 2026-11-19 03:15:12 UTC | orders-v2-mwmz936jig6@production turned off (kill switch) | nimbus (automation) |
| 2026-11-19 03:15:12 UTC | Pipeline healthy again: incident recovered | nimbus |
| 2026-11-19 03:15:13 UTC | orders-v2-mwmz936jig6@production restored to its pre-incident configuration | nimbus (automation) |

## Observations

- Automation turned off orders-v2-mwmz936jig6@production 661 ms after the incident opened.

## Follow-ups

- [ ] Root cause of `consumer_stalled` on Orders async pipeline mwmz936jig6
- [ ] Were detection thresholds right? (degraded windows before opening)
- [ ] Should anything else be behind a kill switch?
