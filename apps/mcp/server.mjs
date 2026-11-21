#!/usr/bin/env node
/**
 * StudyGraph MCP Server（M4 · 开放能力）。
 *
 * 协议：MCP over stdio —— 每行一条 JSON-RPC 2.0 消息。
 * 依赖：零。不引 MCP SDK，因为这里只需要 initialize / tools/list / tools/call 三个方法，
 * 引一个 SDK 换来的是一棵依赖树和一次版本漂移风险。
 *
 * **只暴露真实存在的工具**。规格里列的 methods.match / problems.generate / papers.assemble
 * 依赖 M5 / M6 的节点，现在还没有 —— 它们不在 tools/list 里，
 * 而不是返回一个空实现。外部 Agent 拿到空结果会当成"没有数据"，那是最坏的误导。
 *
 * 环境变量：
 *   STUDYGRAPH_API_BASE_URL   API 地址（桌面版每次启动才定端口，必须运行时给）
 *   STUDYGRAPH_DEV_PAT        PAT 明文
 */
import { createInterface } from 'node:readline'

const API_BASE = (process.env.STUDYGRAPH_API_BASE_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '')
const PAT = process.env.STUDYGRAPH_DEV_PAT ?? ''
const PROTOCOL_VERSION = '2024-11-05'

/** 工具定义：name → REST 调用。description 会直接给外部 Agent 看，写清楚边界。 */
const TOOLS = {
  'canvas.create': {
    description: '新建一张画布。返回画布 id。',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: '画布标题' } },
      required: ['title'],
    },
    run: async ({ title }) => post('/v1/canvases', { title }),
  },

  'canvas.get': {
    description: '读取一张画布的节点与连线（不含产物内容）。',
    inputSchema: {
      type: 'object',
      properties: { canvasId: { type: 'string' } },
      required: ['canvasId'],
    },
    run: async ({ canvasId }) => get(`/v1/canvases/${canvasId}`),
  },

  'canvas.clone': {
    description: '克隆一张画布的结构（节点与连线），不复制课件与概念卡。',
    inputSchema: {
      type: 'object',
      properties: { canvasId: { type: 'string' }, title: { type: 'string' } },
      required: ['canvasId'],
    },
    run: async ({ canvasId, title }) => post(`/v1/canvases/${canvasId}/clone`, title ? { title } : {}),
  },

  'node.create': {
    description:
      '在画布上新建一个节点。type 必须是 17 种节点类型之一（SOURCE/CHUNK/EXTRACT/CARD/PREREQ/...）。新节点状态为 DRAFT，需要显式 run。',
    inputSchema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string' },
        type: { type: 'string' },
        title: { type: 'string' },
        params: { type: 'object', description: '节点参数，例如 source 节点的 localPath' },
      },
      required: ['canvasId', 'type'],
    },
    run: async ({ canvasId, type, title, params }) =>
      post(`/v1/canvases/${canvasId}/nodes`, { type, ...(title ? { title } : {}), ...(params ? { params } : {}) }),
  },

  'node.run': {
    description:
      '显式触发一个节点执行。这是唯一会让系统消耗模型额度的操作，必须由用户发起；不会自动级联执行下游节点。',
    inputSchema: {
      type: 'object',
      properties: { nodeId: { type: 'string' }, dryRun: { type: 'boolean', description: '只算指纹与缓存命中，不执行' } },
      required: ['nodeId'],
    },
    run: async ({ nodeId, dryRun }) => post(`/v1/nodes/${nodeId}/run${dryRun ? '?dryRun=true' : ''}`, {}),
  },

  'graph.query': {
    description: '读取画布图。view=pipeline 看数据流，view=knowledge 看概念与先修关系（含掌握度）。',
    inputSchema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string' },
        view: { type: 'string', enum: ['pipeline', 'knowledge'], default: 'pipeline' },
      },
      required: ['canvasId'],
    },
    run: async ({ canvasId, view = 'pipeline' }) => get(`/v1/canvases/${canvasId}/graph?view=${view}`),
  },

  'review.due': {
    description: '列出当前到期的复习卡（按 FSRS 排程）。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', default: 30 } },
      required: [],
    },
    run: async ({ limit = 30 }) => get(`/v1/reviews/due?limit=${limit}`),
  },

  'concept.grade': {
    description: '给一张概念卡打分，按 FSRS 重排下次复习时间。grade 取 AGAIN / HARD / GOOD / EASY。',
    inputSchema: {
      type: 'object',
      properties: { conceptId: { type: 'string' }, grade: { type: 'string', enum: ['AGAIN', 'HARD', 'GOOD', 'EASY'] } },
      required: ['conceptId', 'grade'],
    },
    run: async ({ conceptId, grade }) => post(`/v1/concepts/${conceptId}/grade`, { grade }),
  },
}

async function api(path, init) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${PAT}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text }
  }
  if (!response.ok) {
    const message = body?.error?.message ?? `HTTP ${response.status}`
    throw new Error(`${message}${body?.error?.code ? ` (${body.error.code})` : ''}`)
  }
  return body
}

const get = (path) => api(path, { method: 'GET' })
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(message) {
  const { id, method, params } = message

  // 通知不需要回复
  const isNotification = id === undefined || id === null

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'studygraph', version: '0.4.0' },
      })
      return

    case 'notifications/initialized':
      return

    case 'ping':
      if (!isNotification) reply(id, {})
      return

    case 'tools/list':
      reply(id, {
        tools: Object.entries(TOOLS).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      })
      return

    case 'tools/call': {
      const name = params?.name
      const tool = TOOLS[name]
      if (!tool) {
        fail(id, -32602, `未知工具：${name}。可用：${Object.keys(TOOLS).join(', ')}`)
        return
      }
      try {
        const result = await tool.run(params?.arguments ?? {})
        reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
      } catch (error) {
        // 工具执行失败要作为 isError 返回，而不是 JSON-RPC 错误 ——
        // 前者是"调用成功但业务失败"，后者会被客户端当成协议层故障
        reply(id, {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        })
      }
      return
    }

    default:
      if (!isNotification) fail(id, -32601, `不支持的方法：${method}`)
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    fail(null, -32700, 'JSON 解析失败')
    return
  }
  handle(message).catch((error) => {
    if (message?.id !== undefined && message?.id !== null) {
      fail(message.id, -32603, error instanceof Error ? error.message : String(error))
    }
  })
})
