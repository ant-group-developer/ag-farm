# Hợp đồng ag-farm

Nguồn chuẩn là code trong `packages/protocol/src` (schema zod). Tài liệu này tóm tắt luồng và lý do; khi hai bên lệch nhau, code thắng.

## Ba bên và cách xác thực

| Bên gọi | Gọi tới | Header |
|---|---|---|
| Worker (`ag-scan-worker`, `ag-render-worker`) | ag-farm | `Authorization: Node <token>` |
| Chủ job (ag-go-api, ag-studio) | ag-farm | `Authorization: Owner <key>` |
| Worker | `sign_url` của chủ job | `Authorization: Ticket <vé>` |

- Token node và khoá owner chỉ hiện một lần lúc tạo; ag-farm lưu sha256.
- **Vé** là JWT ký bằng Ed25519 (`alg: EdDSA`, `typ: farm-ticket+jwt`). Claims: `sub` (node), `job_id`, `owner`, `type`, `attempt`, `iat`, `exp` (= hết lease + 60 s). Chủ job kiểm vé bằng khoá công khai của ag-farm (`verifyTicket`), không cần gọi ag-farm.
- ag-farm **không gọi vào chủ job**. Chủ job tự gửi job và tự poll kết quả, nên chủ job nằm sau NAT vẫn chạy được, miễn worker gọi tới `sign_url` được.
- ag-farm và worker **không giữ khoá R2**. Mỗi chủ job ký URL cho bucket của chính mình.

## Vòng đời job

```
queued ──claim──► leased ──complete──► completed
  ▲                 │ ├──fail (retryable, còn lượt)──► queued (not_before lùi dần)
  │                 │ └──fail / hết lượt──────────────► failed
  └──reaper (lease hết hạn, còn lượt)──┘
queued/leased ──cancel (chủ job)──► cancelled   (worker nhận 409 job_cancelled ở lần progress kế tiếp)
```

- Claim chọn job theo thứ tự: `lane = interactive` trước, rồi `priority` cao hơn, rồi job có `affinity_key` worker đang cache, rồi job cũ nhất. Job chỉ được giao khi máy đáp ứng `requirements` (`meetsRequirements`) và còn slot đúng loại (`JOB_TYPE_SPECS[type].slot`).
- Lease dài `LEASE_SECONDS` (120 s). Worker gửi progress mỗi 30 s để gia hạn và nhận vé mới.
- Lease cũ (bị reaper lấy lại) nộp progress/complete/fail thì nhận 409 `lease_lost`; worker phải dừng job ngay.
- `correlation_id` là duy nhất theo chủ job: gửi lại trả về job cũ (`created: false`), nên chủ job gửi lại thoải mái sau lỗi mạng.
- Chủ job lấy kết quả bằng `GET /v1/owner/jobs?status=completed,failed&unacked=1`, xử lý idempotent, rồi `ack`.

## Ký URL (`sign_url` của chủ job)

Worker gửi danh sách thao tác, chủ job trả kết quả theo đúng thứ tự. Một thao tác không được phép thì cả request trả 403.

| Thao tác | Dùng cho |
|---|---|
| `get {input}` | Tải input. `input` là tên logic: `source`, `artifact:<đường dẫn>`, `segment:<id>`, `library:<đường dẫn>`. Kết quả có `cache_key` và `source` (gốc/proxy/preview, có watermark không) |
| `put {output, content_type}` | Ghi file nhỏ (< 64 MiB) |
| `mp_create`, `mp_part_urls`, `mp_complete`, `mp_abort` | Multipart cho file lớn; chủ job khởi tạo và hoàn tất vì chỉ chủ job giữ khoá. Phần 16 MiB |

`output` là đường dẫn tương đối dưới thư mục output của job. Chủ job tự ghép với prefix thật, chặn `..`, và chỉ ký thứ thuộc job trong vé. Worker không biết cấu trúc bucket.

## Loại job

| Loại | Chủ | Lane | Slot | Payload / manifest |
|---|---|---|---|---|
| `scan.extract` | `ag-go` | batch | cpu | `ScanExtractPayload` → `extract.json` (`ExtractManifest`) |
| `scan.ai` | `ag-go` | batch | gpu | `ScanAiPayload` (≤ 30 đoạn) → `ai-<chunk>.json` (`AiManifest`) |
| `studio.tts` | `studio` | interactive | gpu | chốt ở GĐ3 |
| `studio.render_preview` | `studio` | interactive | cpu | chốt ở GĐ3 |
| `studio.render_final` | `studio` | interactive | cpu | chốt ở GĐ3 |

Kết quả job (`JobResult`) chỉ gồm đường dẫn manifest và vài con số; dữ liệu đầy đủ nằm trong manifest ở bucket của chủ job.
