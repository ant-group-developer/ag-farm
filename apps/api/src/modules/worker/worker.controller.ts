import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
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
  NODE_LOG_MAX_UPLOAD_BYTES,
  WORKER_API,
} from '@ag-farm/protocol';
import { NodeTokenGuard } from '../../auth/node-token.guard';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { WorkerService } from './worker.service';
import { NodeLogsService } from '../machines/node-logs.service';

/** The raw request body (the JSON parser leaves `application/gzip` alone), refused past `limit` bytes. */
function readRawBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new PayloadTooLargeException(`Logs larger than ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Tất cả route worker đều yêu cầu Node token */
@UseGuards(NodeTokenGuard)
@Controller()
export class WorkerController {
  constructor(
    private readonly svc: WorkerService,
    private readonly logs: NodeLogsService,
  ) {}

  /** "Lấy log": lần admin xin log còn chờ của máy này (worker hỏi mỗi phút), hoặc null. */
  @Get('v1/worker/logs/request')
  async logRequest(@Req() req: Request) {
    return { request: await this.logs.pending(req.nodeContext!.node.id) };
  }

  /** Log của máy (body `application/gzip`) cho một lần xin của chính nó. */
  @Post('v1/worker/logs/:id')
  @HttpCode(200)
  async uploadLogs(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const gz = await readRawBody(req, NODE_LOG_MAX_UPLOAD_BYTES);
    await this.logs.store(req.nodeContext!.node.id, id, gz);
    return {};
  }

  /** Script cài máy worker chờ tới khi node vừa cài gửi heartbeat. */
  @Get('v1/worker/me')
  async me(@Req() req: Request) {
    return this.svc.me(req.nodeContext!.node);
  }

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
