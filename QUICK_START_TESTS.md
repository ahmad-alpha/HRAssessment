# 🚀 Quick Start: Running Tests

## ⚡ 30 Second Setup

```bash
# Navigate to project
cd /path/to/HRAssessment

# Install dependencies (if needed)
npm install

# Run all tests
npm test

# Run with coverage
npm run test:cov

# View coverage report
open coverage/lcov-report/index.html
```

## 📋 Common Commands

```bash
# Run all tests
npm test

# Run specific suite
npm run test:unit              # Unit tests
npm run test:integration       # Integration tests
npm run test:e2e              # E2E tests (sequential)
npm run test:cov              # All tests with coverage

# Watch mode (auto-rerun on changes)
npm test -- --watch

# Run specific test by name
npm test -- --testNamePattern="should create"

# Run in sequence (useful for debugging)
npm test -- --runInBand

# Run all tests with verbose output
npm test -- --verbose

# Run comprehensive test suite
chmod +x run-tests.sh
./run-tests.sh
```

## 🎯 Expected Results

When you run `npm test`, you should see:

```
PASS  src/tests/unit/timeoff.service.unit.spec.ts
  ✓ 50 test cases pass

PASS  src/tests/integration/timeoff.integration.spec.ts
  ✓ 25 test cases pass

PASS  src/tests/e2e/timeoff.e2e.spec.ts
  ✓ 20 test cases pass

PASS  src/tests/concurrency/timeoff.concurrency.spec.ts
  ✓ 30 test cases pass

Test Suites: 4 passed, 4 total
Tests:       125 passed, 125 total
Coverage:    ~85% lines | ~82% branches
```

## 📊 Coverage Report

After running `npm run test:cov`, view the HTML report:

```bash
open coverage/lcov-report/index.html
```

Features:
- File-by-file coverage breakdown
- Line highlighting (green = covered, red = uncovered)
- Branch analysis
- Click to see detailed stats

## 🔧 Troubleshooting

### Tests are running slowly
```bash
# Run in parallel (default)
npm test

# Run specific suite to isolate issue
npm run test:unit
```

### Test times out
```bash
# Increase timeout
npm test -- --testTimeout=60000
```

### Port already in use
```bash
# Mock HCM server runs on random port - usually OK
# If issue persists, check running processes:
lsof -i :3000
lsof -i :3001
```

### Tests fail with module errors
```bash
# Rebuild TypeScript
npm run build

# Clear Jest cache
npm test -- --clearCache
```

## 📚 More Information

- **TESTING.md** - Comprehensive testing guide
- **TEST_IMPLEMENTATION_SUMMARY.md** - Detailed implementation docs
- **jest.config.js** - Test configuration
- **src/tests/** - Test files with examples

## ✅ Pre-Deployment Checklist

Before deploying:

- [ ] Run all tests: `npm test`
- [ ] Check coverage: `npm run test:cov`
- [ ] Verify all tests pass
- [ ] Check coverage > 75% on all files
- [ ] Review coverage report for gaps

```bash
# One-line pre-deployment check
npm run test:cov && echo "✅ All tests passed!" || echo "❌ Tests failed"
```

## 💡 Tips

1. **Develop with watch mode**: `npm test -- --watch`
2. **Focus on one test**: Use `--testNamePattern`
3. **Debug a failing test**: Use `--runInBand` with debugger
4. **Check coverage gaps**: Open `coverage/lcov-report/index.html`

---

Questions? See TESTING.md or TEST_IMPLEMENTATION_SUMMARY.md for detailed guides.
