// Local stand-in for the Lambda event source mapping: long-poll SQS, invoke the handler with the
// Lambda event shape, delete what succeeded. Exposes the Lambda-equivalent metrics on :9100.
import { createServer } from 'node:http';
import { DeleteMessageBatchCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { env, queueUrl, sqs } from './config.ts';
import { handler } from './handler.ts';
import { Counters } from './metrics.ts';

const metrics = new Counters({
  consumer_invocations_total: 'Handler invocations (one per non-empty batch), like AWS/Lambda Invocations',
  consumer_errors_total: 'Invocations that threw, like AWS/Lambda Errors',
  consumer_messages_total: 'Messages processed, by result',
});
createServer((req, res) => {
  if (req.url === '/metrics') return res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(metrics.render());
  res.writeHead(req.url === '/health' ? 200 : 404).end();
}).listen(9100);

const url = await queueUrl(env('ORDERS_QUEUE', 'orders'));
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });

while (!stopping) {
  try {
    const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 5, VisibilityTimeout: 30 }));
    if (!Messages.length) continue;
    metrics.inc('consumer_invocations_total');
    const { batchItemFailures } = await handler({ Records: Messages.map((m) => ({ messageId: m.MessageId!, body: m.Body ?? '' })) });
    const failed = new Set(batchItemFailures.map((f) => f.itemIdentifier));
    const done = Messages.filter((m) => !failed.has(m.MessageId!));
    if (done.length) await sqs.send(new DeleteMessageBatchCommand({ QueueUrl: url, Entries: done.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })) }));
    metrics.inc('consumer_messages_total', { result: 'processed' }, done.length);
    if (failed.size) metrics.inc('consumer_messages_total', { result: 'failed' }, failed.size);
  } catch (e) {
    metrics.inc('consumer_errors_total');
    console.error('consumer iteration failed:', (e as Error).message);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
process.exit(0);
