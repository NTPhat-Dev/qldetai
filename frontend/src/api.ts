export function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 12000): Promise<Response> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  init.signal?.addEventListener('abort', onAbort, { once: true })
  if (init.signal?.aborted) controller.abort()
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs)
  return fetch(input, { ...init, signal: controller.signal }).then((response) => {
    const path = String(input)
    if (response.status === 401 && new Headers(init.headers).has('Authorization') && !path.includes('/auth/mfa/') && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('qldetai:session-expired'))
    }
    return response
  }).finally(() => {
    globalThis.clearTimeout(timer)
    init.signal?.removeEventListener('abort', onAbort)
  })
}

export async function api<T>(path: string, token: string, method = 'GET', payload?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetchWithTimeout(`/api${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
  } catch { throw new Error('Kết nối đang gián đoạn. Vui lòng thử lại.') }
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error ?? 'Không thực hiện được yêu cầu.')
  return result as T
}

// randomUUID requires HTTPS in browsers; LAN demos still need stable request IDs.
export function newRequestId(source = globalThis.crypto): string {
  if (typeof source.randomUUID === 'function') return source.randomUUID()
  const bytes = source.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const shouldRetainQueuedRequest = (status: number) => status >= 500 || [401, 403, 408, 429].includes(status)
