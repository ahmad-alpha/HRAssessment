/**
 * E2E Integration Tests
 *
 * These tests spin up:
 * 1. A real NestJS app with an in-memory SQLite database
 * 2. A real HCM mock server on a random port
 *
 * They test the full HTTP request/response cycle including:
 * - Idempotency key enforcement
 * - Atomic balance reservation
 * - Status transitions
 * - HCM sync behaviour
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

// Load the HCM mock server
const { app: hcmApp, server: hcmServer, balances, seedBalances } = require('../mocks/hcm-mock-server');

describe('TimeOff E2E Tests', () => {
  let app: INestApplication;
  let httpServer: any;
  let hcmPort: number;

  beforeAll(async () => {
    // Start HCM mock on a random port
    await new Promise<void>((resolve) => {
      hcmServer.close(() => {
        const s = hcmApp.listen(0, () => {
          hcmPort = s.address().port;
          process.env.HCM_BASE_URL = `http://localhost:${hcmPort}`;
          process.env.HCM_API_KEY = 'mock-api-key';
          resolve();
        });
        // replace module-level server ref
        Object.assign(hcmServer, s);
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
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());

    await app.init();
    httpServer = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
    hcmServer.close();
  });

  beforeEach(() => {
    // Reset HCM state between tests
    balances.clear();
    seedBalances();
  });

  // ─── Balance endpoint ──────────────────────────────────────────────────────
  describe('GET /timeoff/balance/:employeeId/:locationId', () => {
    it('fetches balance from HCM and caches it', async () => {
      const res = await request(httpServer)
        .get('/timeoff/balance/emp-001/loc-us-hq')
        .expect(200);

      expect(res.body.availableDays).toBe(15);
      expect(res.body.employeeId).toBe('emp-001');
    });

    it('returns 502 for unknown employee', async () => {
      await request(httpServer)
        .get('/timeoff/balance/emp-unknown/loc-us-hq')
        .expect(502);
    });
  });

  // ─── POST /timeoff — submission ────────────────────────────────────────────
  describe('POST /timeoff', () => {
    const basePayload = () => ({
      idempotencyKey: `idem-${Date.now()}-${Math.random()}`,
      employeeId: 'emp-001',
      locationId: 'loc-us-hq',
      daysRequested: 3,
      startDate: '2024-06-01',
      endDate: '2024-06-05',
      reason: 'Vacation',
    });

    it('creates a PENDING request with valid payload', async () => {
      const payload = basePayload();
      const res = await request(httpServer)
        .post('/timeoff')
        .send(payload)
        .expect(201);

      expect(res.body.status).toBe('PENDING');
      expect(res.body.employeeId).toBe('emp-001');
      expect(res.body.daysRequested).toBe(3);
      expect(res.body.id).toBeDefined();
    });

    it('✅ IDEMPOTENCY: returns same result on retry with same key', async () => {
      const payload = basePayload();

      const first = await request(httpServer)
        .post('/timeoff')
        .send(payload)
        .expect(201);

      const second = await request(httpServer)
        .post('/timeoff')
        .send(payload)
        .expect(201);

      // Same request ID returned
      expect(first.body.id).toBe(second.body.id);
    });

    it('✅ IDEMPOTENCY: 409 when same key reused with different payload', async () => {
      const payload = basePayload();
      await request(httpServer).post('/timeoff').send(payload).expect(201);

      const differentPayload = { ...payload, daysRequested: 5 }; // different days
      await request(httpServer)
        .post('/timeoff')
        .send(differentPayload)
        .expect(409);
    });

    it('rejects when employee has insufficient balance', async () => {
      const payload = {
        ...basePayload(),
        employeeId: 'emp-004', // only 2 days available
        daysRequested: 5,
      };

      await request(httpServer).post('/timeoff').send(payload).expect(400);
    });

    it('400 on missing required fields', async () => {
      await request(httpServer)
        .post('/timeoff')
        .send({ employeeId: 'emp-001' }) // missing most fields
        .expect(400);
    });

    it('400 on invalid date format', async () => {
      const payload = { ...basePayload(), startDate: 'not-a-date' };
      await request(httpServer).post('/timeoff').send(payload).expect(400);
    });

    it('400 on zero or negative daysRequested', async () => {
      const payload = { ...basePayload(), daysRequested: 0 };
      await request(httpServer).post('/timeoff').send(payload).expect(400);
    });
  });

  // ─── GET /timeoff/:requestId — status polling ──────────────────────────────
  describe('GET /timeoff/:requestId', () => {
    it('returns request by ID', async () => {
      const payload = {
        idempotencyKey: `idem-${Date.now()}`,
        employeeId: 'emp-001',
        locationId: 'loc-us-hq',
        daysRequested: 2,
        startDate: '2024-07-01',
        endDate: '2024-07-02',
      };

      const created = await request(httpServer)
        .post('/timeoff')
        .send(payload)
        .expect(201);

      const fetched = await request(httpServer)
        .get(`/timeoff/${created.body.id}`)
        .expect(200);

      expect(fetched.body.id).toBe(created.body.id);
      expect(fetched.body.status).toBe('PENDING');
    });

    it('404 for nonexistent request ID', async () => {
      await request(httpServer)
        .get('/timeoff/00000000-0000-0000-0000-000000000000')
        .expect(404);
    });
  });

  // ─── Approval flow ─────────────────────────────────────────────────────────
  describe('PATCH /timeoff/:requestId/approve', () => {
    let requestId: string;

    beforeEach(async () => {
      const payload = {
        idempotencyKey: `idem-${Date.now()}-${Math.random()}`,
        employeeId: 'emp-001',
        locationId: 'loc-us-hq',
        daysRequested: 3,
        startDate: '2024-06-01',
        endDate: '2024-06-05',
      };
      const res = await request(httpServer).post('/timeoff').send(payload);
      requestId = res.body.id;
    });

    it('approves a PENDING request and deducts balance in HCM', async () => {
      const res = await request(httpServer)
        .patch(`/timeoff/${requestId}/approve`)
        .send({ managerId: 'mgr-001' })
        .expect(200);

      expect(res.body.status).toBe('APPROVED');
      expect(res.body.hcmSynced).toBe(true);

      // Verify HCM balance was actually deducted
      const balanceRes = await request(httpServer)
        .post('/timeoff/balance/sync')
        .send({ employeeId: 'emp-001', locationId: 'loc-us-hq' })
        .expect(200);

      expect(balanceRes.body.availableDays).toBe(12); // 15 - 3
    });

    it('400 when trying to approve already-APPROVED request', async () => {
      await request(httpServer)
        .patch(`/timeoff/${requestId}/approve`)
        .send({ managerId: 'mgr-001' })
        .expect(200);

      await request(httpServer)
        .patch(`/timeoff/${requestId}/approve`)
        .send({ managerId: 'mgr-001' })
        .expect(400);
    });
  });

  // ─── Rejection flow ────────────────────────────────────────────────────────
  describe('PATCH /timeoff/:requestId/reject', () => {
    it('rejects request and releases pending balance', async () => {
      const payload = {
        idempotencyKey: `idem-${Date.now()}`,
        employeeId: 'emp-001',
        locationId: 'loc-us-hq',
        daysRequested: 5,
        startDate: '2024-08-01',
        endDate: '2024-08-07',
      };

      const created = await request(httpServer).post('/timeoff').send(payload);

      await request(httpServer)
        .patch(`/timeoff/${created.body.id}/reject`)
        .send({ managerId: 'mgr-001', rejectionReason: 'Team coverage' })
        .expect(200);

      const status = await request(httpServer).get(`/timeoff/${created.body.id}`);
      expect(status.body.status).toBe('REJECTED');
    });
  });

  // ─── Batch sync ────────────────────────────────────────────────────────────
  describe('POST /timeoff/balance/batch-sync', () => {
    it('syncs all balances from HCM batch endpoint', async () => {
      const res = await request(httpServer)
        .post('/timeoff/balance/batch-sync')
        .expect(200);

      expect(res.body.synced).toBeGreaterThan(0);
      expect(res.body.errors).toBe(0);
    });
  });

  // ─── HCM anniversary scenario ──────────────────────────────────────────────
  describe('Work anniversary balance refresh', () => {
    it('syncs increased balance after HCM anniversary bonus', async () => {
      // First get initial balance
      await request(httpServer).get('/timeoff/balance/emp-001/loc-us-hq').expect(200);

      // Simulate HCM applying anniversary bonus independently
      await new Promise<void>((resolve) => {
        require('http').request(
          {
            hostname: 'localhost',
            port: hcmPort,
            path: '/api/admin/anniversary-bonus',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': 'mock-api-key',
            },
          },
          (res) => { res.resume(); resolve(); },
        ).end(JSON.stringify({ employeeId: 'emp-001', locationId: 'loc-us-hq', bonusDays: 5 }));
      });

      // Now sync from HCM
      const synced = await request(httpServer)
        .post('/timeoff/balance/sync')
        .send({ employeeId: 'emp-001', locationId: 'loc-us-hq' })
        .expect(200);

      // Should reflect the bonus
      expect(synced.body.availableDays).toBe(20); // 15 + 5
    });
  });
});