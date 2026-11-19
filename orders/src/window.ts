// Turns the agent's samples into one Nimbus observation per closed window. Pure; tested in test/window.test.ts.

export interface Sample { at: number; visible: number; inFlight: number; dlq: number }
export interface Observation {
  windowStartedAt: string; windowEndedAt: string;
  visibleMessages: number; inFlightMessages: number; oldestMessageSeconds: number; dlqMessages: number;
  lambdaInvocations: number; lambdaErrors: number; lambdaThrottles: number;
}

/** The window [start, start + windowMs) that contains `at`, aligned to UTC multiples of the window. */
export const windowStart = (at: number, windowMs: number) => Math.floor(at / windowMs) * windowMs;

/**
 * SQS only publishes the age of the oldest message to CloudWatch, not through its API, so the agent
 * approximates it as how long the queue has continuously had visible messages (0 once it drains).
 */
export function backlogSince(previous: number | null, sample: Sample): number | null {
  if (sample.visible === 0) return null;
  return previous ?? sample.at;
}

/** Counters are cumulative and reset when the consumer restarts: a drop means "count from zero". */
export const counterDelta = (current: number, previous: number) => (current >= previous ? current - previous : current);

export function observe(start: number, windowMs: number, samples: Sample[], since: number | null, invocations: number, errors: number): Observation {
  const inWindow = samples.filter((s) => s.at >= start && s.at < start + windowMs);
  const max = (key: keyof Sample) => inWindow.reduce((m, s) => Math.max(m, s[key]), 0);
  const end = start + windowMs;
  return {
    windowStartedAt: new Date(start).toISOString(), windowEndedAt: new Date(end).toISOString(),
    visibleMessages: max('visible'), inFlightMessages: max('inFlight'), dlqMessages: max('dlq'),
    oldestMessageSeconds: since === null ? 0 : Math.max(0, Math.round((end - since) / 1000)),
    lambdaInvocations: invocations, lambdaErrors: errors, lambdaThrottles: 0,
  };
}
