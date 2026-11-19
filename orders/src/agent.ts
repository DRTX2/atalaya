// Nimbus agent: samples the real queue and the consumer's metrics, and pushes one observation per
// window to Nimbus (push-mode pipeline, windowSeconds = WINDOW_SECONDS). In AWS, Nimbus reads the
// same metrics from CloudWatch instead (5-minute windows) and this agent is not needed.
import { readFileSync } from 'node:fs';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { env, queueUrl, sqs } from './config.ts';
import { counterTotal } from './metrics.ts';
import { backlogSince, counterDelta, observe, windowStart, type Sample } from './window.ts';

const windowMs = Number(env('WINDOW_SECONDS', '30')) * 1000;
const sampleMs = Number(env('SAMPLE_SECONDS', '5')) * 1000;
const nimbus = env('NIMBUS_URL');
const apiKey = env('NIMBUS_API_KEY');
const consumerMetrics = env('CONSUMER_METRICS_URL');
const { pipelineId } = JSON.parse(readFileSync(env('ORDERS_STATE', '/state/orders.json'), 'utf8'));
const [ordersUrl, dlqUrl] = await Promise.all([queueUrl(env('ORDERS_QUEUE', 'orders')), queueUrl(env('ORDERS_DLQ', 'orders-dlq'))]);

const depth = async (url: string) => {
  const { Attributes = {} } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
  return { visible: Number(Attributes.ApproximateNumberOfMessages ?? 0), inFlight: Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0) };
};
// An unreachable consumer reports nothing: that is exactly "no invocations".
const counters = async () => {
  try {
    const text = await (await fetch(consumerMetrics, { signal: AbortSignal.timeout(2000) })).text();
    return { invocations: counterTotal(text, 'consumer_invocations_total'), errors: counterTotal(text, 'consumer_errors_total') };
  } catch {
    return null;
  }
};

let samples: Sample[] = [];
let since: number | null = null;
let last = (await counters()) ?? { invocations: 0, errors: 0 };
let current = windowStart(Date.now(), windowMs);

for (;;) {
  await new Promise((r) => setTimeout(r, sampleMs - (Date.now() % sampleMs)));
  const now = Date.now();
  if (windowStart(now, windowMs) !== current) {
    const c = (await counters()) ?? last; // consumer down: counters unchanged, so 0 invocations this window
    const observation = observe(current, windowMs, samples, since, counterDelta(c.invocations, last.invocations), counterDelta(c.errors, last.errors));
    last = c;
    samples = samples.filter((s) => s.at >= current + windowMs);
    current = windowStart(now, windowMs);
    const res = await fetch(`${nimbus}/v1/pipelines/${pipelineId}/observations`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify(observation),
    }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }));
    console.log(JSON.stringify({ msg: 'observation', status: res.status, ...observation }));
    if (!res.ok) console.error('nimbus rejected the observation:', await res.text());
  }
  try {
    const [q, d] = await Promise.all([depth(ordersUrl), depth(dlqUrl)]);
    const sample = { at: now, visible: q.visible, inFlight: q.inFlight, dlq: d.visible };
    since = backlogSince(since, sample);
    samples.push(sample);
  } catch (e) {
    console.error('queue sample failed:', (e as Error).message);
  }
}
