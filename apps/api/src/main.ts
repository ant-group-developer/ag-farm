import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  const origin = config.get<string>('FRONTEND_ORIGIN') ?? '*';
  app.enableCors({ origin, credentials: true });

  const port = config.get<number>('PORT') ?? 3010;
  await app.listen(port);
  console.log(`ag-farm hub listening on port ${port}`);
}

void bootstrap();
