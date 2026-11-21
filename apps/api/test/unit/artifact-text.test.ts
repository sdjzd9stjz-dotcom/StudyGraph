import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeArtifact } from '../../src/domain/artifact-text.ts'

/**
 * 节点卡片上的文字。
 *
 * 这些形状**取自真实数据库**（2026-11-21 那份复习课 pptx 的产物），不是手编的理想结构。
 * 之前就是在这里翻过车：执行器按 outputs 契约多包了一层
 * （`{chunkSet:{chunks}}` / `{cards:{cards}}`），摘要却按平铺读，
 * 于是界面上永远是「0 张知识卡」—— 用户以为抽取白跑了，模型也照着 0 回答。
 */

test('CHUNKS：读 chunkSet.chunks，不是把 chunkSet 当数组', () => {
  const text = summarizeArtifact('CHUNKS', {
    chunkSet: {
      chunks: [
        { id: 'chunk-1', text: '数学分析（上册）期中复习常识' },
        { id: 'chunk-2', text: '确界存在定理' },
      ],
    },
  })
  assert.match(text, /切成 2 段/)
  assert.match(text, /数学分析/)
})

test('CONCEPT_CARD：读 cards.cards，并给出已核对 / 待复核数量', () => {
  const text = summarizeArtifact('CONCEPT_CARD', {
    cards: {
      total: 2,
      verified: 1,
      pendingReview: 1,
      unverified: 0,
      skipped: [],
      cards: [
        { name: '上确界', definition: '它是上界，且任何更小的数都不是上界。' },
        { name: '基本列', definition: '只问项与项是否靠拢的数列。' },
      ],
    },
  })
  assert.match(text, /2 张知识卡/)
  assert.match(text, /已核对 1 · 待复核 1/)
  assert.match(text, /上确界/)
})

test('PREREQ_PROPOSAL：读 edges（模型原样的 pairs 不会落库）', () => {
  const text = summarizeArtifact('PREREQ_PROPOSAL', {
    proposed: 1,
    confirmedPreserved: 0,
    skipped: [],
    edges: [{ id: 'c1', from: '基本列', to: '柯西准则', rationale: '先有基本列才谈得上准则' }],
  })
  assert.match(text, /提议 1 条/)
  assert.match(text, /基本列/)
})

test('PROBLEM_DRAFT：报出实际出题数与要求数', () => {
  const text = summarizeArtifact('PROBLEM_DRAFT', {
    created: [{ stem: '求上确界' }],
    requested: 3,
    actual: 1,
    dropped: [{ stem: 'x' }],
  })
  assert.match(text, /出题 1 道（要求 3 道）/)
  assert.match(text, /丢弃 1 道/)
})
