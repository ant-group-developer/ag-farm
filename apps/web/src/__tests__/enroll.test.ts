import { describe, expect, it } from 'vitest';
import { installCommand, isValidInstallDir, moveCommand } from '../modules/nodes/EnrollModal';

describe('installCommand', () => {
  it('builds the one-line PowerShell install command for install.ps1', () => {
    expect(installCommand('http://192.168.1.2:3010', 'agf_abc')).toBe(
      'iwr http://192.168.1.2:3010/dist/install.ps1 -UseBasicParsing | iex; Install-AgWorker -Hub http://192.168.1.2:3010 -Code agf_abc',
    );
  });

  it('drops trailing slashes from the hub address', () => {
    expect(installCommand('https://farm-api.example.com//', 'agf_x')).toContain('-Hub https://farm-api.example.com -Code');
  });

  it('adds -InstallDir only for a folder other than C:\\ag-farm', () => {
    expect(installCommand('http://h', 'agf_x', 'C:\\AG-farm\\')).toMatch(/-Code agf_x$/);
    expect(installCommand('http://h', 'agf_x', '')).toMatch(/-Code agf_x$/);
    expect(installCommand('http://h', 'agf_x', 'D:\\Farm Work\\ag\\')).toMatch(/-Code agf_x -InstallDir 'D:\\Farm Work\\ag'$/);
  });
});

describe('isValidInstallDir', () => {
  it('takes a full path with a drive and a folder', () => {
    expect(isValidInstallDir('D:\\ag-farm')).toBe(true);
    expect(isValidInstallDir('E:\\Farm Work\\ag\\')).toBe(true);
  });

  it('refuses a bare drive, a relative path, a share or quotes', () => {
    for (const bad of ['D:\\', 'ag-farm', '\\\\server\\share', 'D:ag', "D:\\it's", '']) expect(isValidInstallDir(bad)).toBe(false);
  });
});

describe('moveCommand', () => {
  it('builds the Move-AgWorker command', () => {
    expect(moveCommand('http://h/', 'D:\\ag-farm\\')).toBe(
      "iwr http://h/dist/install.ps1 -UseBasicParsing | iex; Move-AgWorker -To 'D:\\ag-farm'",
    );
  });
});
