import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { ctxOf } from '../../middleware/index.js';
import { AppError, invalid } from '../../lib/errors.js';
import { MAX_UPLOAD_BYTES } from '../../services/media.js';
import { deletePhoto, listOwnPhotos, setPhotoVisibility, uploadPhoto } from '../../services/progress-photos.js';

/**
 * Private uploads and progress photos (P05, PF-PROG-004/006).
 *
 * `POST /v1/member/media/uploads` takes one image as multipart form data
 * (`file`, `purpose=progress_photo`, `takenOn`, `pose`, `visibility`). The
 * type is decided by the bytes, metadata is stripped, and nothing is stored
 * without photo consent.
 */
export const uploadRoutes = new Hono();

/** Room for the multipart envelope around a 10 MB file. */
const ENVELOPE_BYTES = 64 * 1024;

// Counted as the body streams in, so a request without a Content-Length
// (chunked) cannot make the server buffer more than this before it refuses.
uploadRoutes.use(
  '*',
  bodyLimit({
    maxSize: MAX_UPLOAD_BYTES + ENVELOPE_BYTES,
    onError: () => {
      throw new AppError('PAYLOAD_TOO_LARGE', 'That file is over 10 MB. Choose a smaller photo.');
    },
  }),
);

uploadRoutes.post('/', async (c) => {
  const ctx = ctxOf(c);
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > MAX_UPLOAD_BYTES + ENVELOPE_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', 'That file is over 10 MB. Choose a smaller photo.');
  }
  const form = await c.req.parseBody().catch((err: unknown) => {
    // The body limit above aborts the stream mid-parse; that is a 413 and is
    // answered by its handler. Anything else is a malformed form, not a 500.
    const overLimit = (e: unknown) => e instanceof Error && e.name === 'BodyLimitError';
    if (err instanceof AppError || overLimit(err) || (err instanceof Error && overLimit(err.cause))) throw err;
    throw invalid('Send the photo as multipart form data.');
  });
  const file = form.file;
  if (!(file instanceof File)) throw invalid('Attach the photo as "file".');
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'That file is over 10 MB. Choose a smaller photo.');
  if (form.purpose !== 'progress_photo') throw invalid('Only progress photos can be uploaded.');

  const fields = z
    .object({
      takenOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      pose: z.enum(['front', 'side', 'back', 'other']).default('front'),
      visibility: z.enum(['private', 'coach']).default('private'),
    })
    .safeParse({ takenOn: form.takenOn, pose: form.pose ?? undefined, visibility: form.visibility ?? undefined });
  if (!fields.success) throw invalid('Give the date the photo was taken, a pose and who can see it.');

  const result = uploadPhoto(ctx, { bytes: Buffer.from(await file.arrayBuffer()), ...fields.data });
  return c.json(result, 201);
});

export const photoRoutes = new Hono();

photoRoutes.get('/', (c) => c.json(listOwnPhotos(ctxOf(c))));

photoRoutes.patch('/:id', validate('json', z.object({ visibility: z.enum(['private', 'coach']) })), (c) =>
  c.json(setPhotoVisibility(ctxOf(c), c.req.param('id'), c.req.valid('json').visibility)),
);

photoRoutes.delete('/:id', (c) => c.json(deletePhoto(ctxOf(c), c.req.param('id'))));
