import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FarmEnrollmentEntity } from '../../database/entities/farm-enrollment.entity';
import { FarmNodeEntity } from '../../database/entities/farm-node.entity';
import { EnrollController } from './enroll.controller';
import { EnrollService } from './enroll.service';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([FarmEnrollmentEntity, FarmNodeEntity])],
  controllers: [EnrollController],
  providers: [EnrollService],
  exports: [EnrollService],
})
export class EnrollModule {}
