import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'rawResponse';

/**
 * The route answers with its body as-is, not wrapped in the
 * `{ data, requestId, timestamp, success, error }` envelope.
 * Use for machine callers that follow another contract.
 */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);
