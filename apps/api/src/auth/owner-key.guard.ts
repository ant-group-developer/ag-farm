import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FarmOwnerEntity } from '../database/entities/farm-owner.entity';

export interface OwnerContext {
  owner: FarmOwnerEntity;
}

declare module 'express' {
  interface Request {
    ownerContext?: OwnerContext;
  }
}

/** Guard: `Authorization: Owner <key>` → sha256 → tra farm_owners */
@Injectable()
export class OwnerKeyGuard implements CanActivate {
  constructor(
    @InjectRepository(FarmOwnerEntity)
    private readonly ownerRepo: Repository<FarmOwnerEntity>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const key = this.extractKey(request);
    if (!key) {
      throw new UnauthorizedException('Owner key is required');
    }
    const hash = createHash('sha256').update(key).digest('hex');
    const owner = await this.ownerRepo.findOne({ where: { keyHash: hash } });
    if (!owner) {
      throw new UnauthorizedException('Invalid owner key');
    }
    request.ownerContext = { owner };
    return true;
  }

  private extractKey(request: Request): string | null {
    const auth = request.header('authorization');
    if (!auth) return null;
    const [scheme, key] = auth.trim().split(/\s+/, 2);
    return scheme?.toLowerCase() === 'owner' && key ? key : null;
  }
}
