import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AdminGuard } from '../../auth/admin.guard';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  AdminJobControlSchema,
  AdminListJobsQuerySchema,
  AdminListNodesQuerySchema,
  AdminListOwnersQuerySchema,
  AdminStatsPeriodQuerySchema,
  CreateNodeSchema,
  CreateOwnerSchema,
  PatchNodeSchema,
  PatchOwnerSchema,
  ReorderNodesSchema,
} from './admin.dto';
import { AdminService } from './admin.service';
import type { AdminJobControlDto } from './admin.dto';
import type { JobSelector } from '../../common/job-control';
import { CreateEnrollmentRequestSchema, CreateNodeLogRequestSchema } from '@ag-farm/protocol';
import { EnrollService } from '../enroll/enroll.service';
import { MachineMetricsQuerySchema } from '../machines/machine-metrics';
import { MachineMetricsService } from '../machines/machine-metrics.service';
import { NodeLogsService } from '../machines/node-logs.service';

function toSelector(body: AdminJobControlDto): JobSelector {
  return {
    ...(body.ids ? { ids: body.ids } : {}),
    ...(body.group_key ? { groupKey: body.group_key } : {}),
    ...(body.owner ? { owner: body.owner } : {}),
    ...(body.types ? { types: body.types } : {}),
    ...(body.statuses ? { statuses: body.statuses } : {}),
  };
}

@UseGuards(AdminGuard)
@Controller('v1/admin')
export class AdminController {
  constructor(
    private readonly svc: AdminService,
    private readonly enroll: EnrollService,
    private readonly machineMetrics: MachineMetricsService,
    private readonly nodeLogs: NodeLogsService,
  ) {}

  // ---- Mã cài đặt máy worker ----

  @Post('enrollments')
  @HttpCode(201)
  async createEnrollment(@Body(new ZodValidationPipe(CreateEnrollmentRequestSchema)) body: any) {
    return this.enroll.create(body);
  }

  // ---- Nodes ----

  @Get('nodes')
  async listNodes(@Query(new ZodValidationPipe(AdminListNodesQuerySchema)) query: any) {
    return this.svc.listNodes(query);
  }

  @Post('nodes')
  @HttpCode(201)
  async createNode(@Body(new ZodValidationPipe(CreateNodeSchema)) body: any) {
    const { node, token } = await this.svc.createNode(body);
    return { ...node, token };
  }

  /** Xếp lại thứ tự ưu tiên của máy (kéo thả trên web): `ids` thành 1..n, máy còn lại đứng sau. */
  @Post('nodes/reorder')
  @HttpCode(200)
  async reorderNodes(@Body(new ZodValidationPipe(ReorderNodesSchema)) body: any) {
    return this.svc.reorderNodes(body.ids);
  }

  /** "Cập nhật ngay": máy cập nhật ở lần hỏi hub kế tiếp (trong khoảng một phút), sau khi việc đang chạy xong. */
  @Post('nodes/:id/update-now')
  @HttpCode(200)
  async requestNodeUpdate(@Param('id') id: string) {
    return this.svc.requestUpdate(id);
  }

  /** "Lấy log": máy gửi log của nó (trong khoảng `since`–`until` nếu có) ở lần hỏi hub kế tiếp (trong khoảng một phút). */
  @Post('nodes/:id/logs')
  @HttpCode(201)
  async requestNodeLogs(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(CreateNodeLogRequestSchema)) body: any,
  ) {
    return this.nodeLogs.request(id, body);
  }

  @Get('nodes/:id/logs')
  async listNodeLogs(@Param('id', ParseUUIDPipe) id: string) {
    return this.nodeLogs.list(id);
  }

  /** Log máy đã gửi, dạng text để lưu về. */
  @Get('nodes/:id/logs/:logId/file')
  async nodeLogFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('logId', ParseUUIDPipe) logId: string,
    @Res() res: Response,
  ) {
    const { filename, text } = await this.nodeLogs.file(id, logId);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(text);
  }

  @Patch('nodes/:id')
  async patchNode(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PatchNodeSchema)) body: any,
  ) {
    return this.svc.patchNode(id, body);
  }

  @Delete('nodes/:id')
  @HttpCode(204)
  async deleteNode(@Param('id') id: string) {
    await this.svc.deleteNode(id);
  }

  // ---- Tình trạng máy ----

  /** Biểu đồ một máy (`farm_nodes.machine`, node không có máy thì tên node): `range` 1h | 24h | 7d, ≤ 300 điểm. */
  @Get('machines/:machine/metrics')
  async machineMetricsSeries(
    @Param('machine') machine: string,
    @Query(new ZodValidationPipe(MachineMetricsQuerySchema)) query: any,
  ) {
    return this.machineMetrics.series(machine.slice(0, 200), query.range);
  }

  // ---- Jobs ----

  @Get('jobs')
  async listJobs(@Query(new ZodValidationPipe(AdminListJobsQuerySchema)) query: any) {
    return this.svc.listJobs(query);
  }

  @Post('jobs/pause')
  @HttpCode(200)
  async pauseJobs(@Body(new ZodValidationPipe(AdminJobControlSchema)) body: any) {
    return this.svc.controlJobs('pause', toSelector(body));
  }

  @Post('jobs/resume')
  @HttpCode(200)
  async resumeJobs(@Body(new ZodValidationPipe(AdminJobControlSchema)) body: any) {
    return this.svc.controlJobs('resume', toSelector(body));
  }

  @Post('jobs/cancel')
  @HttpCode(200)
  async cancelJobs(@Body(new ZodValidationPipe(AdminJobControlSchema)) body: any) {
    return this.svc.controlJobs('cancel', toSelector(body));
  }

  @Get('jobs/:id')
  async getJob(@Param('id') id: string) {
    return this.svc.getJob(id);
  }

  @Post('jobs/:id/retry')
  @HttpCode(200)
  async retryJob(@Param('id') id: string) {
    return this.svc.retryJob(id);
  }

  @Post('jobs/:id/cancel')
  @HttpCode(200)
  async cancelJob(@Param('id') id: string) {
    return this.svc.cancelJob(id);
  }

  @Get('stats')
  async getStats() {
    return this.svc.getStats();
  }

  @Get('stats/period')
  async getStatsPeriod(@Query(new ZodValidationPipe(AdminStatsPeriodQuerySchema)) query: any) {
    return this.svc.getStatsPeriod(query);
  }

  // ---- Owners ----

  @Get('owners')
  async listOwners(@Query(new ZodValidationPipe(AdminListOwnersQuerySchema)) query: any) {
    return this.svc.listOwners(query);
  }

  @Post('owners')
  @HttpCode(201)
  async createOwner(@Body(new ZodValidationPipe(CreateOwnerSchema)) body: any) {
    const { owner, key } = await this.svc.createOwner(body);
    return { ...owner, key };
  }

  @Patch('owners/:id')
  async patchOwner(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PatchOwnerSchema)) body: any,
  ) {
    return this.svc.patchOwner(id, body);
  }
}
