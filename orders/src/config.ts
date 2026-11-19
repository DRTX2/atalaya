import { readFileSync } from 'node:fs';
import { SQSClient, GetQueueUrlCommand } from '@aws-sdk/client-sqs';

export const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
};

/** A secret from NAME or from the file NAME_FILE (Docker secrets convention). */
export const secret = (name: string): string => process.env[name] ?? readFileSync(env(`${name}_FILE`), 'utf8').trim();

// Local: an SQS-compatible endpoint (ElasticMQ). In AWS: leave SQS_ENDPOINT unset and use real SQS.
export const sqs = new SQSClient({
  region: env('AWS_REGION', 'us-east-1'),
  ...(process.env.SQS_ENDPOINT ? { endpoint: process.env.SQS_ENDPOINT, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
});

export async function queueUrl(name: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
    } catch (e) {
      if (attempt >= 30) throw e;
      await new Promise((r) => setTimeout(r, 1000)); // the queue service may still be starting
    }
  }
}
