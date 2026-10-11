export type Platform = "instagram" | "tiktok" | "youtube" | "x";
export const PLATFORMS: readonly Platform[] = ["instagram", "tiktok", "youtube", "x"];

export type ProviderResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

export type ProviderRequest = {
  platform: Platform;
  accessToken: string;
  since: string;
  until: string;
  cursor: string | null;
};


export type ProviderTransport = {
  listPostMetrics(request: ProviderRequest): Promise<ProviderResponse>;
};


export type PostSnapshot = {
  post_id: string;
  published_at: string;
  captured_at: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
};

export type MetricsPage = {
  posts: PostSnapshot[];
  next_cursor: string | null;
};

export class ProviderTimeoutError extends Error {
  constructor() {
    super("o provedor não respondeu dentro do prazo");
  }
}
