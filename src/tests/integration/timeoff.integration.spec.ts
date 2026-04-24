import { INestApplication, BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { TimeOffModule } from '../../modules/timeoff/timeoff.module';
import { DatabaseModule } from '../../database/database.module';
import { TimeOffRequest, TimeOffStatus } from '../../database/entities/time-off-request.entity';
import { Balance } from '../../database/entities/balance.entity';
import { v4 as uuidv4 } from 'uuid';

/**
 * INTEGRATION TESTS
 * Covers: API endpoints, database operations, transaction handling
 */

describe('TimeOff API - Integration Tests', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [DatabaseModule, TimeOffModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    dataSource = moduleFixture.get<DataSource>(DataSource);

    // Clear tables before tests
    await clearDatabase();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  const clearDatabase = async () => {
    const queryRunner = dataSource.createQueryRunner();
    try {
      await queryRunner.query('DELETE FROM time_off_request');
      await queryRunner.query('DELETE FROM balance');
      await queryRunner.query('DELETE FROM idempotency_record');
    } finally {
      await queryRunner.release();
    }
  };

  const seedBalance = async (
    employeeId: string,
    locationId: string,
    availableDays: number = 15,
  ) => {
    const balanceRepo = dataSource.getRepository(Balance);
    return balanceRepo.save({
      employeeId,
      locationId,
      availableDays,
      reservedDays: 0,
      usedDays: 0,
      totalDays: 20,
    });
  };

  // ─── POST /timeoff (Create Request) ────────────────────────────────────

  describe('POST /timeoff - Create Request', () => {
    it('should create request with valid data and sufficient balance', async () => {
      await seedBalance('emp-001', 'loc-us-hq', 15);

      const response = await request(app.getHttpServer())
        .post('/timeoff')
        .send({
          idempotencyKey: uuidv4(),
          employeeId: 'emp-001',
          locationId: 'loc-us-hq',
          daysRequested: 3,
          startDate: '2024-06-01',
          endDate: '2024-06-03',
          reason: 'Vacation',
        });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe(TimeOffStatus.PENDING);
      expect(response.body.daysRequested).toBe(3);

      // Verify balance was reserved
      const balanceRepo = dataSource.getRepository(Balance);
      const balance = await balanceRepo.findOne({
        where: { employeeId: 'emp-001', locationId: 'loc-us-hq' },
      });
      expect(balance.reservedDays).toBe(3);
    });

    it('should reject request with insufficient balance', async () => {
      await seedBalance('emp-001', 'loc-us-hq', 2); // Only 2 days available

      const response = await request(app.getHttpServer())
        .post('/timeoff')
        .send({
          idempotencyKey: uuidv4(),
          employeeId: 'emp-001',
          locationId: 'loc-us-hq',
          daysRequested: 5,
          startDate: '2024-06-01',
          endDate: '2024-06-05',
        });

      expect(response.status).toBe(400);
    });

    it('should handle idempotent duplicate submissions', async () => {
      await seedBalance('emp-001', 'loc-us-hq', 15);
      const idempotencyKey = uuidv4();

      // First submission
      const res1 = await request(app.getHttpServer())
        .post('/timeoff')
        .send({
          idempotencyKey,
          employeeId: 'emp-001',
          locationId: 'loc-us-hq',
          daysRequested: 3,
          startDate: '2024-06-01',
          endDate: '2024-06-03',
        });

      // Duplicate submission with same key
      const res2 = await request(app.getHttpServer())
        .post('/timeoff')
        .send({
          idempotencyKey,
          employeeId: 'emp-001',
          locationId: 'loc-us-hq',
          daysRequested: 3,
          startDate: '2024-06-01',
          endDate: '2024-06-03',
        });

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res1.body.id).toBe(res2.body.id); // Same ID both times
    });

    it('should reject duplicate submission with different payload', async () => {
      await seedBalance('emp-001', 'loc-us-hq', 15);
      const idempotencyKey = uuidv4();

      // First submission
      await request(app.getHttpServer())
        .post('/timeoff')
        .send({
          idempotencyKey,
          employeeId: 'emp-001',
          locationId: 'loc-us-hq',
          daysRequested: 3,
          startDate: '2024-06-01',
          endDate: '2024-06-03',
        });

      // Different payload with same key
      const response = await request(app.getHttpServer())
        .post('/timeoff')
        .send({
          idempotencyKey,
          employeeId: 'emp-001',
          locationId: 'loc-us-hq',
          daysRequested: 5, // Different!
          startDate: '2024-06-01',
          endDate: '2024-06-05',
        });

      expect(response.status).toBe(409); // Conflict
    });
  });

  // ─── GET /timeoff/employee/:employeeId ────────────────────────────────

  describe('GET /timeoff/employee/:employeeId', () => {
    it('should list employee requests', async () => {
      const requestRepo = dataSource.getRepository(TimeOffRequest);
      await requestRepo.save({
        employeeId: 'emp-001',
        locationId: 'loc-us-hq',
        daysRequested: 3,
        startDate: '2024-06-01',
        endDate: '2024-06-03',
        status: TimeOffStatus.PENDING,
        idempotencyKey: uuidv4(),
      });

      const response = await request(app.getHttpServer())
        .get('/timeoff/employee/emp-001');

      expect(response.status).toBe(200);
      expect(response.body).toBeInstanceOf(Array);
      expect(response.body.length).toBe(1);
      expect(response.body[0].employeeId).toBe('emp-001');
    });

    it('should return empty array for employee with no requests', async () => {
      const response = await request(app.getHttpServer())
        .get('/timeoff/employee/emp-nonexistent');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });
  });

  // ─── DELETE /timeoff/:requestId/cancel ──────────────────────────────

  describe('DELETE /timeoff/:requestId/cancel', () => {
    it('should cancel own PENDING request', async () => {
      const requestRepo = dataSource.getRepository(TimeOffRequest);
      const req = await requestRepo.save({
        employeeId: 'emp-001',
        locationId: 'loc-us-hq',
        daysRequested: 3,
        startDate: '2024-06-01',
        endDate: '2024-06-03',
        status: TimeOffStatus.PENDING,
        idempotencyKey: uuidv4(),
      });

      await seedBalance('emp-001', 'loc-us-hq', 15);

      const response = await request(app.getHttpServer())
        .delete(`/timeoff/${req.id}/cancel`)
        .query({ employeeId: 'emp-001' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe(TimeOffStatus.CANCELLED);
    });

    it('should reject cancellation by wrong employee', async () => {
      const requestRepo = dataSource.getRepository(TimeOffRequest);
      const req = await requestRepo.save({
        employeeId: 'emp-001',
        locationId: 'loc-us-hq',
        daysRequested: 3,
        startDate: '2024-06-01',
        endDate: '2024-06-03',
        status: TimeOffStatus.PENDING,
        idempotencyKey: uuidv4(),
      });

      const response = await request(app.getHttpServer())
        .delete(`/timeoff/${req.id}/cancel`)
        .query({ employeeId: 'emp-002' });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('cancel your own requests');
    });

    it('should reject cancellation of non-PENDING request', async () => {
      const requestRepo = dataSource.getRepository(TimeOffRequest);
      const req = await requestRepo.save({
        employeeId: 'emp-001',
        locationId: 'loc-us-hq',
        daysRequested: 3,
        startDate: '2024-06-01',
        endDate: '2024-06-03',
        status: TimeOffStatus.APPROVED,
        idempotencyKey: uuidv4(),
      });

      const response = await request(app.getHttpServer())
        .delete(`/timeoff/${req.id}/cancel`)
        .query({ employeeId: 'emp-001' });

      expect(response.status).toBe(400);
    });

    it('should return 404 for nonexistent request', async () => {
      const response = await request(app.getHttpServer())
        .delete('/timeoff/00000000-0000-0000-0000-000000000000/cancel')
        .query({ employeeId: 'emp-001' });

      expect(response.status).toBe(404);
    });
  });

  // ─── Transaction Tests ──────────────────────────────────────────────────

  describe('Transaction Handling', () => {
    it('should rollback on balance reserve failure', async () => {
      // No balance available
      const requestRepo = dataSource.getRepository(TimeOffRequest);

      const response = await request(app.getHttpServer())
        .post('/timeoff')
        .send({
          idempotencyKey: uuidv4(),
          employeeId: 'emp-001',
          locationId: 'loc-us-hq',
          daysRequested: 100,
          startDate: '2024-06-01',
          endDate: '2024-08-09',
        });

      expect(response.status).toBe(400);

      // Verify request was not created
      const requests = await requestRepo.find({ where: { employeeId: 'emp-001' } });
      expect(requests).toHaveLength(0);
    });

    it('should rollback when balance update fails during cancel', async () => {
      const requestRepo = dataSource.getRepository(TimeOffRequest);
      const req = await requestRepo.save({
        employeeId: 'emp-001',
        locationId: 'loc-us-hq',
        daysRequested: 3,
        startDate: '2024-06-01',
        endDate: '2024-06-03',
        status: TimeOffStatus.PENDING,
        idempotencyKey: uuidv4(),
      });

      // Try to cancel without balance (edge case)
      const response = await request(app.getHttpServer())
        .delete(`/timeoff/${req.id}/cancel`)
        .query({ employeeId: 'emp-001' });

      // Verify request status unchanged if error
      if (response.status !== 200) {
        const updated = await requestRepo.findOne({ where: { id: req.id } });
        expect(updated.status).toBe(TimeOffStatus.PENDING);
      }
    });
  });

  // ─── Concurrent Request Tests ──────────────────────────────────────────

  describe('Concurrent Operations', () => {
    it('should handle concurrent cancel attempts gracefully', async () => {
      const requestRepo = dataSource.getRepository(TimeOffRequest);
      const req = await requestRepo.save({
        employeeId: 'emp-001',
        locationId: 'loc-us-hq',
        daysRequested: 3,
        startDate: '2024-06-01',
        endDate: '2024-06-03',
        status: TimeOffStatus.PENDING,
        idempotencyKey: uuidv4(),
      });

      await seedBalance('emp-001', 'loc-us-hq', 15);

      // Fire concurrent cancels
      const promises = Array(3)
        .fill(null)
        .map(() =>
          request(app.getHttpServer())
            .delete(`/timeoff/${req.id}/cancel`)
            .query({ employeeId: 'emp-001' }),
        );

      const responses = await Promise.all(promises);

      // First should succeed, others should fail or return cancelled state
      const successCount = responses.filter((r) => r.status === 200).length;
      expect(successCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Error Handling Tests ──────────────────────────────────────────────

  describe('Error Handling', () => {
    it('should return 400 for invalid payload', async () => {
      const response = await request(app.getHttpServer())
        .post('/timeoff')
        .send({
          // Missing required fields
          employeeId: 'emp-001',
        });

      expect(response.status).toBe(400);
    });

    it('should handle missing idempotency key gracefully', async () => {
      await seedBalance('emp-001', 'loc-us-hq', 15);

      const response = await request(app.getHttpServer())
        .post('/timeoff')
        .send({
          // Intentionally no idempotencyKey
          employeeId: 'emp-001',
          locationId: 'loc-us-hq',
          daysRequested: 3,
          startDate: '2024-06-01',
          endDate: '2024-06-03',
        });

      expect(response.status).toBe(400);
    });
  });
});
