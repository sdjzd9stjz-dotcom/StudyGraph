// 离线校准（SG-SUP-012 §2.3）：不连库、不调模型，只吃产物里的判定输入快照。
//
// 用法：
//   node scripts/replay-calibration.mjs <artifact.json | 目录> [更多...]
//
// 期望的产物形状（ConceptClaims artifact 的 structured 字段，或直接是 conceptClaims 对象）：
//   { claims: [{ name, definition, quote, spanText, reasons, status }] }
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { CLASSIFIER_VERSION, classifyClaim } from '../apps/api/src/spans/claim-support.ts'

function collectFiles(target) {
  const stat = statSync(target)
  if (stat.isFile()) return [target]
  return readdirSync(target)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(target, name))
}

function extractClaims(json) {
  if (Array.isArray(json?.claims)) return json.claims
  if (Array.isArray(json?.conceptClaims?.claims)) return json.conceptClaims.claims
  if (Array.isArray(json?.structured?.conceptClaims?.claims)) return json.structured.conceptClaims.claims
  return []
}

const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error('用法：node scripts/replay-calibration.mjs <artifact.json | 目录>')
  process.exit(2)
}

const rows = []
for (const target of targets) {
  for (const file of collectFiles(target)) {
    const json = JSON.parse(readFileSync(file, 'utf8'))
    for (const claim of extractClaims(json)) {
      const hasSnapshot = typeof claim.spanText === 'string' && claim.spanText.length > 0
      const verdict = classifyClaim({
        name: claim.name,
        definition: claim.definition,
        quote: claim.quote,
        spanText: claim.spanText ?? '',
      })
      rows.push({
        name: (claim.name ?? '').slice(0, 16),
        quote: (claim.quote ?? '').slice(0, 20),
        A1: hasSnapshot ? (verdict.reasons.includes('A1_QUOTE_NOT_IN_SPAN') ? 'FAIL' : 'PASS') : 'NO_SNAPSHOT',
        J: Number(verdict.similarity.toFixed(3)),
        ratio: Number(verdict.lengthRatio.toFixed(2)),
        reasons: verdict.reasons.join(','),
        verdict: verdict.verdict,
        stored: claim.status ?? '-',
      })
    }
  }
}

const dist = rows.reduce((acc, row) => {
  acc[row.verdict] = (acc[row.verdict] ?? 0) + 1
  return acc
}, {})

console.log(`classifierVersion ${CLASSIFIER_VERSION}`)
console.log(`重放 ${rows.length} 条（无 spanText 快照的标 NO_SNAPSHOT）`)
console.table(rows)
console.log(JSON.stringify({ total: rows.length, dist, a1Fail: rows.filter((r) => r.A1 === 'FAIL').length }, null, 1))
