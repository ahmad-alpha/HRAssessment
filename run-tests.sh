#!/bin/bash

# Comprehensive Test Suite Runner
# Runs all test suites (unit, integration, E2E, concurrency) with coverage reporting

set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "    HR Time-Off Management System - Comprehensive Test Suite"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

LOG_DIR="logs"
LOG_FILE="${LOG_DIR}/test-run-$(date +%Y%m%d-%H%M%S).txt"

mkdir -p "${LOG_DIR}"

# Capture all output to a timestamped log file while still printing to console
exec > >(tee "${LOG_FILE}") 2>&1

# Function to run a test suite
run_test_suite() {
  local suite_name=$1
  local test_pattern=$2
  
  echo -e "${BLUE}Running ${suite_name}...${NC}"
  echo ""
  
  if npm test -- --testPathPattern="$test_pattern" --passWithNoTests 2>&1 | tee "${LOG_DIR}/test-result-${test_pattern}.log"; then
    echo -e "${GREEN}✓ ${suite_name} completed${NC}"
    PASSED_TESTS=$((PASSED_TESTS + 1))
  else
    echo -e "${RED}✗ ${suite_name} failed${NC}"
    FAILED_TESTS=$((FAILED_TESTS + 1))
  fi
  
  echo ""
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
}

# Run individual test suites
echo -e "${YELLOW}1. Unit Tests${NC}"
run_test_suite "Unit Tests" "unit.*spec"

echo -e "${YELLOW}2. Integration Tests${NC}"
run_test_suite "Integration Tests" "integration.*spec"

echo -e "${YELLOW}3. E2E Tests${NC}"
run_test_suite "E2E Tests" "e2e.*spec"

echo -e "${YELLOW}4. Concurrency Tests${NC}"
run_test_suite "Concurrency Tests" "concurrency.*spec"

# Run all tests with coverage
echo -e "${BLUE}Generating Coverage Report...${NC}"
echo ""

if npm test -- --coverage --passWithNoTests 2>&1 | tee "${LOG_DIR}/test-coverage.log"; then
  echo -e "${GREEN}✓ Coverage report generated${NC}"
else
  echo -e "${RED}✗ Coverage report generation failed${NC}"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "                            TEST SUMMARY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Total Test Suites:     ${TOTAL_TESTS}"
echo -e "Passed Test Suites:    ${GREEN}${PASSED_TESTS}${NC}"
echo -e "Failed Test Suites:    ${RED}${FAILED_TESTS}${NC}"
echo ""

# Display coverage summary if available
if [ -f "coverage/lcov-report/index.html" ]; then
  echo -e "${GREEN}Coverage Report: coverage/lcov-report/index.html${NC}"
  echo ""
fi

# Final status
if [ $FAILED_TESTS -eq 0 ]; then
  echo -e "${GREEN}✓ All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}✗ ${FAILED_TESTS} test suite(s) failed${NC}"
  exit 1
fi
