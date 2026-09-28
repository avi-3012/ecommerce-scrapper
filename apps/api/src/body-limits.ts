import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';

/** Room for a full import review: 1,000 rows of long marketplace URLs, with margin. */
export const IMPORT_REVIEW_LIMIT = '5mb';

/**
 * JSON bodies past Express's 100 KB default, for the one route that needs them.
 *
 * Confirming an import posts back the whole review from /import/validate — up
 * to 1,000 rows, each carrying its full marketplace URL. Flipkart's run to ~450
 * characters of tracking parameters, so a 400-row laptop sheet is ~250 KB and
 * the default refused it with "request entity too large". Every other route
 * keeps the default.
 *
 * Wrapped rather than mounted as it is: Nest skips installing its own JSON
 * parser when any middleware is already named `jsonParser`, which is what
 * express.json() returns — and that would leave every other route without a
 * parsed body. Mounted before Nest's parser, this one reads the body first and
 * Nest's then passes the request by. Call it before the app starts listening.
 */
export function allowLargeImportReviews(app: NestExpressApplication): void {
  const parse = express.json({ limit: IMPORT_REVIEW_LIMIT });
  app.use('/api/import/execute', (req: Request, res: Response, next: NextFunction) =>
    parse(req, res, next),
  );
}
