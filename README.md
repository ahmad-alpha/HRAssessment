# Time-Off Microservice

A NestJS + SQLite microservice for managing employee time-off requests with:

- **Idempotency** — every request carries a key; retries are safe
- **Exactly-once processing** — atomic DB transactions prevent double deductions
- **Status polling** — clients can always query `GET /timeoff/:requestId`
- **HCM sync** — real-time and batch sync with the external HR system

---

## Architecture

```
Client
  │
  ▼
POST /timeoff  ──►  [IdempotencyService]
                         │
                    acquireOrFetch(key, hash)
                         │
                    ┌────▼──────────────────────────┐
                    │   SQLite Transaction (EXCLUSIVE)│
                    │   1. reserveBalance()           │
                    │   2. create TimeOffRequest      │
                    │   3. commit atomically          │
                    └─────────────────────────────────┘
                         │
                    markCompleted(key, response)
```

### Idempotency Key Flow

```
First call   → PROCESSING record created → process → COMPLETED → return result
Retry (same) → COMPLETED record found    → return cached result  (no re-process)
Retry (fail) → FAILED record found       → allow fresh retry
Diff payload → CONFLICT → 409
```

### Request States

```
PENDING ──► APPROVED (manager approves + HCM deducts)
        └─► REJECTED (manager rejects OR HCM refuses)
        └─► CANCELLED (employee cancels)
```

---

## Project Structure

```
src/
├── main.ts                          # Entry point
├── app.module.ts                    # Root module
├── database/
│   ├── database.module.ts           # TypeORM + SQLite config
│   └── entities/
│       ├── time-off-request.entity.ts
│       ├── balance.entity.ts
│       └── idempotency-record.entity.ts
├── common/
│   ├── dto/
│   │   ├── create-timeoff-request.dto.ts
│   │   └── timeoff-actions.dto.ts
│   └── filters/
│       └── global-exception.filter.ts
└── modules/
    ├── idempotency/
    │   ├── idempotency.module.ts
    │   └── idempotency.service.ts   # ← Core idempotency logic
    ├── balance/
    │   └── balance.service.ts       # ← Atomic balance operations
    ├── hcm-sync/
    │   └── hcm-client.service.ts    # ← HCM API client
    └── timeoff/
        ├── timeoff.module.ts
        ├── timeoff.service.ts       # ← Business logic
        └── timeoff.controller.ts    # ← REST endpoints

test/
├── mocks/
│   └── hcm-mock-server.js          # Standalone Express HCM simulator
├── unit/
│   ├── idempotency.service.spec.ts
│   ├── balance.service.spec.ts
│   └── timeoff.service.spec.ts
├── integration/
│   └── atomic.spec.ts              # Concurrency + atomic tests
└── e2e/
    └── timeoff.e2e.spec.ts         # Full HTTP cycle tests
```

---

## Setup

```bash
npm install
```

## Run

```bash
# Development
npm run start:dev

# Production
npm run build && npm start:prod
```

## Environment Variables

| Variable        | Default                  | Description                  |
|-----------------|--------------------------|------------------------------|
| `PORT`          | `3000`                   | Service port                 |
| `DB_PATH`       | `timeoff.db`             | SQLite database file path    |
| `HCM_BASE_URL`  | `http://localhost:3001`  | HCM system base URL          |
| `HCM_API_KEY`   | `mock-api-key`           | API key for HCM auth         |

## Run HCM Mock Server

```bash
npm run mock:hcm
# Starts on http://localhost:3001
```

The mock server seeds these employees:
| Employee   | Location      | Available | Total |
|------------|---------------|-----------|-------|
| emp-001    | loc-us-hq     | 15        | 15    |
| emp-002    | loc-us-hq     | 10        | 20    |
| emp-003    | loc-eu-ldn    | 25        | 25    |
| emp-004    | loc-us-hq     | 2         | 15    |

---

## Tests

```bash
# All tests
npm test

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# E2E tests (starts real HTTP server + HCM mock)
npm run test:e2e

# Coverage report
npm run test:cov
```

---

## REST API Reference

### Submit Request (Idempotent)
```
POST /timeoff
Content-Type: application/json

{
  "idempotencyKey": "emp-123-2024-06-01-req-1",  ← REQUIRED for safe retry
  "employeeId": "emp-001",
  "locationId": "loc-us-hq",
  "daysRequested": 3,
  "startDate": "2024-06-01",
  "endDate": "2024-06-05",
  "reason": "Vacation"
}
```

### Poll Status
```
GET /timeoff/:requestId
→ { id, status: "PENDING"|"APPROVED"|"REJECTED"|"CANCELLED", ... }
```

### Approve
```
PATCH /timeoff/:requestId/approve
{ "managerId": "mgr-001" }
```

### Reject
```
PATCH /timeoff/:requestId/reject
{ "managerId": "mgr-001", "rejectionReason": "..." }
```

### Cancel (by employee)
```
DELETE /timeoff/:requestId/cancel?employeeId=emp-001
```

### Get Balance
```
GET /timeoff/balance/:employeeId/:locationId
```

### Sync Balance from HCM (real-time)
```
POST /timeoff/balance/sync
{ "employeeId": "emp-001", "locationId": "loc-us-hq" }
```

### Batch Sync (all employees)
```
POST /timeoff/balance/batch-sync
→ { "synced": 42, "errors": 0 }
```

---

## Key Design Decisions

### Why SQLite EXCLUSIVE transactions?
SQLite doesn't support `SELECT FOR UPDATE` in standard mode, so we use `EXCLUSIVE` transaction isolation. This ensures only one transaction at a time modifies balance rows, preventing double deductions under concurrent load.

### Why is idempotencyKey separate from requestId?
- `requestId` (UUID) → server-generated, returned in response
- `idempotencyKey` → client-generated, sent with request; used to deduplicate retries

This allows the client to check status via `GET /timeoff/{requestId}` even if the original POST timed out.

### Why mark FAILED records differently?
If a request fails (e.g., DB error after HCM deduction), the idempotency record is marked FAILED. The client can retry with the same key, and the system will reprocess — avoiding a case where a failed request can never be retried.

### Defensive HCM validation
Even though HCM guarantees error responses "most of the time", we:
1. Always call HCM before approving
2. Keep the request PENDING (not auto-approve) if HCM is unreachable
3. Reconcile local balances via batch sync after HCM-side changes