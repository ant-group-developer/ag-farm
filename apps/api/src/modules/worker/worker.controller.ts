import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ClaimRequestSchema,
  CompleteRequestSchema,
  FailRequestSchema,
  HeartbeatRequestSchema,
  ProgressRequestSchema,
  WORKER_API,
} from '@ag-farm/protocol';
import { NodeTokenGuard } from '../../auth/node-token.guard';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { WorkerService } from './worker.service';

/** Tất cả route worker đều yêu cầu Node token */
@UseGuards(NodeTokenGuard)
@Controller()
export class WorkerController {
  constructor(private readonly svc: WorkerService) {}

  @Post('v1/worker/heartbeat')
  @HttpCode(200)
  async heartbeat(@Req() req: Request, @Body(new ZodValidationPipe(HeartbeatRequestSchema)) body: any) {
    return this.svc.heartbeat(req.nodeContext!.node, body);
  }

  @Post('v1/worker/claim')
  @HttpCode(200)
  async claim(@Req() req: Request, @Body(new ZodValidationPipe(ClaimRequestSchema)) body: any) {
    return this.svc.claim(req.nodeContext!.node, body);
  }

  @Post('v1/worker/jobs/:id/progress')
  @HttpCode(200)
  async progress(
    @Req() req: Request,
    @Param('id') jobId: string,
    @Body(new ZodValidationPipe(ProgressRequestSchema)) body: any,
  ) {
    return this.svc.progress(req.nodeContext!.node, jobId, body);
  }

  @Post('v1/worker/jobs/:id/complete')
  @HttpCode(200)
  async complete(
    @Req() req: Request,
    @Param('id') jobId: string,
    @Body(new ZodValidationPipe(CompleteRequestSchema)) body: any,
  ) {
    await this.svc.complete(req.nodeContext!.node, jobId, body);
    return {};
  }

  @Post('v1/worker/jobs/:id/fail')
  @HttpCode(200)
  async fail(
    @Req() req: Request,
    @Param('id') jobId: string,
    @Body(new ZodValidationPipe(FailRequestSchema)) body: any,
  ) {
    await this.svc.fail(req.nodeContext!.node, jobId, body);
    return {};
  }
}
