import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffController } from './timeoff.controller';
import { TimeOffService } from './timeoff.service';
import { BalanceService } from '../balance/balance.service';
import { HcmClientService } from '../hcm-sync/hcm-client.service';
import { TimeOffRequest } from '../../database/entities/time-off-request.entity';
import { Balance } from '../../database/entities/balance.entity';
import { IdempotencyModule } from '../idempotency/idempotency.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest, Balance]),
    IdempotencyModule,
  ],
  controllers: [TimeOffController],
  providers: [TimeOffService, BalanceService, HcmClientService],
})
export class TimeOffModule {}