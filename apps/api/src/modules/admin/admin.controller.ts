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
  AdminListJobsQuerySchema,
  CreateNodeSchema,
  CreateOwnerSchema,
  PatchNodeSchema,
  PatchOwnerSchema,
} from './admin.dto';
import { AdminService } from './admin.service';

@UseGuards(AdminGuard)
@Controller('v1/admin')
export class AdminController {
  constructor(private readonly svc: AdminService) {}

  // ---- Nodes ----

  @Get('nodes')
  async listNodes() {
    return this.svc.listNodes();
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
  async listOwners() {
    return this.svc.listOwners();
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
