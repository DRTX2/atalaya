'use client';
import { useActionState } from 'react';
import type { ActionResult } from './actions';

/** A server action behind a button, with its result announced in place. */
export function ActionButton({ action, label, disabled, title, tone }: { action: (prev: ActionResult) => Promise<ActionResult>; label: string; disabled?: boolean; title?: string; tone?: 'danger' }) {
  const [result, run, pending] = useActionState(action, null);
  return (
    <form action={run} className="action">
      <button type="submit" className={`button${tone ? ` ${tone}` : ''}`} disabled={disabled || pending} title={title}>{pending ? 'Working…' : label}</button>
      <span role="status" className={result ? (result.ok ? 'ok' : 'bad') : undefined}>{result?.message}</span>
    </form>
  );
}
