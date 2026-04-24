/**
 * Jest Setup File
 * 
 * Runs after Jest is initialized but before test suites execute.
 */

import 'reflect-metadata';

// Increase test timeout for database operations
jest.setTimeout(30000);

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.DB_TYPE = 'sqlite';
process.env.DB_DATABASE = ':memory:';
process.env.HCM_API_KEY = 'test-key';
process.env.HCM_BASE_URL = 'http://localhost:3001';
