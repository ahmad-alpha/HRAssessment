import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffRequest } from './database/entities/time-off-request.entity';
import { Balance } from './database/entities/balance.entity';
import { IdempotencyRecord } from './database/entities/idempotency-record.entity';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: process.env.DB_PATH || 'timeoff.db',
      entities: [TimeOffRequest, Balance, IdempotencyRecord],
      synchronize: true, // In prod, use migrations
      logging: process.env.NODE_ENV === 'development',
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}