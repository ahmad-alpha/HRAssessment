# Testing Guide for Time-Off Management System

> Comprehensive test suite covering unit tests, integration tests, E2E tests, and concurrency scenarios.

## 📊 Test Structure

```
src/tests/
├── unit/                 # Unit tests for services
├── integration/          # Integration tests (API + DB)
├── e2e/                  # End-to-end tests
├── concurrency/          # Race conditions & edge cases
├── mocks/               # Mock servers & fixtures
└── setup.ts             # Jest global setup
```

## 🚀 Running Tests

### Run all tests
```bash
npm test
```

### Run specific test suites
```bash
npm run test:unit          # Unit tests only
npm run test:integration   # Integration tests only
npm run test:e2e           # E2E tests only
npm run test:cov          # All tests with coverage
```

## 📋 Test Coverage

- **Unit Tests**: Service method testing with mocked dependencies (~50 cases)
- **Integration Tests**: Database + API layer (~25 cases)
- **E2E Tests**: Full HTTP cycle with mock HCM (~20 cases)
- **Concurrency Tests**: Race conditions and edge cases (~30 cases)

**Total: 125+ test cases**

## 📈 Coverage Targets

- Global threshold: 75% lines/functions, 70% branches
- Core services: 85-90% coverage
- See jest.config.js for detailed thresholds

## 📚 Key Files

- `jest.config.js` - Jest configuration with coverage settings
- `src/tests/setup.ts` - Global Jest setup
- `src/tests/mocks/hcm-mock-server.ts` - Mock HCM backend
- `run-tests.sh` - Comprehensive test runner

## 🔧 View Coverage Report

```bash
npm run test:cov
open coverage/lcov-report/index.html
```

See TEST_IMPLEMENTATION_SUMMARY.md for complete documentation.
