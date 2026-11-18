# Postmortem: Queue backlog is aging while the Lambda consumer has no invocations

- **Incident:** c31785b5-0b6a-41a5-8045-401c1e248da8
- **Pipeline:** Orders async pipeline mwlhfong
- **Detector:** consumer_stalled · **Severity:** critical
- **Status:** recovered
- **Impact window:** 2026-11-18 02:08:40 UTC → 2026-11-18 02:08:41 UTC

## Response

| Step | Time |
|---|---|
| Opened → mitigated (flag off) | 677 ms |
| Opened → recovered | 1.1 s |
| Recovered → flag restored | 608 ms |

## Timeline

| Time | Event | Actor |
|---|---|---|
| 2026-11-18 02:08:40 UTC | Incident opened: Queue backlog is aging while the Lambda consumer has no invocations | nimbus |
| 2026-11-18 02:08:41 UTC | orders-v2-mwlhfong@production turned off (kill switch) | nimbus (automation) |
| 2026-11-18 02:08:41 UTC | Pipeline healthy again: incident recovered | nimbus |
| 2026-11-18 02:08:42 UTC | orders-v2-mwlhfong@production restored to its pre-incident configuration | nimbus (automation) |

## Observations

- Automation turned off orders-v2-mwlhfong@production 677 ms after the incident opened.

## Follow-ups

- [ ] Root cause of `consumer_stalled` on Orders async pipeline mwlhfong
- [ ] Were detection thresholds right? (degraded windows before opening)
- [ ] Should anything else be behind a kill switch?
