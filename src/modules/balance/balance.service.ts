import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import { Balance } from '../../database/entities/balance.entity';
import { HcmClientService } from '../hcm-sync/hcm-client.service';

export interface BalanceCheckResult {
  sufficient: boolean;
  availableDays: number;
  requestedDays: number;
}

@Injectable()
export class BalanceService {
  private readonly logger = new Logger(BalanceService.name);

  constructor(
    @InjectRepository(Balance)
    private readonly balanceRepo: Repository<Balance>,
    private readonly hcmClient: HcmClientService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Get local balance. If not cached, fetch from HCM and seed.
   */
  async getBalance(employeeId: string, locationId: string): Promise<Balance> {
    let balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });

    if (!balance) {
      // Not cached — fetch from HCM
      this.logger.log(
        `No local balance for employee=${employeeId}, fetching from HCM`,
      );
      const hcmBalance = await this.hcmClient.getBalance(employeeId, locationId);

      balance = this.balanceRepo.create({
        employeeId,
        locationId,
        availableDays: hcmBalance.availableDays,
        totalDays: hcmBalance.totalDays,
        usedDays: hcmBalance.usedDays,
        pendingDays: 0,
        lastHcmSync: new Date(),
        version: 0,
      });
      balance = await this.balanceRepo.save(balance);
    }

    return balance;
  }

  /**
   * Atomically validate and reserve balance (PENDING state).
   * Called when a request is submitted.
   * Returns the updated balance inside the provided queryRunner transaction.
   */
  async reserveBalance(
    employeeId: string,
    locationId: string,
    days: number,
    queryRunner: QueryRunner,
  ): Promise<Balance> {
    // Lock the row for update (Note: SQLite doesn't support row locking, so this is a no-op for SQLite)
    const balance = await queryRunner.manager
      .createQueryBuilder(Balance, 'b')
      // .setLock('pessimistic_write') // Removed for SQLite compatibility
      .where('b.employeeId = :employeeId AND b.locationId = :locationId', {
        employeeId,
        locationId,
      })
      .getOne();

    if (!balance) {
      // Fetch from HCM inside the transaction
      this.logger.log(`Balance not found in DB, fetching from HCM within transaction`);
      const hcmBalance = await this.hcmClient.getBalance(employeeId, locationId);

      const newBalance = queryRunner.manager.create(Balance, {
        employeeId,
        locationId,
        availableDays: hcmBalance.availableDays,
        totalDays: hcmBalance.totalDays,
        usedDays: hcmBalance.usedDays,
        pendingDays: 0,
        lastHcmSync: new Date(),
        version: 0,
      });

      return queryRunner.manager.save(newBalance);
    }

    const effectiveAvailable = balance.availableDays - balance.pendingDays;

    if (effectiveAvailable < days) {
      throw new BadRequestException(
        `Insufficient balance. Available: ${effectiveAvailable} days, Requested: ${days} days.`,
      );
    }

    // Reserve: move days into pending
    balance.pendingDays = parseFloat((balance.pendingDays + days).toFixed(2));
    balance.version += 1;
    return queryRunner.manager.save(balance);
  }

  /**
   * Atomically confirm a reservation: deduct from available, remove from pending.
   * Called when a request is APPROVED and HCM confirms.
   */
  async confirmDeduction(
    employeeId: string,
    locationId: string,
    days: number,
    queryRunner: QueryRunner,
  ): Promise<Balance> {
    const balance = await queryRunner.manager
      .createQueryBuilder(Balance, 'b')
      // .setLock('pessimistic_write') // Removed for SQLite compatibility
      .where('b.employeeId = :employeeId AND b.locationId = :locationId', {
        employeeId,
        locationId,
      })
      .getOne();

    if (!balance) {
      throw new NotFoundException(
        `Balance not found for employee=${employeeId}, location=${locationId}`,
      );
    }

    balance.availableDays = parseFloat((balance.availableDays - days).toFixed(2));
    balance.usedDays = parseFloat((balance.usedDays + days).toFixed(2));
    balance.pendingDays = parseFloat(
      Math.max(0, balance.pendingDays - days).toFixed(2),
    );
    balance.version += 1;

    return queryRunner.manager.save(balance);
  }

  /**
   * Release a pending reservation (when request is REJECTED or CANCELLED).
   */
  async releaseReservation(
    employeeId: string,
    locationId: string,
    days: number,
    queryRunner: QueryRunner,
  ): Promise<Balance> {
    const balance = await queryRunner.manager
      .createQueryBuilder(Balance, 'b')
      // .setLock('pessimistic_write') // Removed for SQLite compatibility
      .where('b.employeeId = :employeeId AND b.locationId = :locationId', {
        employeeId,
        locationId,
      })
      .getOne();

    if (!balance) {
      throw new NotFoundException(`Balance not found`);
    }

    balance.pendingDays = parseFloat(
      Math.max(0, balance.pendingDays - days).toFixed(2),
    );
    balance.version += 1;

    return queryRunner.manager.save(balance);
  }

  /**
   * Sync a single employee+location balance from HCM.
   * Reconciles local DB against HCM source of truth.
   */
  async syncFromHcm(employeeId: string, locationId: string): Promise<Balance> {
    const hcmBalance = await this.hcmClient.getBalance(employeeId, locationId);

    let balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });

    if (!balance) {
      balance = this.balanceRepo.create({ employeeId, locationId });
    }

    // HCM is source of truth for available + total
    balance.availableDays = hcmBalance.availableDays;
    balance.totalDays = hcmBalance.totalDays;
    balance.usedDays = hcmBalance.usedDays;
    balance.lastHcmSync = new Date();
    balance.version += 1;

    this.logger.log(
      `Synced balance for employee=${employeeId}: ${hcmBalance.availableDays} days available`,
    );

    return this.balanceRepo.save(balance);
  }

  /**
   * Process a full batch sync from HCM.
   * Used for year-start or anniversary balance refreshes.
   */
  async processBatchSync(): Promise<{ synced: number; errors: number }> {
    const batchBalances = await this.hcmClient.getBatchBalances();

    let synced = 0;
    let errors = 0;

    for (const hcmBal of batchBalances) {
      try {
        await this.syncFromHcm(hcmBal.employeeId, hcmBal.locationId);
        synced++;
      } catch (err) {
        this.logger.error(
          `Batch sync failed for employee=${hcmBal.employeeId}: ${err.message}`,
        );
        errors++;
      }
    }

    this.logger.log(`Batch sync complete: ${synced} synced, ${errors} errors`);
    return { synced, errors };
  }
}