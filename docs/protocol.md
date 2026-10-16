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
- Thứ tự máy (`farm_nodes.priority_order`, số nhỏ trước; admin kéo thả ở trang Worker, hay `POST /v1/admin/nodes/reorder {ids}`): máy B xin việc thì bỏ qua một job nếu còn máy A xếp trước B đang bật, online (heartbeat trong `NODE_OFFLINE_AFTER_SECONDS`), trong lịch (không `paused`), nhận loại job đó (`kinds` báo − `blocked_kinds`), đủ `requirements` và còn slot đúng loại. Slot trống của A là `free_slots` ở heartbeat gần nhất trừ các job (còn `leased`) đã giao cho A sau heartbeat đó; mỗi job B nhường giữ một slot của A trong lần claim ấy, nên B chỉ nhường số job A nhận nổi. Job chờ quá `NODE_PRIORITY_GRACE_SECONDS` (mặc định 10 s, tính từ mốc muộn nhất trong `created_at`, `updated_at` — lần vào lại hàng — và `not_before`) thì máy nào cũng nhận, để A chậm hay kẹt không giữ việc lại. Job ghim máy (`requirements.node_id`) không nhường. Thứ tự này chỉ là của hub: không đổi gì ở API worker; `GET /v1/owner/nodes` trả máy theo thứ tự này.
- Chủ job nâng một job đang chờ bằng `POST /v1/owner/jobs/:id/raise {lane?, priority}` (`priority` −100..100, thiếu
  `lane` thì giữ lane cũ): chỉ job `queued` của chính nó, job ở trạng thái khác nhận 409 `job_not_queued`; trả `JobView`.
  Ví dụ ag-go nâng job `scan.prep` đang chờ trong lô chạy bù lên `interactive` khi Studio cần footage đó ngay.
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
| `scan.prep` | `ag-go` | batch | cpu | `ScanPrepPayload` → `prep.json` (`ScanPrepManifest`) + `frames/NNN.jpg`, `sheets/NN.jpg`, `audio.wav` |
| `studio.tts` | `studio` | interactive | gpu | `StudioTtsPayload` → `tts.json` (`TtsManifest`) + `tts/<line_id>.wav` |
| `studio.render_preview` | `studio` | interactive | cpu | `StudioRenderPayload` → `render.json` (`RenderManifest`) + video |
| `studio.render_final` | `studio` | interactive | cpu | `StudioRenderPayload` → `render.json` (`RenderManifest`) + video, thumbnail |
| `studio.export_premiere` | `studio` | interactive | cpu | `StudioExportPremierePayload` → `premiere.json` (`PremiereManifest`) + zip |
| `studio.transcribe` | `studio` | interactive | gpu | `StudioTranscribePayload` (WAV 16 kHz mono mỗi nguồn, `stage:`) → `transcribe.json` (`TranscribeManifest`) |
| `studio.reference_fetch` | `studio` | interactive | cpu | `StudioReferenceFetchPayload` → video ở `output`, không manifest; `result.summary` là `StudioReferenceFetchResult` |
| `studio.beats` | `studio` | interactive | cpu | `StudioBeatsPayload` (file nhạc, `library:`) → `beats.json` (`BeatsManifest`) |

`studio.tts` và `studio.transcribe` cần máy khai `gpu` và `python` (worker dò `import torch` bằng `python_bin` của nó);
`studio.beats` chỉ cần `python` (librosa), không cần GPU.

### `studio.beats`: nhịp của nhạc nền

Studio gửi khi một nhạc nền được nhập, để cắt cảnh đúng phách hoặc đầu ô nhịp (`shots[].snap` của kế hoạch dựng).

- Payload: `production_id`, `tracks` (1–20: `track_id`, `audio` là tên input của file nhạc, `parts` là giây bắt đầu của từng
  bài sau bài đầu khi track ghép từ nhiều bài; mỗi bài phân tích riêng vì nhịp khác nhau), `beats_per_bar` (2–12, mặc định 4).
- Worker chạy `engines/python/beats.py` (librosa `beat_track`; đầu ô nhịp là pha của mỗi `beats_per_bar` phách có năng
  lượng dải trầm và độ mạnh nốt cao nhất).
- Manifest `beats.json`: mỗi track `duration_s`, `bpm` (`null` khi không nghe ra phách), `beats_per_bar`, `beats` và
  `downbeats` (giây, tăng dần, ≤ 60 000), `sections` (`start`, `end`, `bpm` từng bài).

### `scan.prep`: đầu vào cho Studio chuẩn bị sẵn ở ag-go

Mỗi footage chuẩn bị một lần ở ag-go, Studio chỉ tải kết quả về (không tải video, không cắt cảnh nữa).

- Payload: `asset_id`, `source` (tên input; ag-go ký GET của bản sạch nhỏ nhất), `params` (`scene_threshold` 0,3,
  `min_shot_s` 1, `max_shot_s` 20, `frame_width` 480, `sheet_cols` 4, `sheet_shots` 16, `audio` true).
- Cảnh theo đúng luật của Studio: `select='gt(scene\,T)',showinfo` trên cả video (không giới hạn thời gian dò, timeout
  theo thời lượng), mốc cắt làm tròn lưới 0,1 s, rồi `buildShots` (gộp cảnh < `min_shot_s` vào cảnh trước, cảnh đầu
  gộp vào cảnh sau; chia đều cảnh > `max_shot_s`; `in`/`out` làm tròn 3 chữ số).
- Đầu ra: `frames/NNN.jpg` (pad3, từ 1; khung tại `round(((in+out)/2)*1000)/1000`, `scale=<frame_width>:-2`),
  `sheets/NN.jpg` (pad2, từ 1; `sheet_shots` cảnh mỗi tờ theo thứ tự, ffmpeg `tile=<cols>x<ceil(n/cols)>`),
  `audio.wav` (16 kHz mono pcm_s16le; chỉ khi có tiếng và `params.audio`), `prep.json` (`ScanPrepManifest`,
  schema `ag.scan.prep/v1`). ag-go gửi tiếp `studio.transcribe` với `audio: 'artifact:audio.wav'` (owner `ag-go` được
  phép cả hai loại).

### `studio.reference_fetch`: video YouTube mẫu tải qua máy farm

YouTube chặn IP máy chủ Studio ("Sign in to confirm you're not a bot"), nên Studio nhờ máy farm (cần `ytdlp`) tải video
mẫu nó cần đo kiểu dựng. Vẫn theo ADR-0001 mục 175 của Studio: không cookie, không đăng nhập, không lách chặn.

- Payload: `production_id`, `video_id` (đúng 11 ký tự `[A-Za-z0-9_-]`; worker tự dựng `https://www.youtube.com/watch?v=<id>`,
  không bao giờ nhận URL), `max_height` (≤ 480, mặc định 480), `max_seconds` (≤ 1800, mặc định 1800), `max_bytes`
  (≤ 300 MiB, mặc định 300 MiB), `output` (đường dẫn tương đối, ví dụ `reference/<video_id>.mp4`; Studio ghép với prefix output của job,
  `productions/<project>/jobs/<stage>/<attempt>/out/`).
- Worker chạy yt-dlp với đúng cờ của Studio (`--ignore-config --no-cookies --no-warnings --no-progress --js-runtimes
  node:<node của worker> --no-playlist --no-part --restrict-filenames -f "bv*[height<=480]+ba/b[height<=480]/bv*[height<=480]"
  --merge-output-format mp4 --max-filesize 300M --match-filter "duration<=1800 & !is_live" --ffmpeg-location <ffmpeg kèm gói>`,
  số theo payload), đo bằng ffprobe, đẩy file lên `output`, rồi xoá mọi file trên máy.
- Kết quả: `{ manifest: null, summary: { output, ext, duration_s, size_bytes, width, height, title, channel } }`.
  Chủ job đọc xong thì tự xoá object (hub không xoá file của chủ job).
- Lỗi do YouTube/yt-dlp: `error.code` thuộc `REFERENCE_FETCH_ERROR_CODES` (`youtube_blocked`, `private`, `unavailable`,
  `age_restricted`, `members_only`, `live`, `too_long`, `too_big`, `no_480p`, `network`, `timeout`, `other`; cùng mã
  `classifyYtDlp` của Studio), `error.message` là đầu dòng ERROR của yt-dlp. Chỉ `network` và `timeout` có
  `retryable: true`. Lỗi khác giữ mã chung (`INVALID_PAYLOAD`, `WORKER_ERROR`…).

Loại job worker báo (`kinds` ở heartbeat và claim): `kinds` trong config.yaml của worker là tuỳ chọn. Không khai thì
worker-sdk (`workerKinds`) báo mọi loại có handler mà máy đáp ứng `JOB_TYPE_SPECS[type].baseRequirements` (GPU, Python
có torch, NVENC, yt-dlp), dò một lần lúc khởi động; khai thì là danh sách ép (giao với handler). Năng lực máy có thêm
`engines.ytdlp` (tuỳ chọn, phiên bản `yt-dlp --version`; requirement `ytdlp: true`). Hub build trước khi có trường này
từ chối heartbeat có nó (`strictObject`), nên **lên hub trước, rồi mới lên worker**. Worker chỉ gửi trường này khi dò
thấy yt-dlp, và dò ffmpeg bằng chính binary nó chạy (`ffmpeg-static` trong gói), không phải `ffmpeg` trên PATH.

Hub giao cho máy các loại nó báo trừ các loại admin chặn ở máy đó (`farm_nodes.blocked_kinds`, rỗng = không chặn;
`PATCH /v1/admin/nodes/:id {blocked_kinds}`, trang Máy có công tắc từng loại). Loại mới worker báo lên tự được giao.
`allowed_kinds` (danh sách cho phép) đã bỏ: migration `1900000000000` chuyển thành chặn = loại đã báo − loại được phép,
và PATCH có `allowed_kinds` trả 400.

### Tự cập nhật worker

Máy cài bằng `install.ps1` có `updater_task`/`updater_dir` trong config.yaml và task `ag-farm-updater` (SYSTEM). Worker
(`SelfUpdater` của worker-sdk, gói khai `selfUpdate: { package }`):

1. mỗi `update_check_minutes` (mặc định 15, lệch ±20 %) đọc `/dist/latest.json` (`ReleaseManifest`) và so bản của gói
   mình (`compareVersions`); mỗi phút hỏi `GET /v1/worker/me`: `auto_update` (tuỳ chọn, mặc định bật) và
   `update_requested_at` (admin bấm "Cập nhật ngay": kiểm ngay, cập nhật cả khi `auto_update` tắt, bỏ nếu cũ hơn 1 giờ);
2. có bản mới hơn và được phép: ngừng claim, chờ job đang chạy xong (tối đa `update_drain_minutes`, mặc định 30);
3. ghi `<updater_dir>/request-<role>.json` rồi `schtasks /Run /TN ag-farm-updater`. Task dừng worker, cài như lệnh cập
   nhật (giữ `app.prev`, chạy setup, ghi config), bản mới không heartbeat đúng phiên bản trong 3 phút thì trả `app.prev`
   và `config.yaml.bak`. Kết quả ở `<updater_dir>/result-<role>.json`; worker đọc lúc khởi động. Task cũng chạy 03:00
   mỗi đêm (dự phòng: chỉ vai trò có bản mới, hub cho phép, bản đó chưa từng hỏng trên máy).

Heartbeat có `update` (tuỳ chọn; `WorkerUpdateStatus`: `state` `idle|draining|installing|failed`, `target_version`,
`message`, `since`). Worker chỉ gửi khi tự cập nhật đang bật; hub lưu ở `farm_nodes.update_status`/`update_status_at`
(heartbeat không có trường này giữ giá trị cũ). Hub build trước khi có trường này từ chối heartbeat có nó: **lên hub
trước**. Bản đã hỏng không tự thử lại (mỗi lần thử là một lần ngừng nhận việc); "Cập nhật ngay" thử lại. Máy đang chạy
render ≤ 0.8.1 / scan ≤ 0.3.5 chưa có bộ cập nhật: chạy lệnh cập nhật của `install.ps1` bằng tay một lần.

Admin (trang Máy): `GET /v1/admin/releases/latest` (latest.json của hub, mục hỏng bị bỏ) để so phiên bản, tag "cũ";
`GET /v1/admin/nodes` trả thêm `auto_update`, `update_requested_at`, `update` (trạng thái worker báo), `update_at`;
`PATCH /v1/admin/nodes/:id {auto_update}` (công tắc "Tự cập nhật"); `POST /v1/admin/nodes/:id/update-now` (đặt
`update_requested_at = now()`, nút "Cập nhật ngay"). Trang Máy cũng báo máy render thiếu gì theo capabilities: Python
(torch), CUDA, yt-dlp, NVENC.

### Tình trạng máy

Worker-sdk đo máy ở nền mỗi `METRICS_SAMPLE_SECONDS` (15 s) và gửi bản mới nhất ở heartbeat, trong `metrics`
(`MachineMetrics`, tuỳ chọn, mọi trường con tuỳ chọn): `cpu_pct` (từ chênh lệch `os.cpus()` giữa hai lần đo),
`ram_used_mb`/`ram_total_mb`, `disks` (`{path, free_mb, total_mb}` của ổ chứa `work_dir` và cache, cùng ổ một dòng;
`path` là `C:` trên Windows), `net_rx_bps`/`net_tx_bps` (byte/s, cộng các card mạng; Windows: `netstat -e`, bộ đếm 32 bit
nên một vòng quay được cộng lại; Linux: `/proc/net/dev`, bỏ `lo`, docker, bridge, veth), `gpus`
(`{index, util_pct, vram_used_mb, vram_total_mb, temp_c}` qua `nvidia-smi --query-gpu`), `uptime_s`. Số nào không đo được
thì bỏ trường đó, không gửi 0.

- Heartbeat không bao giờ chờ đo: nó đọc bản đo mới nhất, bản cũ quá 2 phút (sampler kẹt) thì không gửi.
- Mỗi lần đo chạy tối đa một lệnh hệ điều hành (timeout 5 s): `nvidia-smi` và `netstat -e` (Windows) thay phiên, nên
  mỗi số đó mới sau tối đa 30 s; máy không có `nvidia-smi` (hoặc capabilities không có GPU) thì không chạy nó. Một lần
  đo mất khoảng 30–100 ms (đa phần là lệnh con).
- Tắt: `metrics: false` trong config.yaml của worker.
- Hub build trước khi có trường này từ chối heartbeat có nó (`strictObject`): **lên hub trước**. Worker vẫn chịu được hub
  cũ: heartbeat có `metrics` bị 400 thì gửi lại ngay không có số đo và thôi gửi số đo trong một giờ, nên máy không
  thành offline.

Hub lưu bản đo ở `farm_nodes.metrics`/`metrics_at` (heartbeat không có `metrics` giữ giá trị cũ; web coi số đo cũ hơn 2
phút là cũ) và ghi lịch sử theo máy vào `farm_machine_metrics` (khoá `farm_nodes.machine`, node không có máy thì tên
node): mỗi phút một dòng, các node cùng máy ghi chung dòng đó (số mới nhất; trường lần này thiếu giữ số cũ), `disk_free_mb`
là ổ còn ít chỗ nhất, `disks`/`gpu` giữ đủ. Reaper xoá dòng cũ hơn `MACHINE_METRICS_KEEP_DAYS` (mặc định 7) mỗi 10 phút,
từng lô 5 000 dòng. Lỗi ghi lịch sử không làm hỏng heartbeat.

Admin: `GET /v1/admin/nodes` trả thêm `metrics`, `metrics_at`; `GET /v1/admin/machines/:machine/metrics?range=1h|24h|7d`
(mặc định `1h`) trả `{ machine, range, bucket_seconds, from, to, points }`, ô 1 phút / 5 phút / 1 giờ (≤ 300 điểm); mỗi
điểm `{ t, cpu_pct, ram_used_mb, ram_total_mb, disk_free_mb, disk_total_mb, net_rx_bps, net_tx_bps, gpus[] }` là trung
bình trong ô (ổ trống: thấp nhất; nhiệt độ GPU: cao nhất), ô không có số đo thì `null`.

Kết quả job (`JobResult`) chỉ gồm đường dẫn manifest và vài con số; dữ liệu đầy đủ nằm trong manifest ở bucket của chủ job.
