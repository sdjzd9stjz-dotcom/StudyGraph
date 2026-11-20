import type { ClaimClassification } from './claim-support.ts'

/**
 * 巡检的分级判定（SG-SUP-011 §3.2）。
 *
 * 不同来源的卡，成立条件本来就不同——一刀切会两头错：
 * - 只查引文 → 「鲸鱼是一种行星」留在 VERIFIED（硬约束 1 失守）
 * - 一律查完整 T1 → 人工认可过的合理转述被误杀
 *
 * 判别依据是 `reviewedBy` 是否为空（schema 里已有，不新增字段）。
 */
export interface IntegrityEntity {
  readonly status: string
  readonly reviewedBy?: string | null
}

export type IntegrityVerdict =
  | { readonly keep: true; readonly mode: 'HUMAN_APPROVED' | 'PENDING' | 'AUTO_T1' }
  | { readonly keep: false; readonly mode: 'HUMAN_APPROVED' | 'PENDING' | 'AUTO_T1'; readonly reason: 'UNSUPPORTED_DEFINITION' | 'TEXT_MISMATCH' }

/** A1：引文能在原文里逐字查到。这是所有档位的共同底线。 */
export function a1Passes(classification: ClaimClassification): boolean {
  return !classification.reasons.includes('A1_QUOTE_NOT_IN_SPAN') && !classification.reasons.includes('NO_QUOTE')
}

export function assessIntegrity(
  entity: IntegrityEntity,
  classification: ClaimClassification,
): IntegrityVerdict {
  const hasHumanDecision = typeof entity.reviewedBy === 'string' && entity.reviewedBy.length > 0

  if (hasHumanDecision) {
    // 人已经认可过这个转述：只要求引文仍然对得上
    return a1Passes(classification)
      ? { keep: true, mode: 'HUMAN_APPROVED' }
      : { keep: false, mode: 'HUMAN_APPROVED', reason: 'TEXT_MISMATCH' }
  }

  if (entity.status === 'VERIFIED') {
    // 自动核实的卡：必须仍然经得起完整 T1 判定
    return classification.verdict === 'VERIFIED'
      ? { keep: true, mode: 'AUTO_T1' }
      : {
          keep: false,
          mode: 'AUTO_T1',
          reason: a1Passes(classification) ? 'UNSUPPORTED_DEFINITION' : 'TEXT_MISMATCH',
        }
  }

  // PENDING_REVIEW：引文可查即可，定义等人看
  return a1Passes(classification)
    ? { keep: true, mode: 'PENDING' }
    : { keep: false, mode: 'PENDING', reason: 'TEXT_MISMATCH' }
}
