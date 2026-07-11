import { BadRequestException } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';

/**
 * Uniform validation error contract (WP-1.10 rule 3): field-addressed errors
 * the Milestone 2 forms map directly onto inputs.
 */
export function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException({
      message: 'Validation failed',
      errors: result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}
