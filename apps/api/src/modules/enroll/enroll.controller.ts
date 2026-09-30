import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { EnrollRequestSchema } from '@ag-farm/protocol';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { EnrollService } from './enroll.service';

/** Route công khai cho script cài máy worker: xác thực bằng chính mã cài đặt. */
@Controller()
export class EnrollController {
  constructor(private readonly svc: EnrollService) {}

  @Post('v1/enroll')
  @HttpCode(200)
  async enroll(@Body(new ZodValidationPipe(EnrollRequestSchema)) body: any) {
    return this.svc.enroll(body);
  }
}
