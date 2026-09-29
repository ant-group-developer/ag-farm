import axios, { type AxiosRequestConfig } from 'axios';
import { getAccessToken } from '../../auth/auth-client';

const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';

declare module 'axios' {
  export interface AxiosRequestConfig {
    skipAuth?: boolean;
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const axiosInstance = axios.create({
  baseURL: API_BASE_URL,
  headers: { Accept: 'application/json' },
});

axiosInstance.interceptors.request.use(async (config) => {
  if (!config.skipAuth && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${await getAccessToken()}`;
  }
  return config;
});

export async function apiClient<T>(
  path: string,
  init?: { method?: string; body?: unknown; skipAuth?: boolean },
): Promise<T> {
  const config: AxiosRequestConfig = {
    url: path,
    method: init?.method ?? 'GET',
    data: init?.body,
    skipAuth: init?.skipAuth,
  };
  if (init?.body !== undefined) {
    config.headers = { 'Content-Type': 'application/json' };
  }
  try {
    const response = await axiosInstance.request<T>(config);
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status ?? 0;
      const data = error.response?.data as Record<string, unknown> | undefined;
      const message =
        typeof data?.message === 'string'
          ? data.message
          : (error.message ?? 'API request failed');
      throw new ApiError(message, status);
    }
    throw new ApiError(error instanceof Error ? error.message : 'API request failed', 0);
  }
}

/** Convenience wrappers */
export const api = {
  get: <T>(path: string) => apiClient<T>(path),
  post: <T>(path: string, body?: unknown) => apiClient<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiClient<T>(path, { method: 'PATCH', body }),
  delete: <T = void>(path: string) => apiClient<T>(path, { method: 'DELETE' }),
};
