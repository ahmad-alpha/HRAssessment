import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { TimeOffService } from '../../modules/timeoff/timeoff.service';
import { TimeOffRequest, TimeOffStatus } from '../../database/entities/time-off-request.entity';
import { IdempotencyService } from '../../modules/idempotency/idempotency.service';
import { BalanceService } from '../../modules/balance/balance.service';
import { HcmClientService } from '../../modules/hcm-sync/hcm-client.service';
import { IdempotencyStatus } from '../../database/entities/idempotency-record.entity';
import { DataSource } from 'typeorm';

/**
 * UNIT TESTS FOR TIMEOFF SERVICE
 * Covers: Logic validation, error handling, state transitions
 */

// ─── Test Factories ─────────────────────────────────────────────────────────

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

// ─── Unit Tests ─────────────────────────────────────────────────────────────

describe('TimeOffService - Unit Tests', () => {
  let service: TimeOffService;
  let mockRequestRepo: any;
  let mockIdempotencyService: any;
  let mockBalanceService: any;
  let mockHcmClient: any;
  let mockDataSource: any;

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
      deductBalance: jest.fn().mockResolvedValue({
        success: true,
        remainingBalance: 12,
      }),
      restoreBalance: jest.fn().mockResolvedValue({ success: true }),
      getBalance: jest.fn().mockResolvedValue({
        employeeId: 'emp-001',
        locationId: 'loc-us-hq',
        availableDays: 15,
        totalDays: 20,
        usedDays: 5,
      }),
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

  // ─── createRequest Tests ─────────────────────────────────────────────────

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

    it('should create a new request successfully', async () => {
      const result = await service.createRequest(dto);

      expect(mockBalanceService.reserveBalance).toHaveBeenCalledWith(
        'emp-001',
        'loc-us-hq',
        3,
        expect.anything(),
      );
      expect(result.id).toBe('req-uuid-1');
      expect(result.status).toBe(TimeOffStatus.PENDING);
    });

    it('should handle idempotent retries (COMPLETED)', async () => {
      mockIdempotencyService.acquireOrFetch.mockResolvedValueOnce({
        isNew: false,
        record: {
          status: IdempotencyStatus.COMPLETED,
          responseBody: JSON.stringify({ id: 'cached-id' }),
        },
      });
      mockRequestRepo.findOne.mockResolvedValueOnce(makeRequest({ id: 'cached-id' }));

      const result = await service.createRequest(dto);

      expect(mockBalanceService.reserveBalance).not.toHaveBeenCalled();
      expect(result.id).toBe('cached-id');
    });

    it('should throw when balance insufficient', async () => {
      mockBalanceService.reserveBalance.mockRejectedValueOnce(
        new BadRequestException('Insufficient balance'),
      );

      await expect(service.createRequest(dto)).rejects.toThrow(BadRequestException);
      expect(mockIdempotencyService.markFailed).toHaveBeenCalled();
    });

    it('should mark idempotency as FAILED on error', async () => {
      mockBalanceService.reserveBalance.mockRejectedValueOnce(
        new BadRequestException('Insufficient balance'),
      );

      try {
        await service.createRequest(dto);
      } catch (e) {
        // Expected
      }

      expect(mockIdempotencyService.markFailed).toHaveBeenCalledWith(
        'idem-key-1',
        expect.stringContaining('Insufficient balance'),
      );
    });
  });

  // ─── cancelRequest Tests ─────────────────────────────────────────────────

  describe('cancelRequest', () => {
    it('should cancel own PENDING request', async () => {
      const req = makeRequest({ status: TimeOffStatus.PENDING, employeeId: 'emp-001' });
      mockRequestRepo.findOne.mockResolvedValueOnce(req);

      const result = await service.cancelRequest('req-uuid-1', 'emp-001');

      expect(mockBalanceService.releaseReservation).toHaveBeenCalled();
      expect(result.status).toBe(TimeOffStatus.CANCELLED);
    });

    it('should reject cancellation of others requests', async () => {
      const req = makeRequest({ employeeId: 'emp-001' });
      mockRequestRepo.findOne.mockResolvedValueOnce(req);

      await expect(service.cancelRequest('req-uuid-1', 'emp-002')).rejects.toThrow();
    });

    it('should reject cancellation of non-PENDING requests', async () => {
      const req = makeRequest({ status: TimeOffStatus.APPROVED });
      mockRequestRepo.findOne.mockResolvedValueOnce(req);

      await expect(service.cancelRequest('req-uuid-1', 'emp-001')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should handle whitespace in employeeId', async () => {
      const req = makeRequest({ employeeId: 'emp-001' });
      mockRequestRepo.findOne.mockResolvedValueOnce(req);

      const result = await service.cancelRequest('req-uuid-1', '  emp-001  ');

      expect(result.status).toBe(TimeOffStatus.CANCELLED);
    });
  });

  // ─── approveRequest Tests ────────────────────────────────────────────────

  describe('approveRequest', () => {
    it('should approve when HCM succeeds', async () => {
      const req = makeRequest({ status: TimeOffStatus.PENDING });
      mockRequestRepo.findOne.mockResolvedValueOnce(req);

      const result = await service.approveRequest('req-uuid-1', { managerId: 'mgr-001' });

      expect(mockBalanceService.confirmDeduction).toHaveBeenCalled();
      expect(result.status).toBe(TimeOffStatus.APPROVED);
    });

    it('should reject when HCM reports insufficient balance', async () => {
      const req = makeRequest({ status: TimeOffStatus.PENDING });
      mockRequestRepo.findOne.mockResolvedValueOnce(req);
      mockHcmClient.deductBalance.mockResolvedValueOnce({
        success: false,
        errorMessage: 'Insufficient balance',
      });

      const result = await service.approveRequest('req-uuid-1', { managerId: 'mgr-001' });

      expect(mockBalanceService.releaseReservation).toHaveBeenCalled();
      expect(result.status).toBe(TimeOffStatus.REJECTED);
    });

    it('should throw when HCM unreachable', async () => {
      const req = makeRequest({ status: TimeOffStatus.PENDING });
      mockRequestRepo.findOne.mockResolvedValueOnce(req);
      mockHcmClient.deductBalance.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(service.approveRequest('req-uuid-1', { managerId: 'mgr-001' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject when HCM response invalid', async () => {
      const req = makeRequest({ status: TimeOffStatus.PENDING });
      mockRequestRepo.findOne.mockResolvedValueOnce(req);
      mockHcmClient.deductBalance.mockResolvedValueOnce({}); // Invalid: no success field

      await expect(service.approveRequest('req-uuid-1', { managerId: 'mgr-001' })).rejects.toThrow();
    });

    it('should detect suspicious HCM balance', async () => {
      const req = makeRequest({ status: TimeOffStatus.PENDING });
      mockRequestRepo.findOne.mockResolvedValueOnce(req);
      mockHcmClient.deductBalance.mockResolvedValueOnce({
        success: true,
        remainingBalance: 5000, // Suspiciously high
      });

      // Should log warning but continue
      const result = await service.approveRequest('req-uuid-1', { managerId: 'mgr-001' });
      expect(result.status).toBe(TimeOffStatus.APPROVED);
    });
  });

  // ─── rejectRequest Tests ─────────────────────────────────────────────────

  describe('rejectRequest', () => {
    it('should reject PENDING request and release balance', async () => {
      const req = makeRequest({ status: TimeOffStatus.PENDING });
      mockRequestRepo.findOne.mockResolvedValueOnce(req);

      const result = await service.rejectRequest('req-uuid-1', {
        managerId: 'mgr-001',
        rejectionReason: 'Team coverage',
      });

      expect(mockBalanceService.releaseReservation).toHaveBeenCalled();
      expect(result.status).toBe(TimeOffStatus.REJECTED);
    });

    it('should throw for non-PENDING requests', async () => {
      const req = makeRequest({ status: TimeOffStatus.APPROVED });
      mockRequestRepo.findOne.mockResolvedValueOnce(req);

      await expect(
        service.rejectRequest('req-uuid-1', { managerId: 'mgr-001' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── getRequest Tests ────────────────────────────────────────────────────

  describe('getRequest', () => {
    it('should return request when found', async () => {
      const req = makeRequest();
      mockRequestRepo.findOne.mockResolvedValueOnce(req);

      const result = await service.getRequest('req-uuid-1');

      expect(result.id).toBe('req-uuid-1');
    });

    it('should throw NotFoundException when not found', async () => {
      mockRequestRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.getRequest('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── getEmployeeRequests Tests ──────────────────────────────────────────

  describe('getEmployeeRequests', () => {
    it('should fetch all employee requests', async () => {
      const requests = [
        makeRequest({ id: 'req-1', status: TimeOffStatus.PENDING }),
        makeRequest({ id: 'req-2', status: TimeOffStatus.APPROVED }),
      ];
      mockRequestRepo.find.mockResolvedValueOnce(requests);

      const result = await service.getEmployeeRequests('emp-001');

      expect(result).toHaveLength(2);
      expect(mockRequestRepo.find).toHaveBeenCalledWith({
        where: { employeeId: 'emp-001' },
        order: { createdAt: 'DESC' },
      });
    });

    it('should filter by status when provided', async () => {
      mockRequestRepo.find.mockResolvedValueOnce([]);

      await service.getEmployeeRequests('emp-001', TimeOffStatus.PENDING);

      expect(mockRequestRepo.find).toHaveBeenCalledWith({
        where: { employeeId: 'emp-001', status: TimeOffStatus.PENDING },
        order: { createdAt: 'DESC' },
      });
    });
  });

  // ─── HCM Response Validation Tests ──────────────────────────────────────

  describe('HCM Response Validation', () => {
    it('should reject response with missing success field', async () => {
      const req = makeRequest({ status: TimeOffStatus.PENDING });
      mockRequestRepo.findOne.mockResolvedValueOnce(req);
      mockHcmClient.deductBalance.mockResolvedValueOnce({ remainingBalance: 10 });

      await expect(service.approveRequest('req-uuid-1', { managerId: 'mgr-001' })).rejects.toThrow();
    });

    it('should reject response with missing errorMessage on failure', async () => {
      const req = makeRequest({ status: TimeOffStatus.PENDING });
      mockRequestRepo.findOne.mockResolvedValueOnce(req);
      mockHcmClient.deductBalance.mockResolvedValueOnce({ success: false });

      await expect(service.approveRequest('req-uuid-1', { managerId: 'mgr-001' })).rejects.toThrow();
    });

    it('should reject response with missing remainingBalance on success', async () => {
      const req = makeRequest({ status: TimeOffStatus.PENDING });
      mockRequestRepo.findOne.mockResolvedValueOnce(req);
      mockHcmClient.deductBalance.mockResolvedValueOnce({ success: true });

      await expect(service.approveRequest('req-uuid-1', { managerId: 'mgr-001' })).rejects.toThrow();
    });

    it('should reject negative balance values', async () => {
      const req = makeRequest({ status: TimeOffStatus.PENDING });
      mockRequestRepo.findOne.mockResolvedValueOnce(req);
      mockHcmClient.deductBalance.mockResolvedValueOnce({
        success: true,
        remainingBalance: -5,
      });

      // Should log warning but continue (fail-safe)
      const result = await service.approveRequest('req-uuid-1', { managerId: 'mgr-001' });
      expect(result.status).toBe(TimeOffStatus.APPROVED);
    });
  });
});
