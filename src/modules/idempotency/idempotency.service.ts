import { Injectable, ConflictException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  IdempotencyRecord,
  IdempotencyStatus,
} from '../../database/entities/idempotency-record.entity';
import * as crypto from 'crypto';

export interface IdempotencyResult {
  isNew: boolean;
  record: IdempotencyRecord;
}

export interface StoredResponse {
  statusCode: number;
  body: any;
}

const IDEMPOTENCY_TTL_HOURS = 24;

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    @InjectRepository(IdempotencyRecord)
    private readonly idempotencyRepo: Repository<IdempotencyRecord>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Hash the request payload to detect if a retry is for the SAME request
   * or a different request using an existing key (which is a client error).
   */
  hashRequest(payload: object): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  /**
   * Atomically acquire or fetch an idempotency record.
   *
   * Returns:
   *   - { isNew: true }  → caller should process the request, then call markComplete()
   *   - { isNew: false, record } → return record.responseBody directly; do not re-process
   *
   * Throws ConflictException if the same key is reused with a DIFFERENT request body.
   */
  async acquireOrFetch(
    idempotencyKey: string,
    requestHash: string,
  ): Promise<IdempotencyResult> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Check if record already exists
      const existing = await queryRunner.manager.findOne(IdempotencyRecord, {
        where: { idempotencyKey },
      });

      if (existing) {
        // Same key, different payload → conflict
        if (existing.requestHash !== requestHash) {
          await queryRunner.rollbackTransaction();
          throw new ConflictException(
            `Idempotency key '${idempotencyKey}' was previously used with a different request payload.`,
          );
        }

        // Still processing (e.g., previous attempt in-flight) → return as-is
        if (existing.status === IdempotencyStatus.PROCESSING) {
          await queryRunner.rollbackTransaction();
          this.logger.warn(`Request ${idempotencyKey} still PROCESSING — possible concurrent retry`);
          return { isNew: false, record: existing };
        }

        // Already completed → return cached result
        await queryRunner.rollbackTransaction();
        this.logger.log(`Cache hit for idempotency key: ${idempotencyKey}`);
        return { isNew: false, record: existing };
      }

      // New request — create a PROCESSING placeholder atomically
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + IDEMPOTENCY_TTL_HOURS);

      const record = queryRunner.manager.create(IdempotencyRecord, {
        idempotencyKey,
        requestHash,
        status: IdempotencyStatus.PROCESSING,
        expiresAt,
      });

      const saved = await queryRunner.manager.save(record);
      await queryRunner.commitTransaction();

      this.logger.log(`New idempotency record created: ${idempotencyKey}`);
      return { isNew: true, record: saved };
    } catch (err) {
      if (!queryRunner.isTransactionActive) {
        // Already rolled back
        throw err;
      }
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Mark request as COMPLETED and store the response.
   * Called after successful processing.
   */
  async markCompleted(
    idempotencyKey: string,
    response: StoredResponse,
  ): Promise<void> {
    await this.idempotencyRepo.update(
      { idempotencyKey },
      {
        status: IdempotencyStatus.COMPLETED,
        responseBody: JSON.stringify(response.body),
        responseStatusCode: response.statusCode,
      },
    );
    this.logger.log(`Idempotency record COMPLETED: ${idempotencyKey}`);
  }

  /**
   * Mark request as FAILED.
   * Called when processing fails so future retries can re-process.
   */
  async markFailed(idempotencyKey: string, errorMessage: string): Promise<void> {
    await this.idempotencyRepo.update(
      { idempotencyKey },
      {
        status: IdempotencyStatus.FAILED,
        responseBody: JSON.stringify({ error: errorMessage }),
      },
    );
    this.logger.warn(`Idempotency record FAILED: ${idempotencyKey}`);
  }

  /**
   * For FAILED records, allow a fresh retry by resetting to PROCESSING.
   */
  async resetForRetry(idempotencyKey: string): Promise<void> {
    await this.idempotencyRepo.update(
      { idempotencyKey, status: IdempotencyStatus.FAILED },
      { status: IdempotencyStatus.PROCESSING },
    );
  }

  async getRecord(idempotencyKey: string): Promise<IdempotencyRecord | null> {
    return this.idempotencyRepo.findOne({ where: { idempotencyKey } });
  }
}