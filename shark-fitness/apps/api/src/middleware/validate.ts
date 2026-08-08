import { zValidator as honoZValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { ZodSchema } from 'zod';
import { AppError } from '../lib/errors.js';

/**
 * `zValidator` with our error envelope.
 *
 * The stock validator answers with Zod's own `{success:false, error:{issues}}`
 * shape and returns before `app.onError` ever runs, so a validation failure
 * was the one response in the API that did not match the documented envelope
 * (Engineering PRD §9.2). This wrapper throws an AppError instead, which the
 * central handler then formats like everything else.
 *
 * Use this everywhere. Importing `zValidator` from `@hono/zod-validator`
 * directly in a route file is a bug.
 */
export function validate<T extends ZodSchema, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) {
  return honoZValidator(target, schema, (result) => {
    if (result.success) return;

    const fields = result.error.errors.map((issue) => ({
      path: issue.path.join('.') || target,
      code: issue.code,
      message: issue.message,
    }));

    throw new AppError('VALIDATION_FAILED', friendlyMessage(fields), { fields });
  });
}

/** One clear sentence for the banner; the per-field detail sits in `fields`. */
function friendlyMessage(fields: Array<{ path: string; message: string }>): string {
  if (fields.length === 1 && fields[0]) {
    const { path, message } = fields[0];
    return path ? `${humanise(path)}: ${lowerFirst(message)}` : message;
  }
  return 'Some of those details need another look.';
}

function humanise(path: string): string {
  const last = path.split('.').pop() ?? path;
  const spaced = last.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
