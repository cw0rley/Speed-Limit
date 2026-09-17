// fetch() with its own timeout that still honours the caller's abort signal.
// A caller abort re-throws the AbortError; our own timeout becomes Error('timeout').
export async function fetchWithTimeout(url, options, timeoutMs, signal, fetchImpl = fetch) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort);
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (signal && signal.aborted) throw e;
    throw new Error('timeout');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export const USER_AGENT = 'SpeedLimit/1.2 (com.claytonrugby.speedlimit)';
