import { zValidator as honoZValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import { z, type ZodSchema } from 'zod';
import { AppError } from '../lib/errors.js';

/**
 * A `true`/`false` query flag, parsed exactly.
 *
 * `z.coerce.boolean()` is `Boolean(value)`, so the string "false" became
 * `true`: the console's exercise library sent `archived=false` and was shown
 * only archived exercises, which is to say none. Anything other than the two
 * words is refused rather than guessed at.
 */
export const queryFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * A PATCH body has to change something. An empty one reached the database as
 * an update with no columns, which Drizzle refuses by throwing ("No values to
 * set"), so the caller saw a 500 instead of being told what was missing.
 */
export function changing<T extends z.AnyZodObject>(schema: T) {
  return schema.refine((value: Record<string, unknown>) => Object.values(value).some((field) => field !== undefined), {
    message: 'Send at least one field to change.',
  });
}

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
