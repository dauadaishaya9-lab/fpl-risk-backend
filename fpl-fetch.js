const DEFAULT_TIMEOUT_MS = 20_000;
const RETRY_WAIT_MS = 25_000;
const MAX_RETRIES = 4;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryAfterMs(response) {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 120_000));
  return null;
}

function retryableError(error) {
  return error?.name === "AbortError"
    || error?.name === "TypeError"
    || /fetch|network|timeout|socket|ECONN|EAI_AGAIN|ENOTFOUND/i.test(String(error?.message || ""));
}

export async function fetchJSON(url, timeoutMs = DEFAULT_TIMEOUT_MS, options = {}) {
  const label = options.label || url;
  const retries = Number.isInteger(options.retries) ? Math.max(0, options.retries) : MAX_RETRIES;
  const userAgent = options.userAgent || "FPL-Risk-Calculator/1.0";

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": userAgent },
      });

      if (response.ok) return await response.json();

      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      if (!RETRYABLE_STATUS.has(response.status) || attempt >= retries) throw error;

      const retryAfter = retryAfterMs(response);
      const waitMs = retryAfter ?? RETRY_WAIT_MS;
      console.warn(`${label}: attempt ${attempt + 1}/${retries + 1} failed (${error.message}); waiting ${Math.ceil(waitMs / 1000)}s before retry.`);
      await sleep(waitMs);
    } catch (error) {
      if (attempt >= retries || (error.status && !RETRYABLE_STATUS.has(error.status)) || (!error.status && !retryableError(error))) throw error;
      console.warn(`${label}: attempt ${attempt + 1}/${retries + 1} failed (${error.message}); waiting ${Math.ceil(RETRY_WAIT_MS / 1000)}s before retry.`);
      await sleep(RETRY_WAIT_MS);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`FPL request failed after ${retries + 1} attempts: ${label}`);
}
