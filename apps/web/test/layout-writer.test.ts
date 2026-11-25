import test from 'node:test'
import assert from 'node:assert/strict'
import { LayoutWriter } from '../lib/layout-writer.ts'

test('旧请求完成时不会抹掉在途的新坐标，失败保留至重试', async () => {
  const q = new LayoutWriter()
  const stage = (posX:number) => q.stage({nodes:[{id:'a',posX,posY:4}],groups:[]})
  stage(3)
  const first = q.flush(async b => { assert.equal(b.nodes[0]?.posX,3); stage(10) })
  await first
  await assert.rejects(q.flush(async () => {throw Error('offline')}))
  assert.equal(q.pending().nodes[0]?.posX,10)
  await q.flush(async b => {assert.equal(b.nodes[0]?.posX,10)})
  assert.deepEqual(q.pending(),{nodes:[],groups:[]})
})
