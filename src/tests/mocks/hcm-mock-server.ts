/**
 * Mock HCM Server
 *
 * Simulates the HR/HCM backend with:
 * - Employee balances database
 * - Balance deduction endpoint
 * - Batch sync endpoint
 * - Error simulation endpoints
 * - Anniversary bonus endpoint
 */

import * as express from 'express';
import * as http from 'http';

// In-memory balance storage
const balances = new Map<string, { availableDays: number; lastSynced: Date }>();

/**
 * Initialize balances with test data
 */
function seedBalances() {
  balances.set('emp-001|loc-us-hq', { availableDays: 15, lastSynced: new Date() });
  balances.set('emp-002|loc-us-hq', { availableDays: 10, lastSynced: new Date() });
  balances.set('emp-003|loc-eu-london', { availableDays: 25, lastSynced: new Date() });
  balances.set('emp-004|loc-us-hq', { availableDays: 2, lastSynced: new Date() });
  balances.set('emp-005|loc-us-sf', { availableDays: 0, lastSynced: new Date() });
}

// Create Express app
const app = express();
app.use(express.json());

// Middleware: API key validation
app.use((req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query['api_key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key' });
  }
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/employees/:id/balance
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/employees/:id/balance', (req, res) => {
  const { id } = req.params;
  const locationId = (req.query.location_id as string) || 'loc-us-hq';
  const key = `${id}|${locationId}`;

  if (!balances.has(key)) {
    return res.status(404).json({
      error: 'Employee not found',
      employeeId: id,
      locationId,
    });
  }

  const balance = balances.get(key)!;
  res.json({
    employeeId: id,
    locationId,
    availableDays: balance.availableDays,
    lastSynced: balance.lastSynced.toISOString(),
    fiscal_year: new Date().getFullYear(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/employees/:id/deduct-balance
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/employees/:id/deduct-balance', (req, res) => {
  const { id } = req.params;
  const { days, location_id, request_id } = req.body;
  const locationId = location_id || 'loc-us-hq';
  const key = `${id}|${locationId}`;

  // Validation
  if (!days || typeof days !== 'number' || days <= 0) {
    return res.status(400).json({ error: 'Invalid days value', success: false });
  }

  if (!balances.has(key)) {
    return res.status(404).json({
      error: 'Employee not found',
      success: false,
      errorCode: 'EMPLOYEE_NOT_FOUND',
    });
  }

  const balance = balances.get(key)!;

  // Check if sufficient balance
  if (balance.availableDays < days) {
    return res.status(400).json({
      error: `Insufficient balance. Available: ${balance.availableDays}, Requested: ${days}`,
      success: false,
      errorCode: 'INSUFFICIENT_BALANCE',
      availableDays: balance.availableDays,
    });
  }

  // Deduct balance
  balance.availableDays -= days;
  balance.lastSynced = new Date();

  res.json({
    success: true,
    employeeId: id,
    locationId,
    requestId: request_id || `req-${Date.now()}`,
    balanceAfter: balance.availableDays,
    deductedDays: days,
    transactionId: `txn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    details: {
      statusCode: 200,
      statusMessage: 'Balance deducted successfully',
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/employees/batch-sync
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/employees/batch-sync', (req, res) => {
  const { employee_ids } = req.body;

  if (!Array.isArray(employee_ids) || employee_ids.length === 0) {
    return res.status(400).json({ error: 'Invalid employee_ids' });
  }

  const results = employee_ids.map((empId) => {
    const key = `${empId}|loc-us-hq`;
    const balance = balances.get(key);

    return {
      employeeId: empId,
      locationId: 'loc-us-hq',
      status: balance ? 'synced' : 'not_found',
      availableDays: balance?.availableDays || null,
    };
  });

  res.json({
    synced: results.filter((r) => r.status === 'synced').length,
    notFound: results.filter((r) => r.status === 'not_found').length,
    errors: 0,
    results,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/anniversary-bonus
// Simulate external balance update (e.g., work anniversary)
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/admin/anniversary-bonus', (req, res) => {
  const { employeeId, locationId, bonusDays } = req.body;
  const key = `${employeeId}|${locationId}`;

  if (!balances.has(key)) {
    return res.status(404).json({ error: 'Employee not found' });
  }

  const balance = balances.get(key)!;
  balance.availableDays += bonusDays;
  balance.lastSynced = new Date();

  res.json({
    success: true,
    employeeId,
    locationId,
    bonusDaysAdded: bonusDays,
    newBalance: balance.availableDays,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/simulate-error
// Simulate error conditions for testing retry logic
// ─────────────────────────────────────────────────────────────────────────────

let errorSimulationCounter = 0;

app.post('/api/admin/simulate-error', (req, res) => {
  const { errorType, employeeId, duration = 5000 } = req.body;

  if (errorType === 'timeout') {
    // Simulate timeout by not responding
    setTimeout(() => {
      res.status(408).json({ error: 'Request timeout' });
    }, duration + 1000); // Intentionally longer than timeout
  } else if (errorType === 'service-unavailable') {
    res.status(503).json({ error: 'Service temporarily unavailable' });
  } else if (errorType === 'intermittent') {
    // First call fails, second succeeds
    errorSimulationCounter++;
    if (errorSimulationCounter % 2 === 1) {
      return res.status(500).json({ error: 'Intermittent error' });
    }
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Unknown error type' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/reset
// Reset mock server state (for testing)
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/admin/reset', (req, res) => {
  balances.clear();
  seedBalances();
  errorSimulationCounter = 0;

  res.json({ message: 'Mock server reset', balancesSeeded: balances.size });
});

// ─────────────────────────────────────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Initialize
seedBalances();

// Export for testing
const server = http.createServer(app);

module.exports = { app, server, balances, seedBalances };
