import { describe, expect, it } from 'vitest';
import { installCommand } from '../modules/nodes/EnrollModal';

describe('installCommand', () => {
  it('builds the one-line PowerShell install command for install.ps1', () => {
    expect(installCommand('http://192.168.1.2:3010', 'agf_abc')).toBe(
      'iwr http://192.168.1.2:3010/dist/install.ps1 -UseBasicParsing | iex; Install-AgWorker -Hub http://192.168.1.2:3010 -Code agf_abc',
    );
  });

  it('drops trailing slashes from the hub address', () => {
    expect(installCommand('https://farm-api.example.com//', 'agf_x')).toContain('-Hub https://farm-api.example.com -Code');
  });
});
