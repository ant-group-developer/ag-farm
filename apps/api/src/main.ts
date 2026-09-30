import 'reflect-metadata';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  const origin = config.get<string>('FRONTEND_ORIGIN') ?? '*';
  app.enableCors({ origin, credentials: true });

  // Bộ cài máy worker: `/dist/install.ps1` (trong repo) và các gói zip + latest.json (thư mục phát hành).
  // PowerShell 5.1 chỉ đọc `.Content` thành chuỗi khi Content-Type là text, nên `iwr ... | iex` cần text/plain.
  const staticOptions = {
    prefix: '/dist/',
    setHeaders: (res: { setHeader: (name: string, value: string) => void }, path: string) => {
      if (/\.(ps1|json|txt|cmd)$/i.test(path)) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
    },
  };
  app.useStaticAssets(
    config.get<string>('FARM_INSTALLER_DIR') ?? resolve(__dirname, '..', '..', '..', 'tools', 'worker-installer'),
    staticOptions,
  );
  app.useStaticAssets(config.get<string>('FARM_RELEASES_DIR') ?? resolve(__dirname, '..', '..', '..', 'releases'), staticOptions);

  const port = config.get<number>('PORT') ?? 3010;
  await app.listen(port);
  console.log(`ag-farm hub listening on port ${port}`);
}

void bootstrap();
