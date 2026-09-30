import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../../auth/admin.guard';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  AdminJobControlSchema,
  AdminListJobsQuerySchema,
  AdminListNodesQuerySchema,
  AdminListOwnersQuerySchema,
  CreateNodeSchema,
  CreateOwnerSchema,
  PatchNodeSchema,
  PatchOwnerSchema,
} from './admin.dto';
import { AdminService } from './admin.service';
import type { AdminJobControlDto } from './admin.dto';
import type { JobSelector } from '../../common/job-control';
import { CreateEnrollmentRequestSchema } from '@ag-farm/protocol';
import { EnrollService } from '../enroll/enroll.service';

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
