/**
 * SignClient: gọi sign_url của chủ job để lấy URL ký.
 * Authorization: Ticket <vé>; luôn dùng vé mới nhất (do progress trả về).
 */
import {
  AUTH_SCHEMES,
  SignRequestSchema,
  SignResponseSchema,
  unwrapApiResponse,
} from '@ag-farm/protocol';
import type { SignOp, SignRequest, SignResponse, SignResult } from '@ag-farm/protocol';

export class SignError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SignError';
  }
}

export class SignClient {
  constructor(
    /** URL ký của chủ job. */
    private readonly signUrl: string,
    /**
     * Hàm trả về vé hiện tại; được gọi mỗi lần ký.
     * Luôn trả về vé mới nhất từ progress.
     */
    private readonly getTicket: () => string,
  ) {}

  /** Gửi danh sách thao tác ký và trả về kết quả theo đúng thứ tự. */
  async sign(ops: SignOp[]): Promise<SignResult[]> {
    const req: SignRequest = SignRequestSchema.parse({ ops });
    const res = await fetch(this.signUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `${AUTH_SCHEMES.ticket} ${this.getTicket()}`,
      },
      body: JSON.stringify(req),
    });

    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => '');
      throw new SignError(res.status, `Sign request rejected: HTTP ${res.status} - ${text}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new SignError(res.status, `Sign request failed: HTTP ${res.status} - ${text}`);
    }

    const rawBody = await res.json();
    const data: SignResponse = SignResponseSchema.parse(unwrapApiResponse(rawBody));
    return data.results;
  }

  /** Tiện ích: lấy URL GET cho một input theo tên. */
  async getInput(inputName: string): Promise<{
    url: string;
    expiresAt: Date;
    sizeBytes: number | null;
    cacheKey: string | null;
  }> {
    const results = await this.sign([{ op: 'get', input: inputName }]);
    const result = results[0];
    if (!result || result.op !== 'get') {
      throw new Error(`Unexpected sign result for get ${inputName}`);
    }
    return {
      url: result.url,
      expiresAt: new Date(result.expires_at),
      sizeBytes: result.size_bytes,
      cacheKey: result.cache_key,
    };
  }

  /** Tiện ích: lấy URL PUT cho một output. */
  async putOutput(
    outputPath: string,
    contentType: string,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const results = await this.sign([{ op: 'put', output: outputPath, content_type: contentType }]);
    const result = results[0];
    if (!result || result.op !== 'put') {
      throw new Error(`Unexpected sign result for put ${outputPath}`);
    }
    return { url: result.url, headers: result.headers };
  }
}
