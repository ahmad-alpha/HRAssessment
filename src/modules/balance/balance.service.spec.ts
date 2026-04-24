import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { BalanceService } from './balance.service';
import { Balance } from '../../database/entities/balance.entity';
import { HcmClientService } from '../hcm-sync/hcm-client.service';
import { DataSource } from 'typeorm';

const makeBalance = (overrides: Partial<Balance> = {}): Balance =>
  ({
    id: 'bal-1',
    employeeId: 'emp-001',
    locationId: 'loc-us-hq',
    availableDays: 15,
    usedDays: 0,
    pendingDays: 0,
    totalDays: 15,
    version: 0,
    lastHcmSync: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Balance);

const makeQueryRunner = (balance: Balance | null) => ({
  connect: jest.fn(),
  startTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  rollbackTransaction: jest.fn(),
  release: jest.fn(),
  manager: {
    createQueryBuilder: jest.fn().mockReturnValue({
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(balance),
    }),
    create: jest.fn().mockImplementation((_, data) => data),
    save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
  },
});

describe('BalanceService', () => {
  let service: BalanceService;
  let mockRepo: any;
  let mockHcmClient: any;
  let mockDataSource: any;

  beforeEach(async () => {
    mockRepo = {
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((data) => data),
      save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
    };

    mockHcmClient = {
      getBalance: jest.fn().mockResolvedValue({
        employeeId: 'emp-001',
        locationId: 'loc-us-hq',
        availableDays: 15,
        totalDays: 15,
        usedDays: 0,
      }),
    };

    mockDataSource = { createQueryRunner: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceService,
        { provide: getRepositoryToken(Balance), useValue: mockRepo },
        { provide: HcmClientService, useValue: mockHcmClient },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<BalanceService>(BalanceService);
  });

  // ─── getBalance ────────────────────────────────────────────────────────────
  describe('getBalance', () => {
    it('returns local balance from DB when cached', async () => {
      const bal = makeBalance();
      mockRepo.findOne.mockResolvedValue(bal);

      const result = await service.getBalance('emp-001', 'loc-us-hq');

      expect(result).toEqual(bal);
      expect(mockHcmClient.getBalance).not.toHaveBeenCalled();
    });

    it('fetches from HCM and seeds DB when not cached', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      const savedBal = makeBalance();
      mockRepo.save.mockResolvedValue(savedBal);

      const result = await service.getBalance('emp-001', 'loc-us-hq');

      expect(mockHcmClient.getBalance).toHaveBeenCalledWith('emp-001', 'loc-us-hq');
      expect(mockRepo.save).toHaveBeenCalled();
    });
  });

  // ─── reserveBalance ────────────────────────────────────────────────────────
  describe('reserveBalance', () => {
    it('succeeds when sufficient balance is available', async () => {
      const balance = makeBalance({ availableDays: 10, pendingDays: 0 });
      const qr = makeQueryRunner(balance);

      await service.reserveBalance('emp-001', 'loc-us-hq', 3, qr as any);

      expect(qr.manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ pendingDays: 3 }),
      );
    });

    it('throws BadRequestException when balance is insufficient', async () => {
      const balance = makeBalance({ availableDays: 2, pendingDays: 0 });
      const qr = makeQueryRunner(balance);

      await expect(
        service.reserveBalance('emp-001', 'loc-us-hq', 5, qr as any),
      ).rejects.toThrow(BadRequestException);

      expect(qr.manager.save).not.toHaveBeenCalled();
    });

    it('accounts for existing pending days in availability check', async () => {
      // 10 available, 8 pending → effective = 2 → requesting 3 should fail
      const balance = makeBalance({ availableDays: 10, pendingDays: 8 });
      const qr = makeQueryRunner(balance);

      await expect(
        service.reserveBalance('emp-001', 'loc-us-hq', 3, qr as any),
      ).rejects.toThrow('Insufficient balance');
    });

    it('fetches from HCM when no local record exists', async () => {
      const qr = makeQueryRunner(null); // no local balance
      const newBal = makeBalance();
      qr.manager.save.mockResolvedValue(newBal);

      await service.reserveBalance('emp-001', 'loc-us-hq', 2, qr as any);

      expect(mockHcmClient.getBalance).toHaveBeenCalledWith('emp-001', 'loc-us-hq');
    });

    it('increments version on every mutation', async () => {
      const balance = makeBalance({ availableDays: 10, pendingDays: 0, version: 5 });
      const qr = makeQueryRunner(balance);

      await service.reserveBalance('emp-001', 'loc-us-hq', 2, qr as any);

      expect(qr.manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ version: 6 }),
      );
    });
  });

  // ─── confirmDeduction ──────────────────────────────────────────────────────
  describe('confirmDeduction', () => {
    it('deducts from availableDays and adds to usedDays', async () => {
      const balance = makeBalance({ availableDays: 10, usedDays: 5, pendingDays: 3 });
      const qr = makeQueryRunner(balance);

      await service.confirmDeduction('emp-001', 'loc-us-hq', 3, qr as any);

      expect(qr.manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          availableDays: 7,
          usedDays: 8,
          pendingDays: 0,
        }),
      );
    });

    it('throws NotFoundException when balance record missing', async () => {
      const qr = makeQueryRunner(null);

      await expect(
        service.confirmDeduction('emp-404', 'loc-us-hq', 1, qr as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('does not allow pendingDays to go below 0', async () => {
      const balance = makeBalance({ availableDays: 10, pendingDays: 1 });
      const qr = makeQueryRunner(balance);

      await service.confirmDeduction('emp-001', 'loc-us-hq', 3, qr as any);

      const savedArg = qr.manager.save.mock.calls[0][0];
      expect(savedArg.pendingDays).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── releaseReservation ────────────────────────────────────────────────────
  describe('releaseReservation', () => {
    it('releases pending days when request is rejected', async () => {
      const balance = makeBalance({ pendingDays: 5 });
      const qr = makeQueryRunner(balance);

      await service.releaseReservation('emp-001', 'loc-us-hq', 3, qr as any);

      expect(qr.manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ pendingDays: 2 }),
      );
    });

    it('floors pendingDays at 0 to prevent negative values', async () => {
      const balance = makeBalance({ pendingDays: 1 });
      const qr = makeQueryRunner(balance);

      await service.releaseReservation('emp-001', 'loc-us-hq', 5, qr as any);

      const savedArg = qr.manager.save.mock.calls[0][0];
      expect(savedArg.pendingDays).toBe(0);
    });
  });

  // ─── syncFromHcm ───────────────────────────────────────────────────────────
  describe('syncFromHcm', () => {
    it('updates local balance from HCM data', async () => {
      const localBal = makeBalance({ availableDays: 10 });
      mockRepo.findOne.mockResolvedValue(localBal);
      mockHcmClient.getBalance.mockResolvedValue({
        availableDays: 20, // anniversary bonus applied in HCM
        totalDays: 20,
        usedDays: 0,
      });
      mockRepo.save.mockResolvedValue({ ...localBal, availableDays: 20 });

      const result = await service.syncFromHcm('emp-001', 'loc-us-hq');

      expect(mockRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ availableDays: 20 }),
      );
    });

    it('creates new record if one does not exist locally', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      mockRepo.save.mockResolvedValue(makeBalance());

      await service.syncFromHcm('emp-001', 'loc-us-hq');

      expect(mockRepo.save).toHaveBeenCalled();
    });
  });
});