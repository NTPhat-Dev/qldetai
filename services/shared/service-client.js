import jwt from 'jsonwebtoken'

const serviceNames = new Set(['identity', 'academic', 'registration', 'gateway'])
const internalSecret = () => process.env.INTERNAL_SERVICE_SECRET || `${process.env.JWT_SECRET}:internal-v1`

export function verifyServiceToken(token) {
  const claims = jwt.verify(token, internalSecret(), { audience: 'qldetai-services', algorithms: ['HS256'] })
  if (claims.purpose !== 'service-call' || !serviceNames.has(claims.service)) throw new Error('Invalid service credentials')
  return claims
}

// Each dependency call has a deadline and validates HTTP status before consumers read JSON.
// Access tokens from a browser never authorize the internal service contracts.
export function createServiceFetch(service) {
  return async (url, options = {}) => {
    const headers = new Headers(options.headers)
    if (new URL(url).pathname.startsWith('/internal/')) {
      headers.set('x-service-token', jwt.sign({ service, purpose: 'service-call' }, internalSecret(), { audience: 'qldetai-services', expiresIn: '1m', algorithm: 'HS256' }))
    }
    try {
      const response = await globalThis.fetch(url, { ...options, headers, signal: options.signal ?? AbortSignal.timeout(4000) })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        const error = new Error(response.status >= 500 ? 'Dịch vụ phụ thuộc đang khôi phục kết nối. Vui lòng thử lại.' : body.error || 'Yêu cầu dịch vụ không hợp lệ.')
        error.status = response.status >= 500 ? 503 : response.status
        throw error
      }
      return response
    } catch (error) {
      if (error.status) throw error
      const unavailable = new Error('Dịch vụ phụ thuộc đang khôi phục kết nối. Vui lòng thử lại.')
      unavailable.status = 503
      throw unavailable
    }
  }
}
