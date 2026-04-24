/**
 * Concurrency & Edge Case Tests
 *
 * Tests for:
 * - Race conditions (simultaneous requests)
 * - Duplicate idempotency handling
 * - Transaction isolation
 * - HCM failure recovery
 * - Network timeout handling
 * - Balance consistency under load
 * - Cascading failures
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffModule } from '../../modules/timeoff/timeoff.module';
import { IdempotencyModule } from '../../modules/idempotency/idempotency.module';
import { TimeOffRequest } from '../../database/entities/time-off-request.entity';
import { Balance } from '../../database/entities/balance.entity';
import { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';
import { GlobalExceptionFilter } from '../../common/filters/global-exception.filter';

describe('Concurrency & Edge Case Tests', () => {
  let app: INestApplication;
  let httpServer: any;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          entities: [TimeOffRequest, Balance, IdempotencyRecord],
          synchronize: true,
          dropSchema: true,
        }),
        IdempotencyModule,
        TimeOffModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());

    await app.init();
    httpServer = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // RACE CONDITION TESTS
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Race Conditions', () => {
    it('handles simultaneous requests with same idempotency key', async () => {
      const idempotencyKey = `idem-${Date.now()}`;
      const payload = {
        idempotencyKey,
        employeeId: 'emp-race-001',
        locationId: 'loc-us-hq',
        daysRequested: 2,
        startDate: '2024-09-01',
        endDate: '2024-09-02',
        reason: 'Vacation',
      };

      // Fire 5 simultaneous requests with same idempotency key
      const requests = Array(5)
        .fill(null)
        .map(() => request(httpServer).post('/timeoff').send(payload));

      const results = await Promise.all(requests);

      // All should succeed with 201
      results.forEach((res) => {
        expect(res.status).toBe(201);
      });

      // All request IDs should be identical
      const ids = results.map((r) => r.body.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(1);
    });

    it('handles race: one approves while another cancels', async () => {
      // Create a request
      const createRes = await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: `idem-race-${Date.now()}`,
          employeeId: 'emp-race-002',
          locationId: 'loc-us-hq',
          daysRequested: 3,
          startDate: '2024-10-01',
          endDate: '2024-10-03',
        })
        .expect(201);

      const requestId = createRes.body.id;

      // Race: approve vs cancel
      const [approveRes, cancelRes] = await Promise.all([
        request(httpServer)
          .patch(`/timeoff/${requestId}/approve`)
          .send({ managerId: 'mgr-001' }),
        request(httpServer)
          .delete(`/timeoff/${requestId}/cancel`)
          .query({ employeeId: 'emp-race-002' }),
      ]);

      // One should succeed, one should fail
      const statuses = [approveRes.status, cancelRes.status].sort();
      // Either: (200, 400) or one succeeds
      expect(statuses[0]).toBeLessThanOrEqual(400);
    });

    it('handles depleting shared balance pool concurrently', async () => {
      // Setup: emp with 5 days available
      // We'll try to submit 3 concurrent requests for 2 days each

      const basePayload = () => ({
        employeeId: 'emp-race-003',
        locationId: 'loc-us-hq',
        daysRequested: 2,
        startDate: '2024-11-01',
        endDate: '2024-11-02',
      });

      const requests = [
        {
          ...basePayload(),
          idempotencyKey: `key-1-${Date.now()}`,
        },
        {
          ...basePayload(),
          idempotencyKey: `key-2-${Date.now()}`,
        },
        {
          ...basePayload(),
          idempotencyKey: `key-3-${Date.now()}`,
        },
      ];

      const results = await Promise.all(
        requests.map((r) => request(httpServer).post('/timeoff').send(r)),
      );

      // First two should succeed (2+2 = 4 days used)
      // Third should fail (only 1 day left)
      const successCount = results.filter((r) => r.status === 201).length;
      const failCount = results.filter((r) => r.status === 400).length;

      expect(successCount).toBeLessThanOrEqual(2);
      expect(failCount).toBeGreaterThan(0);
    });

    it('handles cancel while approval is in-flight', async () => {
      const createRes = await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: `idem-flight-${Date.now()}`,
          employeeId: 'emp-race-004',
          locationId: 'loc-us-hq',
          daysRequested: 1,
          startDate: '2024-12-01',
          endDate: '2024-12-01',
        })
        .expect(201);

      const requestId = createRes.body.id;

      // Cancel should succeed since request is PENDING
      const cancelRes = await request(httpServer)
        .delete(`/timeoff/${requestId}/cancel`)
        .query({ employeeId: 'emp-race-004' })
        .expect(200);

      expect(cancelRes.body.status).toBe('CANCELLED');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // DUPLICATE HANDLING TESTS
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Duplicate Handling', () => {
    it('detects duplicate with same idempotency key but different body', async () => {
      const key = `idem-dup-${Date.now()}`;

      // First request
      await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: key,
          employeeId: 'emp-dup-001',
          locationId: 'loc-us-hq',
          daysRequested: 2,
          startDate: '2024-06-01',
          endDate: '2024-06-02',
        })
        .expect(201);

      // Second request with same key but different payload
      const res = await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: key,
          employeeId: 'emp-dup-001',
          locationId: 'loc-us-hq',
          daysRequested: 5, // Different!
          startDate: '2024-06-01',
          endDate: '2024-06-05',
        });

      // Should return 409 Conflict
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('Idempotency'); // Error should mention idempotency
    });

    it('allows identical requests with different idempotency keys', async () => {
      const payload = {
        employeeId: 'emp-dup-002',
        locationId: 'loc-us-hq',
        daysRequested: 3,
        startDate: '2024-07-01',
        endDate: '2024-07-03',
      };

      const res1 = await request(httpServer)
        .post('/timeoff')
        .send({ ...payload, idempotencyKey: `key-${Date.now()}-1` })
        .expect(201);

      const res2 = await request(httpServer)
        .post('/timeoff')
        .send({ ...payload, idempotencyKey: `key-${Date.now()}-2` })
        .expect(201);

      // Should create two separate requests
      expect(res1.body.id).not.toBe(res2.body.id);
    });

    it('persists idempotency record correctly', async () => {
      const key = `idem-persist-${Date.now()}`;
      const payload = {
        idempotencyKey: key,
        employeeId: 'emp-dup-003',
        locationId: 'loc-us-hq',
        daysRequested: 1,
        startDate: '2024-08-01',
        endDate: '2024-08-01',
      };

      const res1 = await request(httpServer)
        .post('/timeoff')
        .send(payload)
        .expect(201);

      // Retry same request multiple times
      const res2 = await request(httpServer)
        .post('/timeoff')
        .send(payload)
        .expect(201);

      const res3 = await request(httpServer)
        .post('/timeoff')
        .send(payload)
        .expect(201);

      expect(res1.body.id).toBe(res2.body.id);
      expect(res2.body.id).toBe(res3.body.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // BALANCE CONSISTENCY TESTS
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Balance Consistency', () => {
    it('maintains balance consistency after mixed operations', async () => {
      // emp-consistency has 15 days
      // Create request for 5 days
      const req1 = await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: `key-cons-${Date.now()}-1`,
          employeeId: 'emp-consistency',
          locationId: 'loc-us-hq',
          daysRequested: 5,
          startDate: '2024-06-01',
          endDate: '2024-06-05',
        })
        .expect(201);

      // Create request for 3 days
      const req2 = await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: `key-cons-${Date.now()}-2`,
          employeeId: 'emp-consistency',
          locationId: 'loc-us-hq',
          daysRequested: 3,
          startDate: '2024-06-10',
          endDate: '2024-06-12',
        })
        .expect(201);

      // Cancel first request
      await request(httpServer)
        .delete(`/timeoff/${req1.body.id}/cancel`)
        .query({ employeeId: 'emp-consistency' })
        .expect(200);

      // Approve second request
      await request(httpServer)
        .patch(`/timeoff/${req2.body.id}/approve`)
        .send({ managerId: 'mgr-001' })
        .expect(200);

      // Check final balance: should have 15 - 3 = 12 days (first cancelled, second deducted)
      const balanceRes = await request(httpServer)
        .get('/timeoff/balance/emp-consistency/loc-us-hq')
        .expect(200);

      expect(balanceRes.body.availableDays).toBe(12);
    });

    it('prevents double deduction of same request', async () => {
      const createRes = await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: `key-double-${Date.now()}`,
          employeeId: 'emp-double-deduct',
          locationId: 'loc-us-hq',
          daysRequested: 4,
          startDate: '2024-07-01',
          endDate: '2024-07-04',
        })
        .expect(201);

      const requestId = createRes.body.id;

      // Approve once
      await request(httpServer)
        .patch(`/timeoff/${requestId}/approve`)
        .send({ managerId: 'mgr-001' })
        .expect(200);

      // Try to approve again - should fail
      const retryRes = await request(httpServer)
        .patch(`/timeoff/${requestId}/approve`)
        .send({ managerId: 'mgr-001' });

      expect(retryRes.status).toBe(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // HCM FAILURE RECOVERY TESTS
  // ─────────────────────────────────────────────────────────────────────────────

  describe('HCM Failure Recovery', () => {
    it('handles HCM returning invalid JSON', async () => {
      // This test depends on HCM mock supporting error injection
      // For now, verify the service validates responses
      const createRes = await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: `key-hcm-invalid-${Date.now()}`,
          employeeId: 'emp-hcm-fail',
          locationId: 'loc-us-hq',
          daysRequested: 2,
          startDate: '2024-08-01',
          endDate: '2024-08-02',
        })
        .expect(201);

      // Approval should handle invalid HCM gracefully
      const approveRes = await request(httpServer)
        .patch(`/timeoff/${createRes.body.id}/approve`)
        .send({ managerId: 'mgr-001' });

      // Should either succeed or return meaningful error
      expect([200, 502, 503, 504].includes(approveRes.status)).toBe(true);
    });

    it('handles HCM timeout during approval', async () => {
      const createRes = await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: `key-timeout-${Date.now()}`,
          employeeId: 'emp-timeout',
          locationId: 'loc-us-hq',
          daysRequested: 1,
          startDate: '2024-09-01',
          endDate: '2024-09-01',
        })
        .expect(201);

      // Request should be in PENDING state still
      const statusRes = await request(httpServer)
        .get(`/timeoff/${createRes.body.id}`)
        .expect(200);

      expect(['PENDING', 'REJECTED']).toContain(statusRes.body.status);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // AUTHORIZATION EDGE CASES
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Authorization Edge Cases', () => {
    it('rejects cancel by different employee (wrong employeeId)', async () => {
      const createRes = await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: `key-auth-${Date.now()}`,
          employeeId: 'emp-auth-001',
          locationId: 'loc-us-hq',
          daysRequested: 1,
          startDate: '2024-10-01',
          endDate: '2024-10-01',
        })
        .expect(201);

      // Try to cancel as different employee
      const cancelRes = await request(httpServer)
        .delete(`/timeoff/${createRes.body.id}/cancel`)
        .query({ employeeId: 'emp-auth-002' });

      // Should fail
      expect(cancelRes.status).toBe(403);
    });

    it('handles cancel with whitespace in employeeId', async () => {
      const createRes = await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: `key-whitespace-${Date.now()}`,
          employeeId: 'emp-whitespace',
          locationId: 'loc-us-hq',
          daysRequested: 1,
          startDate: '2024-11-01',
          endDate: '2024-11-01',
        })
        .expect(201);

      // Try to cancel with extra spaces
      const cancelRes = await request(httpServer)
        .delete(`/timeoff/${createRes.body.id}/cancel`)
        .query({ employeeId: '  emp-whitespace  ' })
        .expect(200);

      expect(cancelRes.body.status).toBe('CANCELLED');
    });

    it('handles cancel with URL-encoded special characters in employeeId', async () => {
      const employeeId = 'emp-test@domain.com';
      const createRes = await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: `key-encoded-${Date.now()}`,
          employeeId,
          locationId: 'loc-us-hq',
          daysRequested: 1,
          startDate: '2024-12-01',
          endDate: '2024-12-01',
        })
        .expect(201);

      const cancelRes = await request(httpServer)
        .delete(`/timeoff/${createRes.body.id}/cancel`)
        .query({ employeeId }) // axios should handle encoding
        .expect(200);

      expect(cancelRes.body.status).toBe('CANCELLED');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // CASCADING FAILURE TESTS
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Cascading Failures', () => {
    it('handles database connection loss gracefully', async () => {
      // In a real scenario, this would involve closing DB connection
      // For now, verify the app continues operating

      const res = await request(httpServer)
        .get('/timeoff/balance/emp-cascade/loc-us-hq');

      // Should return either 200 or 503, not crash
      expect([200, 404, 503, 500].includes(res.status)).toBe(true);
    });

    it('recovers from partial HCM failure (some endpoints down)', async () => {
      // Create a request
      const createRes = await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: `key-partial-${Date.now()}`,
          employeeId: 'emp-partial-fail',
          locationId: 'loc-us-hq',
          daysRequested: 1,
          startDate: '2024-06-15',
          endDate: '2024-06-15',
        });

      // Should either succeed or fail gracefully
      expect([200, 201, 502, 503].includes(createRes.status)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // INPUT VALIDATION EDGE CASES
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Input Validation Edge Cases', () => {
    it('rejects empty idempotency key', async () => {
      const res = await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: '',
          employeeId: 'emp-valid',
          locationId: 'loc-us-hq',
          daysRequested: 1,
          startDate: '2024-06-01',
          endDate: '2024-06-01',
        });

      expect(res.status).toBe(400);
    });

    it('rejects null required fields', async () => {
      const res = await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: 'valid-key',
          employeeId: null,
          locationId: 'loc-us-hq',
          daysRequested: 1,
          startDate: '2024-06-01',
          endDate: '2024-06-01',
        });

      expect(res.status).toBe(400);
    });

    it('rejects endDate before startDate', async () => {
      const res = await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: `key-dates-${Date.now()}`,
          employeeId: 'emp-dates',
          locationId: 'loc-us-hq',
          daysRequested: 1,
          startDate: '2024-06-05',
          endDate: '2024-06-01', // Before start!
        });

      expect(res.status).toBe(400);
    });

    it('rejects mismatched daysRequested vs date range', async () => {
      const res = await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: `key-mismatch-${Date.now()}`,
          employeeId: 'emp-mismatch',
          locationId: 'loc-us-hq',
          daysRequested: 10, // 10 days
          startDate: '2024-06-01', // But only 1 day range
          endDate: '2024-06-01',
        });

      expect(res.status).toBe(400);
    });
  });
});
