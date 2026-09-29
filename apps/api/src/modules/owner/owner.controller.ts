import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ListJobsQuerySchema,
  OWNER_API,
  SubmitJobRequestSchema,
} from '@ag-farm/protocol';
import { OwnerKeyGuard } from '../../auth/owner-key.guard';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { OwnerService } from './owner.service';

@UseGuards(OwnerKeyGuard)
@Controller()
export class OwnerController {
  constructor(private readonly svc: OwnerService) {}

  @Post('v1/owner/jobs')
  @HttpCode(200)
  async submitJob(
    @Req() req: Request,
    @Body(new ZodValidationPipe(SubmitJobRequestSchema)) body: any,
  ) {
    return this.svc.submit(req.ownerContext!.owner, body);
  }

  @Get('v1/owner/jobs')
  async listJobs(
    @Req() req: Request,
    @Query(new ZodValidationPipe(ListJobsQuerySchema)) query: any,
  ) {
    return this.svc.list(req.ownerContext!.owner, query);
  }

  @Get('v1/owner/jobs/:id')
  async getJob(@Req() req: Request, @Param('id') jobId: string) {
    return this.svc.get(req.ownerContext!.owner, jobId);
  }

  @Post('v1/owner/jobs/:id/ack')
  @HttpCode(200)
  async ackJob(@Req() req: Request, @Param('id') jobId: string) {
    return this.svc.ack(req.ownerContext!.owner, jobId);
  }

  @Post('v1/owner/jobs/:id/cancel')
  @HttpCode(200)
  async cancelJob(@Req() req: Request, @Param('id') jobId: string) {
    return this.svc.cancel(req.ownerContext!.owner, jobId);
  }
}
