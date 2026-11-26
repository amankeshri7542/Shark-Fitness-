import { appendFileSync } from 'node:fs';

/**
 * Route coverage (P08). When SHARK_ROUTE_COVERAGE_LOG names a file, every
 * request the integration suite sends through the app (`app.request`, or a
 * real server built on `app.fetch`) is appended to it as one JSON line:
 * method, path, status and, for refusals, the error code and message.
 * `scripts/route-coverage.ts` resolves those requests to registered routes.
 *
 * Off by default, so ordinary `pnpm test` runs import nothing extra.
 */
const log = process.env.SHARK_ROUTE_COVERAGE_LOG;

if (log) {
  const { app } = await import('../../app.js');
  const original = app.fetch;
  const record = async (request: Request, response: Response): Promise<void> => {
    let code: string | undefined;
    let message: string | undefined;
    if (response.status >= 400 && (response.headers.get('content-type') ?? '').includes('json')) {
      try {
        const body = (await response.clone().json()) as { error?: { code?: string; message?: string } };
        code = body.error?.code;
        message = body.error?.message;
      } catch {
        /* not JSON after all */
      }
    }
    const line = { method: request.method, path: new URL(request.url).pathname, status: response.status, code, message };
    appendFileSync(log, `${JSON.stringify(line)}\n`);
  };
  app.fetch = (request: Request, ...rest: unknown[]) => {
    const result = (original as (request: Request, ...rest: unknown[]) => Response | Promise<Response>)(request, ...rest);
    return Promise.resolve(result).then(async (response) => {
      await record(request, response);
      return response;
    });
  };
}
