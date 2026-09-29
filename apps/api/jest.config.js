/** Jest config cho unit tests (*.spec.ts) */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '\\.spec\\.ts$',
  // Transform ESM packages trong node_modules
  transformIgnorePatterns: [
    '/node_modules/(?!(@nestjs/typeorm|typeorm|@ag-farm)/)',
  ],
  collectCoverageFrom: ['**/*.ts', '!**/*.spec.ts', '!**/*.db-spec.ts', '!**/index.ts'],
};
