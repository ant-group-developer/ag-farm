/** Jest config cho DB integration tests (*.db-spec.ts).
 * Dùng --experimental-vm-modules để tương thích với @nestjs/typeorm v12 (pure ESM).
 */
module.exports = {
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '\\.db-spec\\.ts$',
  testTimeout: 60000,
  maxWorkers: 1,
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
        },
      },
    ],
  },
  transformIgnorePatterns: [],
  moduleNameMapper: {
    // Hỗ trợ import kiểu ESM với .js extension trong TS
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
