import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { TimeOffService } from './timeoff.service';
import {
  TimeOffRequest,
  TimeOffStatus,
} from '../../database/entities/time-off-request.entity';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { BalanceService } from '../balance/balance.service';
import { HcmClientService } from '../hcm-sync/hcm-client.service';
import { IdempotencyStatus } from '../../database/entities/idempotency-record.entity';
import { DataSource } from 'typeorm';

// ─── Factories ────────────────────────────────────────────────────────────────
const makeRequest = (overrides: Partial<TimeOffRequest> = {}): TimeOffRequest =>
  ({
    id: 'req-uuid-1',
    idempotencyKey: 'idem-key-1',
    employeeId: 'emp-001',
    locationId: 'loc-us-hq',
    daysRequested: 3,
    startDate: '2024-06-01',
    endDate: '2024-06-05',
    reason: 'Vacation',
    status: TimeOffStatus.PENDING,
    managerId: null,
    rejectionReason: null,
    hcmSynced: false,
    hcmResponse: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as TimeOffRequest);

const makeQueryRunner = () => ({
  connect: jest.fn(),
  startTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  rollbackTransaction: jest.fn(),
  release: jest.fn(),
  manager: {
    create: jest.fn().mockImplementation((_, data) => data),
    save: jest.fn().mockImplementation((data) =>
      Promise.resolve({ id: 'req-uuid-1', ...data }),
    ),
  },
});

describe('TimeOffService', () => {
  let service: TimeOffService;
  let mockRequestRepo: any;
  let mockIdempotencyService: any;
  let mockBalanceService: any;
  let mockHcmClient: any;
  let mockDataSource: any;

  const mockQR = makeQueryRunner();

  beforeEach(async () => {
    mockRequestRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
    };

    mockIdempotencyService = {
      hashRequest: jest.fn().mockReturnValue('mock-hash'),
      acquireOrFetch: jest.fn().mockResolvedValue({ isNew: true, record: null }),
      markCompleted: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };

    mockBalanceService = {
      reserveBalance: jest.fn().mockResolvedValue({}),
      confirmDeduction: jest.fn().mockResolvedValue({}),
      releaseReservation: jest.fn().mockResolvedValue({}),
    };

    mockHcmClient = {
      deductBalance: jest.fn().mockResolvedValue({ success: true, remainingBalance: 12 }),
      restoreBalance: jest.fn().mockResolvedValue({ success: true, remainingBalance: 15 }),
    };

    const freshQR = makeQueryRunner();
    mockDataSource = {
      createQueryRunner: jest.fn().mockReturnValue(freshQR),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeOffService,
        { provide: getRepositoryToken(TimeOffRequest), useValue: mockRequestRepo },
        { provide: IdempotencyService, useValue: mockIdempotencyService },
        { provide: BalanceService, useValue: mockBalanceService },
        { provide: HcmClientService, useValue: mockHcmClient },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<TimeOffService>(TimeOffService);
  });

  // ─── createRequest ─────────────────────────────────────────────────────────
  describe('createRequest', () => {
    const dto = {
      idempotencyKey: 'idem-key-1',
      employeeId: 'emp-001',
      locationId: 'loc-us-hq',
      daysRequested: 3,
      startDate: '2024-06-01',
      endDate: '2024-06-05',
      reason: 'Vacation',
    };

    it('creates a new request on first call', async () => {
      mockIdempotencyService.acquireOrFetch.mockResolvedValue({
        isNew: true,
        record: null,
      });

      const result = await service.createRequest(dto);

      expect(mockBalanceService.reserveBalance).toHaveBeenCalledWith(
        dto.employeeId,
        dto.locationId,
        dto.daysRequested,
        expect.anything(),
      );
      expect(mockIdempotencyService.markCompleted).toHaveBeenCalled();
    });

    it('returns cached result on idempotent retry (COMPLETED)', async () => {
      const cachedRequest = makeRequest();
      mockIdempotencyService.acquireOrFetch.mockResolvedValue({
        isNew: false,
        record: {
          status: IdempotencyStatus.COMPLETED,
          responseBody: JSON.stringify({ id: 'req-uuid-1' }),
        },
      });
      mockRequestRepo.findOne.mockResolvedValue(cachedRequest);

      const result = await service.createRequest(dto);

      // Should NOT process again
      expect(mockBalanceService.reserveBalance).not.toHaveBeenCalled();
      expect(result.id).toBe('req-uuid-1');
    });

    it('throws ConflictException when same key used with different payload', async () => {
      mockIdempotencyService.acquireOrFetch.mockRejectedValue(
        new ConflictException('Idempotency key reused with different payload'),
      );

      await expect(service.createRequest(dto)).rejects.toThrow(ConflictException);
    });

    it('marks idempotency as FAILED and rolls back when balance is insufficient', async () => {
      mockIdempotencyService.acquireOrFetch.mockResolvedValue({ isNew: true, record: null });
      mockBalanceService.reserveBalance.mockRejectedValue(
        new BadRequestException('Insufficient balance'),
      );

      await expect(service.createRequest(dto)).rejects.toThrow(BadRequestException);

      expect(mockIdempotencyService.markFailed).toHaveBeenCalledWith(
        dto.idempotencyKey,
        expect.stringContaining('Insufficient balance'),
      );
    });

    it('calls balance reservation BEFORE saving request (correct order)', async () => {
      const callOrder: string[] = [];
      mockBalanceService.reserveBalance.mockImplementation(() => {
        callOrder.push('reserve');
        return Promise.resolve({});
      });

      const qr = makeQueryRunner();
      qr.manager.save.mockImplementation((data) => {
        callOrder.push('save');
        return Promise.resolve({ id: 'req-uuid-1', ...data });
      });
      mockDataSource.createQueryRunner.mockReturnValue(qr);

      await service.createRequest(dto);

      expect(callOrder.indexOf('reserve')).toBeLessThan(callOrder.indexOf('save'));
    });
  });

  // ─── getRequest ────────────────────────────────────────────────────────────
  describe('getRequest', () => {
    it('returns the request when found', async () => {
      const req = makeRequest();
      mockRequestRepo.findOne.mockResolvedValue(req);

      const result = await service.getRequest('req-uuid-1');
      expect(result).toEqual(req);
    });

    it('throws NotFoundException when request does not exist', async () => {
      mockRequestRepo.findOne.mockResolvedValue(null);

      await expect(service.getRequest('nonexistent-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── approveRequest ────────────────────────────────────────────────────────
  describe('approveRequest', () => {
    it('approves a PENDING request when HCM succeeds', async () => {
      const req = makeRequest({ status: TimeOffStatus.PENDING });
      mockRequestRepo.findOne.mockResolvedValue(req);
      mockHcmClient.deductBalance.mockResolvedValue({
        success: true,
        remainingBalance: 12,
      });

      const result = await service.approveRequest('req-uuid-1', {
        managerId: 'mgr-001',
      });

      expect(mockBalanceService.confirmDeduction).toHaveBeenCalled();
    });

    it('rejects automatically when HCM reports INSUFFICIENT_BALANCE', async () => {
      const req = makeRequest({ status: TimeOffStatus.PENDING });
      mockRequestRepo.findOne.mockResolvedValue(req);
      mockHcmClient.deductBalance.mockResolvedValue({
        success: false,
        remainingBalance: 0,
        errorCode: 'INSUFFICIENT_BALANCE',
        errorMessage: 'Not enough balance',
      });

      await service.approveRequest('req-uuid-1', { managerId: 'mgr-001' });

      // Should release reservation and set to REJECTED
      expect(mockBalanceService.releaseReservation).toHaveBeenCalled();
    });

    it('throws BadRequestException for non-PENDING requests', async () => {
      const req = makeRequest({ status: TimeOffStatus.APPROVED });
      mockRequestRepo.findOne.mockResolvedValue(req);

      await expect(
        service.approveRequest('req-uuid-1', { managerId: 'mgr-001' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when HCM is unreachable (network error)', async () => {
      const req = makeRequest({ status: TimeOffStatus.PENDING });
      mockRequestRepo.findOne.mockResolvedValue(req);
      mockHcmClient.deductBalance.mockRejectedValue(
        new Error('connect ECONNREFUSED'),
      );

      await expect(
        service.approveRequest('req-uuid-1', { managerId: 'mgr-001' }),
      ).rejects.toThrow(BadRequestException);

      // Should NOT deduct locally either
      expect(mockBalanceService.confirmDeduction).not.toHaveBeenCalled();
    });
  });

  // ─── rejectRequest ─────────────────────────────────────────────────────────
  describe('rejectRequest', () => {
    it('rejects a PENDING request and releases balance', async () => {
      const req = makeRequest({ status: TimeOffStatus.PENDING });
      mockRequestRepo.findOne.mockResolvedValue(req);

      await service.rejectRequest('req-uuid-1', {
        managerId: 'mgr-001',
        rejectionReason: 'Team coverage',
      });

      expect(mockBalanceService.releaseReservation).toHaveBeenCalledWith(
        req.employeeId,
        req.locationId,
        req.daysRequested,
        expect.anything(),
      );
    });

    it('throws BadRequestException for non-PENDING requests', async () => {
      const req = makeRequest({ status: TimeOffStatus.REJECTED });
      mockRequestRepo.findOne.mockResolvedValue(req);

      await expect(
        service.rejectRequest('req-uuid-1', { managerId: 'mgr-001' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── cancelRequest ─────────────────────────────────────────────────────────
  describe('cancelRequest', () => {
    it('allows employee to cancel their own PENDING request', async () => {
      const req = makeRequest({ status: TimeOffStatus.PENDING, employeeId: 'emp-001' });
      mockRequestRepo.findOne.mockResolvedValue(req);

      await service.cancelRequest('req-uuid-1', 'emp-001');

      expect(mockBalanceService.releaseReservation).toHaveBeenCalled();
    });

    it('throws BadRequestException when employee cancels someone else\'s request', async () => {
      const req = makeRequest({ status: TimeOffStatus.PENDING, employeeId: 'emp-001' });
      mockRequestRepo.findOne.mockResolvedValue(req);

      await expect(
        service.cancelRequest('req-uuid-1', 'emp-OTHER'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when cancelling an APPROVED request', async () => {
      const req = makeRequest({ status: TimeOffStatus.APPROVED, employeeId: 'emp-001' });
      mockRequestRepo.findOne.mockResolvedValue(req);

      await expect(
        service.cancelRequest('req-uuid-1', 'emp-001'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});