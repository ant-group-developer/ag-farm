// Kiểm config.yaml/machine.yaml do install.ps1 sinh ra bằng chính loader của worker-sdk:
//   node tools/worker-installer/test/check-config.mjs <thư mục có config.yaml và machine.yaml>
// (build worker-sdk trước: yarn workspace @ag-farm/worker-sdk build)
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sdk = require('../../../packages/worker-sdk/dist/index.js');
const dir = process.argv[2];
if (!dir) throw new Error('Thieu thu muc');

const cfg = sdk.loadConfig(join(dir, 'config.yaml'));
const machine = sdk.loadMachineConfig(join(dir, 'machine.yaml'));
const expect = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL ${msg}`);
    process.exit(1);
  }
  console.log(`ok   ${msg}`);
};
expect(cfg.work_dir === 'C:\\ag-farm\\scan\\work', 'work_dir keeps Windows backslashes');
expect(cfg.token === "tok'en-000000000000000000000", 'token with a quote survives YAML');
expect(cfg.kinds.join(',') === 'scan.extract,scan.ai', 'kinds list');
expect(cfg.cache.max_gb === 50, 'cache.max_gb is a number');
expect(cfg.extra.unload_ollama_before_tts === true, 'boolean extra stays boolean');
expect(machine.cpu_slots === 4 && machine.gpu_slots === 1, 'machine slots');
expect(machine.reserve_interactive.cpu === 1 && machine.reserve_interactive.gpu === 0, 'reserve_interactive');
console.log('config do install.ps1 sinh ra hop le voi worker-sdk');
