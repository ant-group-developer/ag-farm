# ag-farm

Hệ thống điều phối job tính toán nặng (quét video, TTS, render) giữa các **owner** (ag-go, studio) và **worker** (các máy chạy scan/render worker).

---

## Cấu trúc monorepo

```
ag-farm/
├── apps/
│   └── api/            # Hub service (NestJS 11 + TypeORM + Postgres)
├── packages/
│   ├── protocol/       # Zod 4 schemas + ticket Ed25519 (ĐỌC THÊM: packages/protocol/src/)
│   ├── owner-client/   # TypeScript client cho owner (ag-go, studio)
│   └── worker-sdk/     # SDK cho worker (không sửa)
└── docker-compose.test.yml
```

---

## apps/api — Hub service

### Biến môi trường

Sao chép `apps/api/.env.example` → `apps/api/.env` rồi điền:

| Biến | Mô tả |
|------|-------|
| `DATABASE_URL` | Postgres connection string |
| `AUTH0_ISSUER_URL` | Auth0 tenant URL (kết thúc `/`) |
| `AUTH0_AUDIENCE` | API audience trong Auth0 |
| `AUTH0_JWKS_URL` | URL lấy JWKS public keys |
| `AUTH0_ALLOWED_CLIENT_IDS` | Danh sách client_id cho phép (phân cách bởi `,`) |
| `ACCOUNT_API_URL` | URL gốc của ag-go-api (để xác thực admin) |
| `FARM_TICKET_PRIVATE_KEY` | Ed25519 PKCS8 PEM (dấu xuống dòng thay bằng `\n`) |
| `FARM_TICKET_PUBLIC_KEY` | Ed25519 SPKI PEM (dấu xuống dòng thay bằng `\n`) |
| `REAPER_INTERVAL_MS` | Chu kỳ reaper thu hồi lease hết hạn (mặc định `15000`) |
| `NODE_OFFLINE_AFTER_SECONDS` | Thời gian không heartbeat coi node offline (mặc định `90`) |

### Sinh cặp khoá ticket

```bash
yarn workspace @ag-farm/api keys:generate
```

Lệnh in ra cả PEM thường lẫn PEM dạng `\n`-escaped để dán vào `.env`.

### Tạo migration & chạy

```bash
# Chạy migration lên (cần DATABASE_URL trong môi trường)
yarn workspace @ag-farm/api migration:run

# Revert migration gần nhất
yarn workspace @ag-farm/api migration:revert
```

### Tạo owner key

```bash
# Cần DATABASE_URL trong môi trường
OWNER_ID=ag-go OWNER_SIGN_URL=https://ag-go.example.com/v1/sign \
  yarn workspace @ag-farm/api owner:key
```

In ra token một lần duy nhất — lưu ngay, sau đó chỉ lưu hash trong DB.

### Chạy dev

```bash
yarn workspace @ag-farm/api start:dev
```

### Build

```bash
yarn workspace @ag-farm/api build
# Output: apps/api/dist/
```

---

## Xác thực (Auth schemes)

| Scheme | Dùng cho | Cơ chế |
|--------|----------|--------|
| `Node <token>` | Worker → Hub | SHA-256 token hash → tra `farm_nodes.token_hash` |
| `Owner <key>` | Owner → Hub | SHA-256 key hash → tra `farm_owners.key_hash` |
| `Bearer <jwt>` | Admin → Hub | Auth0 RS256 JWT, kiểm `azp` trong allowed list; gọi Account API để xác nhận ADMIN |
| `Ticket <jwt>` | Worker → Owner (sign URL) | Ed25519 JWT, verify bằng `FARM_TICKET_PUBLIC_KEY` |

---

## packages/owner-client

Client TypeScript cho owner (ag-go, studio) giao tiếp với hub.

### Cài đặt

```bash
# Từ ag-farm root
yarn workspace @ag-farm/owner-client build
```

Sau đó import:

```typescript
import { FarmOwnerClient, resolveOutputKey } from '@ag-farm/owner-client';

const client = new FarmOwnerClient({
  baseUrl: 'https://farm.internal',
  ownerKey: process.env.FARM_OWNER_KEY!,
});

// Gửi job
const { job, created } = await client.submitJob({
  type: 'scan.extract',
  correlation_id: `asset-${assetId}`,
  payload: { asset: { id: assetId, ... }, extract_version: 'x1' },
  max_attempts: 3,
});

// Poll kết quả
const result = await client.getJob(job.id);

// Xác nhận đã nhận
await client.ackJob(job.id);
```

---

## apps/web — Web quản lý (Admin UI)

Giao diện React dành riêng cho ADMIN: quản lý máy worker, hàng việc, thống kê và chủ job.  
Stack: React 19 + Vite + TypeScript + Ant Design Pro + TanStack Query + axios + Auth0.

### Biến môi trường

Sao chép `apps/web/.env.example` → `apps/web/.env.local` rồi điền:

| Biến | Mô tả |
|------|-------|
| `VITE_AUTH0_DOMAIN` | Auth0 tenant (vd: `abc.auth0.com`) |
| `VITE_AUTH0_CLIENT_ID` | Client ID của SPA trên Auth0 |
| `VITE_AUTH0_AUDIENCE` | Audience khớp với ag-farm API |
| `VITE_API_URL` | URL gốc của ag-farm API (không có dấu `/` cuối) |

### Chạy dev

```bash
yarn workspace @ag-farm/web dev
# Mở trình duyệt: http://localhost:5174
```

### Build production

```bash
yarn workspace @ag-farm/web build
# Output: apps/web/dist/
```

### Test

```bash
yarn workspace @ag-farm/web test
```

### Trang có trong web

| Đường dẫn | Tên | Mô tả |
|-----------|-----|-------|
| `/stats` | Thống kê | Số lượng job theo trạng thái × loại, số máy online |
| `/nodes` | Máy | Danh sách máy worker, tạo/sửa/xóa, bật/tắt; poll 10 s |
| `/jobs` | Việc | Hàng việc với bộ lọc, cursor pagination, drawer chi tiết; poll 5 s khi có job đang chạy |
| `/owners` | Chủ job | Danh sách chủ job, tạo (key hiện một lần), sửa |

Yêu cầu đăng nhập bằng Auth0; server kiểm `user_type === 'ADMIN'` trên mọi route `/v1/admin/*`.

---

## Chạy test

### DB integration tests

Cần Docker:

```bash
# Khởi container Postgres test (port 55433)
docker compose -f docker-compose.test.yml up -d

# Chạy test
yarn workspace @ag-farm/api test:db

# Dừng container sau khi test xong
docker compose -f docker-compose.test.yml down
```

### Unit tests

```bash
yarn workspace @ag-farm/api test
yarn workspace @ag-farm/owner-client test
```

### Typecheck

```bash
yarn workspace @ag-farm/api typecheck
```

---

## Vòng đời job

```
queued → leased → completed
              ↘ failed (sau max_attempts)
              ↘ queued (retry với backoff: min(30s × 2^attempt, 15 phút))
queued → cancelled (owner hủy)
leased → cancelled (owner hủy trong khi worker đang chạy → worker nhận lỗi job_cancelled)
```

Lease timeout: **120 giây**. Reaper chạy định kỳ thu hồi lease hết hạn.  
Ticket grace: **60 giây** sau khi lease hết hạn để worker hoàn tất call cuối.
