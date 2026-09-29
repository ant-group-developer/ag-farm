import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FarmNodeEntity } from '../database/entities/farm-node.entity';

/** Gắn vào request để các handler dùng */
export interface NodeContext {
  node: FarmNodeEntity;
}

declare module 'express' {
  interface Request {
    nodeContext?: NodeContext;
  }
}

/** Guard: `Authorization: Node <token>` → sha256 → tra farm_nodes */
@Injectable()
export class NodeTokenGuard implements CanActivate {
  constructor(
    @InjectRepository(FarmNodeEntity)
    private readonly nodeRepo: Repository<FarmNodeEntity>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('Node token is required');
    }
    const hash = createHash('sha256').update(token).digest('hex');
    const node = await this.nodeRepo.findOne({ where: { tokenHash: hash } });
    if (!node) {
      throw new UnauthorizedException('Invalid node token');
    }
    request.nodeContext = { node };
    return true;
  }

  private extractToken(request: Request): string | null {
    const auth = request.header('authorization');
    if (!auth) return null;
    const [scheme, token] = auth.trim().split(/\s+/, 2);
    return scheme?.toLowerCase() === 'node' && token ? token : null;
  }
}
