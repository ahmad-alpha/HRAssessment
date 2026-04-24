/**
 * Enhanced Jest Configuration for Comprehensive Test Coverage
 */
module.exports = {
  displayName: 'TimeOff Service Tests',
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
    '^tests/(.*)$': '<rootDir>/src/tests/$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.dto.ts',
    '!src/**/*.entity.ts',
    '!src/main.ts',
    '!src/**/*.module.ts',
  ],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 75,
      lines: 75,
      statements: 75,
    },
  },
  coverageReporters: ['text', 'text-summary', 'html', 'json', 'lcov'],
  maxWorkers: '50%',
  testTimeout: 30000,
  verbose: true,
  bail: false,
  setupFilesAfterEnv: ['<rootDir>/src/tests/setup.ts'],
};
