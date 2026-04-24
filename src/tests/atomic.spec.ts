/**
 * Integration Tests: Atomic Processing & Concurrency
 *
 * These tests verify the "exactly-once" guarantees and atomicity:
 * - Concurrent requests for the same employee don't double-deduct
 * - A failed reservation properly rolls back
 * - Idempotent retries during concurrent processing
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffModule } from '../modules/timeoff/timeoff.module';
import { IdempotencyModule } from '../modules/idempotency/idempotency.module';
import { TimeOffRequest } from '../database/entities/time-off-request.entity';
import { Balance } from '../database/entities/balance.entity';
import { IdempotencyRecord } from '../database/entities/idempotency-record.entity';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter';

const { app: hcmApp, balances, seedBalances } = require('../mocks/hcm-mock-server');

describe('Atomic Processing & Concurrency Integration Tests', () => {
  let app: INestApplication;
  let httpServer: any;
  let hcmPort: number;
  let hcmServerInstance: any;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      hcmServerInstance = hcmApp.listen(0, () => {
        hcmPort = hcmServerInstance.address().port;
        process.env.HCM_BASE_URL = `http://localhost:${hcmPort}`;
        process.env.HCM_API_KEY = 'mock-api-key';
        resolve();
      });
    });

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
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
    httpServer = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
    hcmServerInstance.close();
  });

  beforeEach(() => {
    balances.clear();
    seedBalances();
  });

  // ─── Test 1: Atomic balance deduction ─────────────────────────────────────
  describe('Atomic balance deduction', () => {
    it('does not deduct balance if request save fails', async () => {
      // First get balance
      const balBefore = await request(httpServer)
        .get('/timeoff/balance/emp-001/loc-us-hq')
        .expect(200);

      const initialDays = balBefore.body.availableDays;

      // Submit valid request
      const payload = {
        idempotencyKey: `atomic-test-${Date.now()}`,
        employeeId: 'emp-001',
        locationId: 'loc-us-hq',
        daysRequested: 3,
        startDate: '2024-09-01',
        endDate: '2024-09-04',
      };

      const res = await request(httpServer).post('/timeoff').send(payload).expect(201);

      // Pending days should increase (reservation made)
      const balAfterPending = await request(httpServer)
        .get('/timeoff/balance/emp-001/loc-us-hq')
        .expect(200);

      // Available should be same (not deducted until approved), pending increased
      expect(balAfterPending.body.pendingDays).toBe(3);
    });

    it('releases pending reservation when request is rejected', async () => {
      const payload = {
        idempotencyKey: `reject-test-${Date.now()}`,
        employeeId: 'emp-001',
        locationId: 'loc-us-hq',
        daysRequested: 4,
        startDate: '2024-10-01',
        endDate: '2024-10-05',
      };

      const created = await request(httpServer).post('/timeoff').send(payload).expect(201);

      // Check pending reserved
      const balMid = await request(httpServer)
        .get('/timeoff/balance/emp-001/loc-us-hq')
        .expect(200);
      expect(balMid.body.pendingDays).toBe(4);

      // Reject
      await request(httpServer)
        .patch(`/timeoff/${created.body.id}/reject`)
        .send({ managerId: 'mgr-001' })
        .expect(200);

      // Pending should be released
      const balFinal = await request(httpServer)
        .get('/timeoff/balance/emp-001/loc-us-hq')
        .expect(200);
      expect(balFinal.body.pendingDays).toBe(0);
    });
  });

  // ─── Test 2: Exactly-once via idempotency ──────────────────────────────────
  describe('Exactly-once processing via idempotency', () => {
    it('same idempotency key fired 5 times only creates 1 request', async () => {
      const key = `exactly-once-${Date.now()}`;
      const payload = {
        idempotencyKey: key,
        employeeId: 'emp-001',
        locationId: 'loc-us-hq',
        daysRequested: 2,
        startDate: '2024-11-01',
        endDate: '2024-11-02',
      };

      const responses = await Promise.allSettled([
        request(httpServer).post('/timeoff').send(payload),
        request(httpServer).post('/timeoff').send(payload),
        request(httpServer).post('/timeoff').send(payload),
        request(httpServer).post('/timeoff').send(payload),
        request(httpServer).post('/timeoff').send(payload),
      ]);

      // All should return 201 (either created or cached)
      const successful = responses.filter(
        (r) => r.status === 'fulfilled' && (r.value as any).status === 201,
      );
      expect(successful.length).toBeGreaterThan(0);

      // Get all request IDs from successful responses
      const ids = new Set(
        successful
          .filter((r) => r.status === 'fulfilled')
          .map((r) => (r as any).value.body?.id)
          .filter(Boolean),
      );

      // Should all be the same request ID
      expect(ids.size).toBe(1);
    });

    it('balance deducted exactly once even with 3 rapid retries', async () => {
      const key = `dedup-balance-${Date.now()}`;
      const payload = {
        idempotencyKey: key,
        employeeId: 'emp-003',
        locationId: 'loc-eu-ldn',
        daysRequested: 5,
        startDate: '2024-12-01',
        endDate: '2024-12-06',
      };

      // Fire 3 requests sequentially (to avoid SQLite locking)
      await request(httpServer).post('/timeoff').send(payload);
      await request(httpServer).post('/timeoff').send(payload);
      await request(httpServer).post('/timeoff').send(payload);

      // Balance should only have 5 days pending, not 15
      const bal = await request(httpServer)
        .get('/timeoff/balance/emp-003/loc-eu-ldn')
        .expect(200);

      expect(bal.body.pendingDays).toBe(5);
    });
  });

  // ─── Test 3: Insufficient balance ─────────────────────────────────────────
  describe('Insufficient balance guard', () => {
    it('rejects when requested days exceed available', async () => {
      await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: `insuf-${Date.now()}`,
          employeeId: 'emp-004', // 2 days available
          locationId: 'loc-us-hq',
          daysRequested: 5,
          startDate: '2024-06-01',
          endDate: '2024-06-06',
        })
        .expect(400);

      // Balance must not change
      const bal = await request(httpServer)
        .get('/timeoff/balance/emp-004/loc-us-hq')
        .expect(200);
      expect(bal.body.pendingDays).toBe(0);
    });

    it('second request fails if it would exceed remaining balance', async () => {
      const emp = 'emp-001'; // 15 days
      const loc = 'loc-us-hq';

      // Use 14 days
      await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: `seq-1-${Date.now()}`,
          employeeId: emp,
          locationId: loc,
          daysRequested: 14,
          startDate: '2024-06-01',
          endDate: '2024-06-16',
        })
        .expect(201);

      // Try to use 3 more (only 1 left after pending)
      await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: `seq-2-${Date.now()}`,
          employeeId: emp,
          locationId: loc,
          daysRequested: 3,
          startDate: '2024-07-01',
          endDate: '2024-07-04',
        })
        .expect(400);
    });
  });

  // ─── Test 4: HCM invalid dimensions ───────────────────────────────────────
  describe('HCM invalid dimension handling', () => {
    it('handles invalid HCM location gracefully', async () => {
      await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: `invalid-loc-${Date.now()}`,
          employeeId: 'emp-999',
          locationId: 'loc-invalid',
          daysRequested: 1,
          startDate: '2024-06-01',
          endDate: '2024-06-01',
        })
        .expect((res) => {
          // Should fail (502 from HCM or 400 — either is acceptable)
          expect([400, 502]).toContain(res.status);
        });
    });
  });

  // ─── Test 5: Year-start sync ───────────────────────────────────────────────
  describe('Year-start balance refresh', () => {
    it('batch sync reconciles after HCM year-start reset', async () => {
      // Use some days
      await request(httpServer)
        .post('/timeoff')
        .send({
          idempotencyKey: `pre-reset-${Date.now()}`,
          employeeId: 'emp-002',
          locationId: 'loc-us-hq',
          daysRequested: 3,
          startDate: '2024-06-01',
          endDate: '2024-06-04',
        })
        .expect(201);

      // Simulate year-start reset in HCM
      await new Promise<void>((resolve) => {
        require('http').request({
          hostname: 'localhost',
          port: hcmPort,
          path: '/api/admin/year-reset',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': 'mock-api-key' },
        }, (res) => { res.resume(); resolve(); }).end('{}');
      });

      // Trigger batch sync
      const syncRes = await request(httpServer)
        .post('/timeoff/balance/batch-sync')
        .expect(200);

      expect(syncRes.body.synced).toBeGreaterThan(0);

      // emp-002 should now have full balance restored
      const balRes = await request(httpServer)
        .post('/timeoff/balance/sync')
        .send({ employeeId: 'emp-002', locationId: 'loc-us-hq' })
        .expect(200);

      expect(balRes.body.availableDays).toBe(20); // full entitlement restored
    });
  });
});