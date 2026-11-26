import { Hono } from 'hono';
import { ctxOf } from '../../middleware/index.js';
import { coachPhotos } from '../../services/progress-photos.js';

/** A member's progress photos, as their assigned coach may see them. */
export const memberPhotoRoutes = new Hono();

memberPhotoRoutes.get('/:memberId/progress-photos', (c) => c.json(coachPhotos(ctxOf(c), c.req.param('memberId'))));
