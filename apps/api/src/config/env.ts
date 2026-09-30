import { z } from 'zod';

const url = z.url();
const httpsUrl = z.string().url().startsWith('https://');

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3010),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),

  // Auth0 (cho AdminGuard)
  AUTH0_ISSUER_URL: z.string().min(1),
  AUTH0_AUDIENCE: z.string().min(1),
  AUTH0_JWKS_URL: z.string().min(1),
  /** Danh sách azp được phép, phân tách bằng dấu phẩy */
  AUTH0_ALLOWED_CLIENT_IDS: z.string().min(1),

  // Account API (lấy user_type để kiểm ADMIN)
  ACCOUNT_API_URL: z.string().min(1),

  // Ticket key (Ed25519)
  FARM_TICKET_PRIVATE_KEY: z.string().min(1),
  FARM_TICKET_PUBLIC_KEY: z.string().min(1),

  // Reaper
  REAPER_INTERVAL_MS: z.coerce.number().int().min(1000).default(15000),

  // Node online threshold
  NODE_OFFLINE_AFTER_SECONDS: z.coerce.number().int().min(10).default(90),

  FRONTEND_ORIGIN: z.string().default('*'),

  /** Địa chỉ hub mà máy worker gọi tới, hiện trong lệnh cài máy (vd. https://farm-api-dev.ant-group.net). */
  FARM_PUBLIC_URL: z.string().url().optional(),
  /** Thư mục gói phát hành worker (zip + latest.json), phục vụ ở `/dist/`. */
  FARM_RELEASES_DIR: z.string().optional(),
  /** Thư mục chứa install.ps1/uninstall.ps1, phục vụ ở `/dist/`. */
  FARM_INSTALLER_DIR: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

/** Đọc và validate biến môi trường một lần khi khởi động. Ném lỗi nếu thiếu. */
export function validateEnv(raw: NodeJS.ProcessEnv): Env {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Env validation failed: ${msg}`);
  }
  return result.data;
}

/** Lấy private key từ env: xử lý literal `\n` thành newline thật */
export function parseKeyPem(value: string): string {
  return value.replace(/\\n/g, '\n');
}
