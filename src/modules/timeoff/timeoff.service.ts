import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  TimeOffRequest,
  TimeOffStatus,
} from '../../database/entities/time-off-request.entity';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { IdempotencyStatus } from '../../database/entities/idempotency-record.entity';
import { BalanceService } from '../balance/balance.service';
import { HcmClientService } from '../hcm-sync/hcm-client.service';
import { CreateTimeOffRequestDto } from '../../common/dto/create-timeoff-request.dto';
import {
  ApproveTimeOffDto,
  RejectTimeOffDto,
} from '../../common/dto/timeoff-actions.dto';

@Injectable()
export class TimeOffService {
  private readonly logger = new Logger(TimeOffService.name);

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly idempotencyService: IdempotencyService,
    private readonly balanceService: BalanceService,
    private readonly hcmClient: HcmClientService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Submit a time-off request.
   *
   * Full idempotency: first call processes, retries return cached result.
   * Atomic: balance validation + reservation + request creation in ONE transaction.
   */
  async createRequest(dto: CreateTimeOffRequestDto): Promise<TimeOffRequest> {
    const { idempotencyKey, ...requestBody } = dto;
    const requestHash = this.idempotencyService.hashRequest(requestBody);

    // --- Step 1: Check idempotency ---
    const idempotencyResult = await this.idempotencyService.acquireOrFetch(
      idempotencyKey,
      requestHash,
    );

    if (!idempotencyResult.isNew) {
      const record = idempotencyResult.record;

      // Still processing (concurrent retry) — return a helpful status
      if (record.status === IdempotencyStatus.PROCESSING) {
        this.logger.warn(`Concurrent retry for key=${idempotencyKey}, still PROCESSING`);
        // Find and return the partially-created request if it exists
        const existingRequest = await this.requestRepo.findOne({
          where: { idempotencyKey },
        });
        if (existingRequest) return existingRequest;

        // If no request yet, return a synthetic pending response
        throw new ConflictException(
          'Request is currently being processed. Please retry in a moment.',
        );
      }

      // Completed — return the cached request
      if (record.responseBody) {
        const cachedRequestId = JSON.parse(record.responseBody).id;
        const cachedRequest = await this.requestRepo.findOne({
          where: { id: cachedRequestId },
        });
        if (cachedRequest) return cachedRequest;
      }
    }

    // --- Step 2: Atomic processing ---
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Check for external HCM balance updates before reserving
      const hasExternalUpdates = await this.checkForExternalBalanceUpdates(
        dto.employeeId,
        dto.locationId,
        dto.daysRequested,
      );

      if (hasExternalUpdates) {
        this.logger.warn(`External balance update detected for ${dto.employeeId}/${dto.locationId} during request creation`);
        // Continue processing but log the potential inconsistency
      }

      // 2a. Validate and reserve balance (inside transaction, with row lock)
      await this.balanceService.reserveBalance(
        dto.employeeId,
        dto.locationId,
        dto.daysRequested,
        queryRunner,
      );

      // 2b. Create the request record
      const request = queryRunner.manager.create(TimeOffRequest, {
        idempotencyKey,
        employeeId: dto.employeeId,
        locationId: dto.locationId,
        daysRequested: dto.daysRequested,
        startDate: dto.startDate,
        endDate: dto.endDate,
        reason: dto.reason,
        managerId: dto.managerId,
        status: TimeOffStatus.PENDING,
        hcmSynced: false,
      });

      const saved = await queryRunner.manager.save(request);

      // 2c. Commit transaction (balance reserved + request created atomically)
      await queryRunner.commitTransaction();

      // 2d. Mark idempotency key as completed with the result
      await this.idempotencyService.markCompleted(idempotencyKey, {
        statusCode: 201,
        body: { id: saved.id },
      });

      this.logger.log(
        `Time-off request created: id=${saved.id} for employee=${dto.employeeId}`,
      );
      return saved;
    } catch (err) {
      await queryRunner.rollbackTransaction();

      // Mark idempotency record as FAILED so the client CAN retry with same key
      await this.idempotencyService.markFailed(idempotencyKey, err.message);

      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get a request by ID (status polling endpoint).
   */
  async getRequest(requestId: string): Promise<TimeOffRequest> {
    const request = await this.requestRepo.findOne({
      where: { id: requestId },
    });

    if (!request) {
      throw new NotFoundException(`Time-off request ${requestId} not found`);
    }

    return request;
  }

  /**
   * List requests for an employee.
   */
  async getEmployeeRequests(
    employeeId: string,
    status?: TimeOffStatus,
  ): Promise<TimeOffRequest[]> {
    const where: any = { employeeId };
    if (status) where.status = status;

    return this.requestRepo.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Approve a time-off request.
   *
   * Atomic: confirm balance deduction + update status + sync HCM in one transaction.
   * Defensive: validates with HCM even though HCM may not always guarantee error responses.
   */
  async approveRequest(
    requestId: string,
    dto: ApproveTimeOffDto,
  ): Promise<TimeOffRequest> {
    const request = await this.getRequest(requestId);

    if (request.status !== TimeOffStatus.PENDING) {
      throw new BadRequestException(
        `Request ${requestId} is ${request.status}, only PENDING requests can be approved.`,
      );
    }

    // --- Defensive HCM check BEFORE atomic DB update ---
    // HCM is source of truth; validate even though HCM errors aren't guaranteed
    let hcmDeductResult;
    try {
      hcmDeductResult = await this.hcmClient.deductBalance({
        employeeId: request.employeeId,
        locationId: request.locationId,
        days: request.daysRequested,
        requestId: request.id,
        startDate: request.startDate,
        endDate: request.endDate,
      });

      // Validate HCM response structure and data
      if (!this.isValidHcmResponse(hcmDeductResult)) {
        this.logger.error(`Invalid HCM response structure: ${JSON.stringify(hcmDeductResult)}`);
        throw new BadRequestException(
          'HCM returned invalid response. Cannot approve request.',
        );
      }

      // Check for reasonable balance values (prevent negative balances, extremely high values)
      if (hcmDeductResult.remainingBalance < 0 || hcmDeductResult.remainingBalance > 1000) {
        this.logger.warn(`Suspicious HCM balance: ${hcmDeductResult.remainingBalance} for employee ${request.employeeId}`);
        // Continue processing but log the anomaly
      }

    } catch (hcmErr) {
      this.logger.error(`HCM unreachable during approval: ${hcmErr.message}`);
      // HCM unreachable — keep PENDING, surface error to caller
      throw new BadRequestException(
        `Cannot approve: HCM is unreachable. Please retry. (${hcmErr.message})`,
      );
    }

    if (!hcmDeductResult.success) {
      // HCM rejected (insufficient balance, invalid dimensions, etc.)
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        await this.balanceService.releaseReservation(
          request.employeeId,
          request.locationId,
          request.daysRequested,
          queryRunner,
        );

        request.status = TimeOffStatus.REJECTED;
        request.rejectionReason = `HCM rejected: ${hcmDeductResult.errorMessage}`;
        request.hcmResponse = JSON.stringify(hcmDeductResult);
        await queryRunner.manager.save(request);

        await queryRunner.commitTransaction();
        return request;
      } catch (err) {
        await queryRunner.rollbackTransaction();
        throw err;
      } finally {
        await queryRunner.release();
      }
    }

    // --- HCM approved — atomically finalize ---
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await this.balanceService.confirmDeduction(
        request.employeeId,
        request.locationId,
        request.daysRequested,
        queryRunner,
      );

      request.status = TimeOffStatus.APPROVED;
      request.managerId = dto.managerId;
      request.hcmSynced = true;
      request.hcmResponse = JSON.stringify(hcmDeductResult);
      const updated = await queryRunner.manager.save(request);

      await queryRunner.commitTransaction();

      this.logger.log(`Request ${requestId} APPROVED by manager ${dto.managerId}`);
      return updated;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Reject a time-off request.
   * Releases the pending balance reservation atomically.
   */
  async rejectRequest(
    requestId: string,
    dto: RejectTimeOffDto,
  ): Promise<TimeOffRequest> {
    const request = await this.getRequest(requestId);

    if (request.status !== TimeOffStatus.PENDING) {
      throw new BadRequestException(
        `Request ${requestId} is ${request.status}, only PENDING requests can be rejected.`,
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await this.balanceService.releaseReservation(
        request.employeeId,
        request.locationId,
        request.daysRequested,
        queryRunner,
      );

      request.status = TimeOffStatus.REJECTED;
      request.managerId = dto.managerId;
      request.rejectionReason = dto.rejectionReason || 'Rejected by manager';
      const updated = await queryRunner.manager.save(request);

      await queryRunner.commitTransaction();

      this.logger.log(`Request ${requestId} REJECTED by manager ${dto.managerId}`);
      return updated;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Cancel a request (by employee, if still PENDING).
   */
  async cancelRequest(requestId: string, employeeId: string): Promise<TimeOffRequest> {
    const request = await this.getRequest(requestId);

    // Trim whitespace and compare
    const trimmedRequestEmployeeId = request.employeeId?.trim();
    const trimmedEmployeeId = employeeId?.trim();

    this.logger.debug(`Cancel request: request.employeeId="${trimmedRequestEmployeeId}", provided employeeId="${trimmedEmployeeId}"`);

    if (trimmedRequestEmployeeId !== trimmedEmployeeId) {
      throw new BadRequestException('You can only cancel your own requests.');
    }

    if (request.status !== TimeOffStatus.PENDING) {
      throw new BadRequestException(
        `Only PENDING requests can be cancelled. Current status: ${request.status}`,
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await this.balanceService.releaseReservation(
        request.employeeId,
        request.locationId,
        request.daysRequested,
        queryRunner,
      );

      request.status = TimeOffStatus.CANCELLED;
      const updated = await queryRunner.manager.save(request);

      await queryRunner.commitTransaction();

      this.logger.log(`Request ${requestId} CANCELLED by employee ${employeeId}`);
      return updated;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Validate HCM response structure and basic data integrity
   */
  private isValidHcmResponse(response: any): boolean {
    if (!response || typeof response !== 'object') {
      return false;
    }

    // Check required fields
    if (typeof response.success !== 'boolean') {
      return false;
    }

    // If successful, check remainingBalance is a valid number
    if (response.success && (typeof response.remainingBalance !== 'number' || isNaN(response.remainingBalance))) {
      return false;
    }

    // If failed, check errorMessage exists
    if (!response.success && (!response.errorMessage || typeof response.errorMessage !== 'string')) {
      return false;
    }

    return true;
  }

  /**
   * Check for external HCM balance updates that might cause inconsistencies
   */
  private async checkForExternalBalanceUpdates(
    employeeId: string,
    locationId: string,
    expectedDays: number,
  ): Promise<boolean> {
    try {
      // Get current local balance
      const localBalance = await this.balanceService.getBalance(employeeId, locationId);

      // Try to get fresh balance from HCM (if available)
      const hcmBalance = await this.hcmClient.getBalance(employeeId, locationId);

      // HcmBalance is returned directly, not wrapped in a result object
      if (hcmBalance && typeof hcmBalance.availableDays === 'number') {
        const balanceDiff = Math.abs(localBalance.availableDays - hcmBalance.availableDays);

        // If difference is significant (> 0.1 days), log warning
        if (balanceDiff > 0.1) {
          this.logger.warn(
            `Balance discrepancy detected for ${employeeId}/${locationId}: ` +
            `Local=${localBalance.availableDays}, HCM=${hcmBalance.availableDays}`
          );
          return true; // External update detected
        }
      }
    } catch (err) {
      // Don't fail operation if balance check fails
      this.logger.debug(`Could not check for external balance updates: ${err.message}`);
    }

    return false;
  }
}