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
  JobControlRequestSchema,
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

  /** Tạm dừng / chạy tiếp / huỷ theo id hoặc cả nhóm `group_key`. */
  @Post('v1/owner/jobs/pause')
  @HttpCode(200)
  async pauseJobs(@Req() req: Request, @Body(new ZodValidationPipe(JobControlRequestSchema)) body: any) {
    return this.svc.control(req.ownerContext!.owner, 'pause', body);
  }

  @Post('v1/owner/jobs/resume')
  @HttpCode(200)
  async resumeJobs(@Req() req: Request, @Body(new ZodValidationPipe(JobControlRequestSchema)) body: any) {
    return this.svc.control(req.ownerContext!.owner, 'resume', body);
  }

  @Post('v1/owner/jobs/cancel')
  @HttpCode(200)
  async cancelJobs(@Req() req: Request, @Body(new ZodValidationPipe(JobControlRequestSchema)) body: any) {
    return this.svc.control(req.ownerContext!.owner, 'cancel', body);
  }

  @Get('v1/owner/jobs')
  async listJobs(
    @Req() req: Request,
    @Query(new ZodValidationPipe(ListJobsQuerySchema)) query: any,
  ) {
    return this.svc.list(req.ownerContext!.owner, query);
  }

  /** Máy farm chủ job dùng được (tên, loại job, GPU, đang bận bao nhiêu job): để hiện và ghim job vào một máy. */
  @Get('v1/owner/nodes')
  async listNodes(@Req() req: Request) {
    return this.svc.listNodes(req.ownerContext!.owner);
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
