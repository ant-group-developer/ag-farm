import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/** Pipe validate + transform body/query bằng Zod schema. 400 kèm issues khi không hợp lệ. */
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        issues: result.error.issues,
      });
    }
    return result.data;
  }
}
