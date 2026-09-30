import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ENROLLMENT_TTL_HOURS,
  ROLE_KINDS,
  ROLE_PACKAGES,
  type CreateEnrollmentRequest,
  type CreateEnrollmentResponse,
  type EnrollRequest,
  type EnrollResponse,
  type WorkerRole,
} from '@ag-farm/protocol';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { FarmEnrollmentEntity } from '../../database/entities/farm-enrollment.entity';
import { FarmNodeEntity } from '../../database/entities/farm-node.entity';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class EnrollService {
  constructor(
    @InjectRepository(FarmEnrollmentEntity)
    private readonly enrollRepo: Repository<FarmEnrollmentEntity>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  /** Admin tạo mã cài đặt cho một máy. Mã chỉ trả về lần này. */
  async create(req: CreateEnrollmentRequest): Promise<CreateEnrollmentResponse> {
    const code = `agf_${randomBytes(24).toString('base64url')}`;
    const roles = [...new Set(req.roles)];
    const saved = await this.enrollRepo.save(
      this.enrollRepo.create({
        codeHash: sha256(code),
        machine: req.machine,
        roles,
        expiresAt: new Date(Date.now() + ENROLLMENT_TTL_HOURS * 3600_000),
        usedAt: null,
        nodeIds: [],
      }),
    );
    return {
      id: saved.id,
      machine: saved.machine,
      roles: roles as WorkerRole[],
      code,
      expires_at: saved.expiresAt.toISOString(),
      public_url: this.config.get<string>('FARM_PUBLIC_URL') ?? null,
    };
  }

  /**
   * Script cài đổi mã lấy token cho từng vai trò. Mỗi vai trò là một node `<machine>-<role>`: node đã có
   * tên đó (cài lại máy cũ) được cấp token mới thay vì tạo node trùng. Mã dùng một lần.
   */
  async enroll(req: EnrollRequest): Promise<EnrollResponse> {
    return this.dataSource.transaction(async (em) => {
      const enrollment = await em
        .getRepository(FarmEnrollmentEntity)
        .createQueryBuilder('e')
        .where('e.code_hash = :hash', { hash: sha256(req.code) })
        .setLock('pessimistic_write')
        .getOne();
      // Một câu trả lời cho mọi trường hợp: không lộ mã nào từng tồn tại.
      if (!enrollment || enrollment.usedAt !== null || enrollment.expiresAt.getTime() <= Date.now()) {
        throw new ForbiddenException('Enrollment code is invalid, used or expired');
      }

      const nodeRepo = em.getRepository(FarmNodeEntity);
      const nodes: EnrollResponse['nodes'] = [];
      for (const role of enrollment.roles as WorkerRole[]) {
        const name = `${enrollment.machine}-${role}`;
        const kinds = [...ROLE_KINDS[role]];
        const token = randomBytes(32).toString('base64url');
        const existing = await nodeRepo.findOne({ where: { name } });
        const node = existing
          ? Object.assign(existing, { tokenHash: sha256(token), kinds, machine: enrollment.machine, status: 'active' as const })
          : nodeRepo.create({ name, machine: enrollment.machine, kinds, tokenHash: sha256(token), status: 'active' });
        const saved = await nodeRepo.save(node);
        nodes.push({ role, package: ROLE_PACKAGES[role], node_id: saved.id, name, kinds, token });
      }

      await em.getRepository(FarmEnrollmentEntity).update(enrollment.id, {
        usedAt: new Date(),
        nodeIds: nodes.map((n) => n.node_id),
      });
      return { machine: enrollment.machine, nodes };
    });
  }
}
