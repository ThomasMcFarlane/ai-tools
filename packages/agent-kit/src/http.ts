export interface FetchTextOptions {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  headers?: Record<string, string>;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchTextResult {
  url: string;
  status: number;
  text: string;
  headers: Record<string, string>;
}

export class HttpError extends Error {
  readonly url: string;
  readonly status: number | null;

  constructor(message: string, url: string, status: number | null) {
    super(message);
    this.name = 'HttpError';
    this.url = url;
    this.status = status;
  }
}

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function fetchText(
  url: string,
  opts: FetchTextOptions = {},
): Promise<FetchTextResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const backoffMs = opts.backoffMs ?? 500;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const headers = {
    'user-agent': opts.userAgent ?? DEFAULT_USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    ...opts.headers,
  };
  let lastError: HttpError | null = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
    try {
      const response = await fetchImpl(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (retryable(response.status) && attempt < retries) {
        lastError = new HttpError(`HTTP ${response.status} for ${url}`, url, response.status);
        continue;
      }
      const out: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        out[key] = value;
      });
      return {
        url: response.url === '' ? url : response.url,
        status: response.status,
        text,
        headers: out,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      lastError = new HttpError(`request failed for ${url}: ${reason}`, url, null);
    }
  }
  throw lastError ?? new HttpError(`request failed for ${url}`, url, null);
}
