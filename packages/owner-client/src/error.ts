/** Lỗi HTTP từ ag-farm API */
export class FarmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `Farm API error ${status}`);
    this.name = 'FarmHttpError';
  }
}
