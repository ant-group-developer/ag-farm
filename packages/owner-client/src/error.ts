import { apiErrorOf } from '@ag-farm/protocol';

/** Lỗi HTTP từ ag-farm API */
export class FarmHttpError extends Error {
  /** Error code from the response envelope or legacy body (e.g. 'lease_lost', 'NOT_FOUND'). */
  readonly code?: string;

  constructor(
    readonly status: number,
    readonly body: unknown,
    message?: string,
  ) {
    const err = apiErrorOf(body);
    super(message ?? err.message ?? `Farm API error ${status}`);
    this.name = 'FarmHttpError';
    this.code = err.code;
  }
}
