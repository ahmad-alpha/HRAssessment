import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { DatabaseModule } from './database.module';
import { TimeOffModule } from './modules/timeoff/timeoff.module';
import { IdempotencyModule } from './modules/idempotency/idempotency.module';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'frontend', 'dist'),
    }),
    DatabaseModule,
    IdempotencyModule,
    TimeOffModule,
  ],
})
export class AppModule {}