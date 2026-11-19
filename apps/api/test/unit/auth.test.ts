import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AppError,
  ERROR_CODES,
  canvasNotFound,
  edgeDuplicate,
  insufficientScope,
  tokenExpired,
  tokenRevoked,
  unauthenticated,
  viewNotImplemented,
} from '../../src/lib/errors.ts'
import { hashToken, issueToken, looksLikePat, PAT_PREFIX, scopeLabel } from '../../src/lib/pat.ts'

test('每个 errorCode 都能被构造出来，且状态码符合契约', () => {
  const cases: ReadonlyArray<readonly [AppError, number, string]> = [
    [unauthenticated(), 401, 'UNAUTHENTICATED'],
    [tokenRevoked(), 401, 'TOKEN_REVOKED'],
    [tokenExpired(), 401, 'TOKEN_EXPIRED'],
    [insufficientScope('canvas:write', ['canvas:read']), 403, 'INSUFFICIENT_SCOPE'],
    [canvasNotFound('cv_x'), 404, 'CANVAS_NOT_FOUND'],
    [edgeDuplicate({ fromNodeId: 'a' }), 409, 'EDGE_DUPLICATE'],
    [viewNotImplemented('knowledge', 'M3'), 501, 'VIEW_NOT_IMPLEMENTED'],
  ]

  for (const [error, status, code] of cases) {
    assert.equal(error.status, status, `${code} 的状态码应为 ${status}`)
    assert.equal(error.code, code)
    assert.equal(error.toEnvelope().error.code, code)
  }
})

test('403 与 401 不能混：缺 scope 必须是 403', () => {
  const error = insufficientScope('canvas:write', ['canvas:read'])
  assert.equal(error.status, 403)
  // 这条断言删掉，就会有人把 403 写成 401，学生分不清"没登录"和"没权限"
  assert.notEqual(error.status, 401)
})

test('INSUFFICIENT_SCOPE 的 details 里带 required 与 granted', () => {
  const envelope = insufficientScope('canvas:write', ['canvas:read']).toEnvelope()
  assert.deepEqual(envelope.error.details, { required: 'canvas:write', granted: ['canvas:read'] })
})

test('错误信封结构固定为 { error: { code, message } }', () => {
  const envelope = unauthenticated().toEnvelope()
  assert.deepEqual(Object.keys(envelope), ['error'])
  assert.deepEqual(Object.keys(envelope.error).sort(), ['code', 'message'])
})

test('ERROR_CODES 无重复', () => {
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length)
})

test('token 明文格式：sg_pat_ 前缀 + 足够长度', () => {
  const issued = issueToken()
  assert.ok(issued.token.startsWith(PAT_PREFIX))
  assert.ok(issued.token.length > PAT_PREFIX.length + 32)
  assert.equal(looksLikePat(issued.token), true)
  assert.equal(looksLikePat('nope'), false)
})

test('库里存的 tokenHash 必须等于 sha256(明文)，且不等于明文', () => {
  const issued = issueToken()
  assert.equal(issued.tokenHash, hashToken(issued.token))
  assert.notEqual(issued.tokenHash, issued.token)
  assert.equal(issued.tokenHash.length, 64)
  assert.match(issued.tokenHash, /^[0-9a-f]{64}$/)
})

test('tokenPrefix 是前缀后的前 8 位，只用于展示', () => {
  const issued = issueToken()
  assert.equal(issued.tokenPrefix, issued.token.slice(PAT_PREFIX.length, PAT_PREFIX.length + 8))
  assert.equal(issued.token.includes(issued.tokenHash), false)
})

test('同一明文两次哈希结果一致（按 hash 查表的前提）', () => {
  const issued = issueToken()
  assert.equal(hashToken(issued.token), hashToken(issued.token))
})

test('scope 展示名与物理枚举一一对应', () => {
  assert.equal(scopeLabel('CANVAS_READ'), 'canvas:read')
  assert.equal(scopeLabel('CANVAS_WRITE'), 'canvas:write')
  assert.equal(scopeLabel('RUN_EXECUTE'), 'run:execute')
  assert.equal(scopeLabel('PROBLEM_READ'), 'problem:read')
})
