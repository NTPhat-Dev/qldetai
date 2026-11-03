import jwt from 'jsonwebtoken'

export async function authorize(ctx, roles, fetch) {
  let claims
  try {
    const identityPublicKey = Buffer.from(process.env.INTERNAL_PUBLIC_IDENTITY ?? '', 'base64').toString('utf8')
    claims = jwt.verify(ctx.get('authorization').replace(/^Bearer\s+/i, ''), identityPublicKey, { algorithms: ['RS256'] })
    if (claims.mfaPending || claims.purpose || typeof claims.sub !== 'string') throw new Error('Pending authentication')
  } catch { ctx.throw(401, 'Phiên đăng nhập hết hạn hoặc không hợp lệ.') }
  if (claims.mustChangePassword || !roles.includes(claims.role)) ctx.throw(403, 'Bạn không có quyền thực hiện thao tác này.')
  const profile = await fetch(`http://identity-service:3101/internal/v1/identity/users/${claims.sub}`).then((response) => response.json())
  if (profile.status !== 'HOAT_DONG' || profile.role !== claims.role || profile.must_change_password || (claims.tokenVersion ?? 0) !== profile.token_version) ctx.throw(401, 'Phiên đăng nhập đã bị thu hồi. Vui lòng đăng nhập lại.')
  ctx.state.profile = profile
  return claims
}
