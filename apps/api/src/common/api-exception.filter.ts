import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiErrorDto } from './dto/api-error.dto';
import { ApiResponseDto } from './dto/api-response.dto';

type ErrorPayload = Record<string, unknown>;

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const status = this.getStatus(exception);
    const error = this.toApiError(exception, status);
    const requestId =
      request.requestId ?? String(response.getHeader('x-request-id') ?? '');

    response.status(status).json(new ApiResponseDto(null, requestId, false, error));
  }

  private getStatus(exception: unknown): number {
    return exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private toApiError(exception: unknown, status: number): ApiErrorDto {
    if (!(exception instanceof HttpException)) {
      return new ApiErrorDto('INTERNAL_SERVER_ERROR', 'Internal server error');
    }

    const payload = exception.getResponse();
    if (typeof payload === 'string') {
      return new ApiErrorDto(this.defaultCode(status), payload);
    }

    const record = this.isRecord(payload) ? payload : {};

    // Detect validation errors:
    // - class-validator produces an array `message` field
    // - zod pipe (with code: 'VALIDATION_ERROR') produces an array or explicit code
    const rawMessage = record['message'];
    const isArrayMessage = Array.isArray(rawMessage);
    const isValidationError =
      isArrayMessage || record['code'] === 'VALIDATION_ERROR';

    const message = isValidationError
      ? 'Request validation failed'
      : typeof rawMessage === 'string'
        ? rawMessage
        : this.defaultMessage(status);

    // Build details: validation messages or explicit details field
    let details: unknown = isValidationError
      ? isArrayMessage
        ? { messages: rawMessage }
        : { messages: record['issues'] ?? [] }
      : record['details'];

    // Fold in any extra fields not already captured, so no data is lost.
    // Recognised keys that are handled separately are excluded.
    const handledKeys = new Set([
      'code',
      'message',
      'details',
      'fieldErrors',
      'statusCode',
      'error',     // legacy alias; read but not re-emitted at top level
    ]);
    const extras: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (!handledKeys.has(k)) extras[k] = v;
    }
    if (Object.keys(extras).length > 0) {
      if (details == null) {
        details = extras;
      } else if (this.isRecord(details)) {
        details = { ...details, ...extras };
      }
    }

    const fieldErrors = this.toFieldErrors(record['fieldErrors']);

    // Prefer an explicit `code` field; fall back to VALIDATION_ERROR for
    // validation, or the HTTP-status default.
    const code =
      typeof record['code'] === 'string'
        ? record['code']
        : isValidationError
          ? 'VALIDATION_ERROR'
          : this.defaultCode(status);

    return new ApiErrorDto(code, message, { details, fieldErrors });
  }

  private toFieldErrors(
    value: unknown,
  ): Record<string, string[]> | undefined {
    if (!this.isRecord(value)) {
      return undefined;
    }

    const fieldErrors: Record<string, string[]> = {};
    for (const [field, messages] of Object.entries(value)) {
      if (
        Array.isArray(messages) &&
        messages.every((m) => typeof m === 'string')
      ) {
        fieldErrors[field] = messages;
      }
    }

    return Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined;
  }

  private isRecord(value: unknown): value is ErrorPayload {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private defaultCode(status: number): string {
    return `HTTP_${status}`;
  }

  private defaultMessage(status: number): string {
    return status >= 500 ? 'Internal server error' : 'Request failed';
  }
}
