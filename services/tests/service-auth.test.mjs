import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { verifyServiceToken } from '../shared/service-client.js'

const keys = Object.fromEntries(['academic', 'gateway'].map((name) => [name, generateKeyPairSync('rsa', { modulusLength: 2048 })]))
for (const [name, pair] of Object.entries(keys)) process.env[`INTERNAL_PUBLIC_${name.toUpperCase()}`] = Buffer.from(pair.publicKey.export({ format: 'pem', type: 'spki' })).toString('base64')
const sign = (service, signer = service, options = {}) => jwt.sign({ service, purpose: 'service-call' }, keys[signer].privateKey, { algorithm: 'RS256', audience: 'qldetai-services', expiresIn: '1m', ...options })

test('internal tokens require the correct service key, audience and signature', () => {
  assert.equal(verifyServiceToken(sign('academic')).service, 'academic')
  assert.throws(() => verifyServiceToken(sign('academic', 'gateway')))
  assert.throws(() => verifyServiceToken(sign('academic', 'academic', { audience: 'wrong-service' })))
  assert.throws(() => verifyServiceToken(jwt.sign({ service: 'academic', purpose: 'service-call' }, '', { algorithm: 'none' })))
})
