import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { TimeOffService } from './timeoff.service';
import { BalanceService } from '../balance/balance.service';
import { CreateTimeOffRequestDto } from '../../common/dto/create-timeoff-request.dto';
import {
  ApproveTimeOffDto,
  RejectTimeOffDto,
  SyncBalanceDto,
} from '../../common/dto/timeoff-actions.dto';
import { TimeOffStatus } from '../../database/entities/time-off-request.entity';

@ApiTags('Time Off')
@Controller('timeoff')
export class TimeOffController {
  constructor(
    private readonly timeOffService: TimeOffService,
    private readonly balanceService: BalanceService,
  ) {}

  /**
   * POST /timeoff
   * Submit a time-off request. Idempotent — safe to retry with same key.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Submit a time-off request',
    description:
      'Idempotent endpoint. Include a unique idempotencyKey to safely retry on network failure.',
  })
  @ApiResponse({ status: 201, description: 'Request created or returned from cache' })
  @ApiResponse({ status: 400, description: 'Insufficient balance or invalid data' })
  @ApiResponse({ status: 409, description: 'Idempotency key reused with different payload' })
  async createRequest(
    @Body(new ValidationPipe({ whitelist: true })) dto: CreateTimeOffRequestDto,
  ) {
    return this.timeOffService.createRequest(dto);
  }

  /**
   * GET /timeoff/:requestId
   * Poll the status of a request. Used after a timeout/failure.
   */
  @Get(':requestId')
  @ApiOperation({
    summary: 'Get request status',
    description: 'Poll this to check PENDING / APPROVED / REJECTED status.',
  })
  @ApiParam({ name: 'requestId', description: 'UUID of the time-off request' })
  @ApiResponse({ status: 200, description: 'Request details' })
  @ApiResponse({ status: 404, description: 'Request not found' })
  async getRequest(@Param('requestId', ParseUUIDPipe) requestId: string) {
    return this.timeOffService.getRequest(requestId);
  }

  /**
   * GET /timeoff/employee/:employeeId
   * List all requests for an employee, optionally filtered by status.
   */
  @Get('employee/:employeeId')
  @ApiOperation({ summary: 'List requests for an employee' })
  @ApiQuery({
    name: 'status',
    enum: TimeOffStatus,
    required: false,
    description: 'Filter by status',
  })
  async getEmployeeRequests(
    @Param('employeeId') employeeId: string,
    @Query('status') status?: TimeOffStatus,
  ) {
    return this.timeOffService.getEmployeeRequests(employeeId, status);
  }

  /**
   * PATCH /timeoff/:requestId/approve
   * Manager approves a pending request.
   */
  @Patch(':requestId/approve')
  @ApiOperation({
    summary: 'Approve a time-off request',
    description: 'Validates with HCM, deducts balance, and marks APPROVED atomically.',
  })
  async approveRequest(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: ApproveTimeOffDto,
  ) {
    return this.timeOffService.approveRequest(requestId, dto);
  }

  /**
   * PATCH /timeoff/:requestId/reject
   * Manager rejects a pending request — releases reserved balance.
   */
  @Patch(':requestId/reject')
  @ApiOperation({ summary: 'Reject a time-off request' })
  async rejectRequest(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: RejectTimeOffDto,
  ) {
    return this.timeOffService.rejectRequest(requestId, dto);
  }

  /**
   * DELETE /timeoff/:requestId/cancel
   * Employee cancels their own PENDING request.
   */
  @Delete(':requestId/cancel')
  @ApiOperation({ summary: 'Cancel a time-off request' })
  async cancelRequest(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Query('employeeId') employeeId: string,
  ) {
    return this.timeOffService.cancelRequest(requestId, employeeId);
  }

  // ─── Balance Endpoints ───────────────────────────────────────────────────

  /**
   * GET /timeoff/balance/:employeeId/:locationId
   * Get current balance (from local cache, seeded from HCM if missing).
   */
  @Get('balance/:employeeId/:locationId')
  @ApiOperation({ summary: 'Get employee balance for a location' })
  async getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
  ) {
    return this.balanceService.getBalance(employeeId, locationId);
  }

  /**
   * POST /timeoff/balance/sync
   * Sync a single employee+location balance from HCM.
   */
  @Post('balance/sync')
  @ApiOperation({
    summary: 'Sync balance from HCM (real-time)',
    description: 'Fetches current balance from HCM and updates local cache.',
  })
  async syncBalance(
    @Body(new ValidationPipe({ whitelist: true })) dto: SyncBalanceDto,
  ) {
    return this.balanceService.syncFromHcm(dto.employeeId, dto.locationId);
  }

  /**
   * POST /timeoff/balance/batch-sync
   * Trigger a full batch sync from HCM (used after anniversary bonuses etc.).
   */
  @Post('balance/batch-sync')
  @ApiOperation({
    summary: 'Trigger full batch sync from HCM',
    description:
      'Syncs entire balance corpus from HCM. Use after year-start or work anniversary refreshes.',
  })
  async batchSync() {
    return this.balanceService.processBatchSync();
  }
}