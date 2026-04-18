/**
 * Reserved for future standalone event endpoints. Currently a no-op router so
 * `server/index.ts` can mount a stable `/api/events` path once filters/tail
 * support lands. All today's event reads flow through `/api/sessions/:id/events`.
 */

import { Router } from 'express';

const router = Router();

export default router;
