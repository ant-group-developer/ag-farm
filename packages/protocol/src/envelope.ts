/**
 * Envelope helpers shared by every client that talks to ag-farm or ag-go-api.
 *
 * Envelope shape (success):
 *   { data, requestId, timestamp, success: true, error: null }
 *
 * Envelope shape (error):
 *   { data: null, requestId, timestamp, success: false,
 *     error: { code, message, details?, fieldErrors? } }
 *
 * These helpers let clients accept BOTH the new enveloped responses and the
 * old raw bodies produced by pre-envelope hubs, so rollouts are gradual and
 * safe.
 */

import { z } from 'zod';

// ---- Zod schemas ----

export const ApiEnvelopeErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
});
export type ApiEnvelopeError = z.infer<typeof ApiEnvelopeErrorSchema>;

export const ApiEnvelopeSchema = z.object({
  data: z.unknown(),
  requestId: z.string(),
  timestamp: z.string(),
  success: z.boolean(),
  error: ApiEnvelopeErrorSchema.nullable(),
});
export type ApiEnvelope = z.infer<typeof ApiEnvelopeSchema>;

// ---- Envelope detection ----

/**
 * Returns true when the body is an API response envelope.
 * Detection is intentionally duck-typed so it works without a full parse.
 */
function isEnvelope(body: unknown): body is ApiEnvelope {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const c = body as Record<string, unknown>;
  return (
    typeof c['success'] === 'boolean' &&
    'data' in c &&
    typeof c['requestId'] === 'string'
  );
}

// ---- Public helpers ----

/**
 * Unwrap an API response envelope, returning `data`.
 * If the body is NOT an envelope (legacy raw response), returns the body unchanged.
 * This makes clients backward-compatible with hubs that have not yet been updated.
 */
export function unwrapApiResponse<T>(body: unknown): T {
  if (isEnvelope(body)) {
    return body.data as T;
  }
  return body as T;
}

/**
 * Extract a normalised `{ code?, message?, details? }` error descriptor from
 * any response body, regardless of whether it comes from:
 *  - A new enveloped hub:         `{ success: false, error: { code, message } }`
 *  - Legacy lease/cancel errors:  `{ error: 'lease_lost', message }`
 *  - NestJS default errors:       `{ statusCode, message, error }`
 */
export function apiErrorOf(body: unknown): { code?: string; message?: string; details?: unknown } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};

  // Work with a plain Record for uniform field access
  const b = body as Record<string, unknown>;

  // New envelope format: { success: false, error: { code, message, ... } }
  if (
    typeof b['success'] === 'boolean' &&
    b['success'] === false &&
    'data' in b &&
    typeof b['requestId'] === 'string' &&
    b['error'] != null &&
    typeof b['error'] === 'object' &&
    !Array.isArray(b['error'])
  ) {
    const err = b['error'] as Record<string, unknown>;
    return {
      code: typeof err['code'] === 'string' ? err['code'] : undefined,
      message: typeof err['message'] === 'string' ? err['message'] : undefined,
      details: err['details'],
    };
  }

  // Legacy lease_lost / job_cancelled: { error: 'lease_lost', message: '...' }
  if (typeof b['error'] === 'string') {
    return {
      code: b['error'] as string,
      message: typeof b['message'] === 'string' ? b['message'] : undefined,
    };
  }

  // NestJS default error shape: { statusCode, message, error }
  if (typeof b['statusCode'] === 'number') {
    return {
      code:
        typeof b['error'] === 'string'
          ? (b['error'] as string)
          : `HTTP_${b['statusCode'] as number}`,
      message: typeof b['message'] === 'string' ? b['message'] : undefined,
    };
  }

  // Generic: whatever code/message fields are present
  return {
    code: typeof b['code'] === 'string' ? b['code'] : undefined,
    message: typeof b['message'] === 'string' ? b['message'] : undefined,
  };
}
