# Triển khai ag-farm lên VPS (dev và prod)

ag-farm = hub (api) + web quản lý. Hub chỉ giữ hàng đợi job, không cần GPU. Việc quét và render chạy trên các máy worker (PC có GPU), các máy này gọi hub qua Internet bằng HTTPS.

| | dev | prod |
|---|---|---|
| VPS | VPS dev (cùng máy ag-go dev) | VPS riêng cho farm |
| Thư mục | `/www/wwwroot/dev/ag-farm` | `/www/wwwroot/prod/ag-farm` |
| API (hub) | `https://api-farm-dev.ant-group.net` | `https://api-farm.ant-group.net` |
| Web | `https://farm-dev.ant-group.net` | `https://farm.ant-group.net` |
| Deploy | tự chạy khi push `main` (`deploy.dev.yml`) | bấm tay `deploy.prod.yml` trên `main` |
| Chủ job | ag-go dev `https://api-dev-v2.ant-go.net/api` | ag-go prod |

Mỗi môi trường có cặp khoá vé, khoá owner và tập máy worker riêng. Một máy worker chỉ nối với một hub, nên khi chuyển máy từ dev sang prod thì cài lại bằng mã của farm prod.

## 1. Chuẩn bị một lần trên VPS

1. **DNS:** tạo bản ghi A cho domain API và domain web, trỏ về IP của VPS.
2. **Phần mềm:** Docker + plugin compose, git, Postgres 16. Postgres cài trên chính VPS cũng được, container gọi qua `host.docker.internal`.
3. **Database riêng cho farm:**
   ```sql
   CREATE USER ag_farm WITH PASSWORD '<mật khẩu>';
   CREATE DATABASE ag_farm OWNER ag_farm;
   ```
   Nếu Postgres chỉ nghe ở `127.0.0.1`, thêm địa chỉ bridge của docker (thường là `172.17.0.1`) vào `listen_addresses`, và thêm dòng cho dải `172.16.0.0/12` vào `pg_hba.conf`.
4. **Mã nguồn:**
   ```bash
   sudo git clone git@github.com:ant-group-developer/ag-farm.git /www/wwwroot/<dev|prod>/ag-farm
   ```
   VPS cần deploy key (chỉ đọc) của repo ag-farm.
5. **`.env`:** sao chép `.env.example` thành `.env` rồi điền:
   - `FARM_API_PORT=127.0.0.1:3010` và `FARM_WEB_PORT=127.0.0.1:3011`: chỉ nghe ở localhost, ra ngoài qua nginx.
   - `DATABASE_URL=postgresql://ag_farm:<mật khẩu>@host.docker.internal:5432/ag_farm`
   - Auth0: cùng tenant và audience với ag-go. `AUTH0_ALLOWED_CLIENT_IDS` và `VITE_AUTH0_CLIENT_ID` là client id của app web farm.
   - `ACCOUNT_API_URL`: Account API của đúng môi trường (dev hoặc prod).
   - `FRONTEND_ORIGIN` = domain web; `FARM_PUBLIC_URL` và `VITE_API_URL` = domain API.
   - `FARM_OLLAMA_MODELS=qwen2.5vl:7b`: phải trùng `ANALYSIS_MODEL` của ag-go.
   - Khoá vé: chạy `sudo docker compose build api`, rồi `sudo docker compose run --rm --no-deps api node dist/scripts/generate-ticket-keys.js`, rồi dán hai khoá vào `.env`.
6. **Auth0:** thêm domain web farm vào Allowed Callback URLs, Allowed Logout URLs và Allowed Web Origins của app web farm.
7. **Gói cài worker:** thư mục `releases/` không nằm trong git. Chép từ máy build lên:
   ```bash
   scp releases/latest.json releases/ag-scan-worker-<bản>.zip releases/ag-render-worker-<bản>.zip <user>@<vps>:/www/wwwroot/<dev|prod>/ag-farm/releases/
   ```
   Chỉ cần đúng các bản mà `latest.json` đang trỏ tới. Khi có bản mới: chạy `node scripts/release.mjs --publish <thư mục>` trong repo worker, rồi chép lại.
8. **nginx (site trong aaPanel), có SSL Let's Encrypt:**
   ```nginx
   # api-farm(-dev).ant-group.net
   location / {
     proxy_pass http://127.0.0.1:3010;
     proxy_set_header Host $host;
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     proxy_set_header X-Forwarded-Proto $scheme;
     proxy_read_timeout 120s;
     client_max_body_size 20m;
   }
   # farm(-dev).ant-group.net
   location / { proxy_pass http://127.0.0.1:3011; proxy_set_header Host $host; }
   ```
9. **Deploy lần đầu:** `cd <thư mục> && sudo bash deploy.sh`. Lệnh này build image, chạy migration, rồi thay api và web.
10. **Kiểm tra:**
    - `curl https://<api>/health` trả về ok.
    - `curl https://<api>/dist/latest.json` và `curl https://<api>/dist/install.ps1` đều trả về nội dung.
    - Đăng nhập được web farm bằng tài khoản ADMIN.

## 2. Nối ag-go vào farm

1. Tạo khoá owner cho ag-go. Khoá chỉ in ra một lần:
   ```bash
   sudo docker compose run --rm --no-deps \
     -e OWNER_ID=ag-go \
     -e OWNER_SIGN_URL=https://<api ag-go>/api/analysis/farm/sign \
     api node dist/scripts/create-owner-key.js
   ```
2. Thêm vào `.env` của ag-go-api trên VPS của ag-go, rồi deploy lại ag-go-api:
   ```
   FARM_URL=https://<api farm>
   FARM_OWNER_KEY=<khoá vừa in>
   FARM_TICKET_PUBLIC_KEY=<FARM_TICKET_PUBLIC_KEY của farm này>
   ANALYSIS_MODEL=qwen2.5vl:7b
   ANALYSIS_EXTRACT_VERSION=x2
   ANALYSIS_PROMPT_VERSION=p2
   ANALYSIS_AUTO_ENQUEUE=false
   ```
3. Bản ag-go-api trên VPS phải có module quét v2 (migration `2060000000000-asset-analysis-v2`). Trước khi deploy bản này lên prod: **backup DB ag-go prod**. Migration xoá bảng `media_segments` của bản quét v1.

## 3. GitHub Actions (repo ag-farm → Settings → Secrets and variables → Actions)

| Môi trường | Secrets |
|---|---|
| dev | `VPS_HOST_DEV`, `VPS_USER_DEV`, `VPS_SSH_KEY_DEV`, tuỳ chọn `VPS_PORT_DEV`, `FARM_APP_PATH_DEV` |
| prod | `VPS_HOST_PROD`, `VPS_USER_PROD`, `VPS_SSH_KEY_PROD`, tuỳ chọn `VPS_PORT_PROD`, `FARM_APP_PATH_PROD` |

User SSH cần chạy `sudo` không hỏi mật khẩu cho git, bash và docker. Với prod, nên đặt Required reviewers cho environment `production`.

## 4. Thêm máy worker

Trên web farm, vào Máy → Thêm máy, chọn vai trò, rồi chạy lệnh được tạo ra trong PowerShell (Run as Administrator) trên máy worker. Bộ cài tải đúng các model trong `FARM_OLLAMA_MODELS`. Mọi máy nhận `scan.ai` phải chạy được model đó: `qwen2.5vl:7b` cần khoảng 10 GB VRAM.
