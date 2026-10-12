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
   - `FARM_RELEASE_KEY`: khoá phát hành worker (`openssl rand -hex 32`), dùng khi đẩy gói từ máy build (mục 5). Mỗi môi trường một khoá; chỉ giữ trên VPS và máy build, không commit.
6. **Auth0:** thêm domain web farm vào Allowed Callback URLs, Allowed Logout URLs và Allowed Web Origins của app web farm.
7. **Gói cài worker:** thư mục `releases/` (`FARM_RELEASES_DIR_HOST`) không nằm trong git; api ghi vào đó khi phát hành, nên cho user `node` của container (uid 1000) quyền ghi:
   ```bash
   sudo mkdir -p /www/wwwroot/<dev|prod>/ag-farm/releases && sudo chown -R 1000:1000 /www/wwwroot/<dev|prod>/ag-farm/releases
   ```
   Lần đầu (hub chưa có gói nào) và mỗi lần có bản mới: phát hành từ máy build như mục 5.
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
   # Phát hành gói worker (zip ~100 MB): lớn hơn và lâu hơn các API khác
   location = /v1/admin/releases {
     proxy_pass http://127.0.0.1:3010;
     proxy_set_header Host $host;
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     proxy_set_header X-Forwarded-Proto $scheme;
     client_max_body_size 1024m;
     proxy_request_buffering off;
     proxy_read_timeout 600s;
     proxy_send_timeout 600s;
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

## 5. Phát hành worker (máy tự cập nhật)

Trên máy build Windows (đã clone ag-farm, ag-studio cạnh repo worker), khoá phát hành của đúng hub trong biến môi trường
(chỉ đặt cho phiên PowerShell này, không ghi vào file trong repo):

```powershell
$env:FARM_RELEASE_KEY = '<FARM_RELEASE_KEY của hub>'
cd E:\CODE\ag-render-worker   # hoặc ag-scan-worker
node scripts/release.mjs --publish --upload https://api-farm(-dev).ant-group.net
```

Script đóng gói, rồi đẩy zip lên `POST /v1/admin/releases` (header `Authorization: Release <khoá>`; khoá không bao giờ in
ra). Hub kiểm sha256, **từ chối bản không mới hơn** bản đang có (409 `version_not_newer`: tăng `version` trong
`package.json` rồi chạy lại), lưu `<gói>-<bản>.zip` và ghi `latest.json` (file tạm rồi đổi tên). Dùng biến khác cho hub
khác: `--key-env FARM_DEV_RELEASE_KEY`. Không có khoá thì admin đăng nhập vẫn gọi được API này (Bearer Auth0).
`--publish <thư mục>` (chép vào một thư mục latest.json) vẫn dùng được khi cần.

Sau khi phát hành, máy cài bằng `install.ps1` (render 0.9.0 / scan 0.4.0 trở lên) tự cập nhật trong khoảng 15 phút:
ngừng nhận việc, chờ việc đang chạy xong (tối đa 30 phút), task `ag-farm-updater` cài bản mới, bản mới không chạy thì
quay về bản cũ. Trang **Máy** của web farm: cột Phiên bản (tag "cũ", trạng thái cập nhật, lỗi kèm dòng cuối
`setup.log`), công tắc "Tự cập nhật", nút "Cập nhật ngay". Máy còn chạy render 0.8.1 / scan 0.3.5 trở về trước: chạy
lệnh cập nhật (lệnh cài, bỏ `-Code`) trên máy **một lần cuối**; từ đó máy tự cập nhật.

Thứ tự lên bản có đổi giao thức: hub (deploy.sh, có migration) → phát hành worker → Studio.
