/**
 * Authenticated proxy to the Python worker service.
 *
 * The browser must never hold the worker's shared secret or reach the internal
 * service directly, so every mutating/ops call goes through here. The key is read
 * at call time (not module load) because env values may not exist yet at import.
 */
export interface WorkerResult {
  ok: boolean;
  status: number;
  data: any;
}

export async function callWorker(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<WorkerResult> {
  const base = process.env.WORKERS_URL || 'http://workers:8000';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 20000);
  try {
    const res = await fetch(`${base}${path}`, {
      method: init.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-worker-key': process.env.WORKER_API_SECRET || '',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 502, data: { error: 'worker unreachable', detail: (err as Error).message } };
  } finally {
    clearTimeout(timeout);
  }
}
