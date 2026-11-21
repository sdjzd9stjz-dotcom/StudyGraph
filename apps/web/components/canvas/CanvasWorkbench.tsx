'use client'

import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react'
import type { Connection, Edge as FlowEdge, Node as FlowNode } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { NODE_PORTS, validateConnection } from '../../../../packages/contracts/src/client'
import type { NodeType } from '../../../../packages/contracts/src/client'
import { ADVANCED_NODES, PRIMARY_NODES, nodeLabel, nodeColor } from '../../lib/canvas-meta'
import { decideGate } from '../../lib/api'
import { AssistantBar } from './AssistantBar'
import { ContextMenu } from './ContextMenu'
import type { MenuContext } from './ContextMenu'
import { SgNode } from './SgNode'
import type { SgNodeData } from './SgNode'
import { NodeSearch } from './NodeSearch'
import { Sidebar } from './Sidebar'
import type { SkillView } from './Sidebar'

const nodeTypes = { sg: SgNode }

export interface WorkbenchNode {
  id: string
  type: string
  title: string | null
  status: string
  posX: number
  posY: number
  /** 只有 GATE 用到（approved / note），其余类型忽略 */
  params?: Record<string, unknown> | null
}

export interface WorkbenchEdge {
  id: string
  fromNodeId: string
  toNodeId: string
  fromPort: string
  toPort: string
}

export interface WorkbenchGroup {
  id: string
  title: string
  posX: number
  posY: number
  color: string
  memberIds: string[]
  usedBy: string[]
}

function toFlowNode(node: WorkbenchNode, skillsByNode: Map<string, string[]>): FlowNode {
  const type = node.type as NodeType
  const ports = NODE_PORTS[type] ?? { inputs: [], outputs: [] }
  const data: SgNodeData = {
    nodeType: node.type,
    label: nodeLabel(node.type),
    status: node.status,
    title: node.title,
    skills: skillsByNode.get(node.id) ?? [],
    outputSummary: null,
    inputs: ports.inputs.map((port) => ({ name: port.name, type: port.type, external: port.external === true })),
    outputs: ports.outputs.map((port) => ({ name: port.name, type: port.type, external: port.external === true })),
  }

  // GATE 的闸门状态来自 params：刷新页面后仍要看得出"这张卡放行了没有"
  if (node.type === 'GATE') {
    data.gateApproved = node.params?.approved === true
    data.gateNote = typeof node.params?.note === 'string' ? node.params.note : null
  }

  return { id: node.id, type: 'sg', position: { x: node.posX, y: node.posY }, data }
}

function Inner({
  canvasId,
  apiBaseUrl,
  token,
  initialNodes,
  initialEdges,
  initialGroups,
  skills,
  nodeSkills,
}: {
  canvasId: string
  apiBaseUrl: string
  token: string
  initialNodes: WorkbenchNode[]
  initialEdges: WorkbenchEdge[]
  initialGroups: WorkbenchGroup[]
  skills: SkillView[]
  nodeSkills: Record<string, string[]>
}) {
  const skillsByNode = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const [nodeId, names] of Object.entries(nodeSkills)) map.set(nodeId, names)
    return map
  }, [nodeSkills])

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initialNodes.map((node) => toFlowNode(node, skillsByNode)))
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(
    initialEdges.map((edge) => ({ id: edge.id, source: edge.fromNodeId, target: edge.toNodeId, sourceHandle: edge.fromPort, targetHandle: edge.toPort })),
  )
  const [groups, setGroups] = useState<WorkbenchGroup[]>(initialGroups)
  const [menu, setMenu] = useState<MenuContext | null>(null)
  /**
   * 节点搜索浮层。两种来源：
   *   · 双击空白 → 列出全部类型
   *   · 端口拖到空白处松手 → 只列能接上的类型，选中后自动连线
   */
  const [search, setSearch] = useState<{
    x: number
    y: number
    flowX: number
    flowY: number
    /** 端口拖拽的来源；为空表示双击空白 */
    origin: { nodeId: string; handleId: string; handleType: 'source' | 'target' } | null
    allowed: Set<NodeType> | null
    reason: string | null
  } | null>(null)
  /** 正在从哪个端口拖线（onConnectStart → onConnectEnd） */
  const connecting = useRef<{ nodeId: string; handleId: string; handleType: 'source' | 'target' } | null>(null)
  /**
   * 拖线中的实时状态，用来给画布上的节点打高亮。
   *
   * 与 `connecting`（ref）分开：ref 改了不会重渲染，高亮必须走 state。
   * `allowed` 是"哪些类型能接上这个端口"，节点据此决定自己是亮还是暗。
   */
  const [connectDraft, setConnectDraft] = useState<{
    originNodeId: string
    originHandleId: string
    /** 拖的是输出口（找目标的输入口）还是输入口（找源的输出口） */
    originHandleType: 'source' | 'target'
    allowed: Set<NodeType>
    /** 节点类型 → 能接上的具体端口名 */
    portsByType: Map<NodeType, string[]>
  } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const wrapper = useRef<HTMLDivElement>(null)
  const { screenToFlowPosition, getViewport } = useReactFlow()

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }

  /**
   * 双击空白 → 节点搜索。
   *
   * 为什么用原生监听而不是 ReactFlow 的 onDoubleClick：
   * ReactFlow 的根节点并没有把 dblclick 透传到组件 props（实测点了没反应）。
   * 挂在容器上更可靠，也顺便能判断"点的是不是空白处"。
   */
  useEffect(() => {
    const element = wrapper.current
    if (!element) return
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      // 点在节点上不要弹搜索（那是重命名/编辑的位置）。
      // 不用 classList.contains('react-flow__pane')：pane 内部还有 renderer / viewport 等
      // 子元素，事件目标是哪一个取决于点在哪儿，用"是否落在节点内"判断更稳。
      if (target.closest('.react-flow__node')) return
      const rect = element.getBoundingClientRect()
      const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      setSearch({
        x: Math.min(event.clientX, rect.left + rect.width - 310),
        y: Math.min(event.clientY, rect.top + rect.height - 340),
        flowX: flow.x,
        flowY: flow.y,
        origin: null,
        allowed: null,
        reason: null,
      })
    }
    // 必须用捕获阶段：ReactFlow 的 pane 自己处理双击（双击缩放）并在冒泡阶段
    // stopPropagation，冒泡监听永远收不到（实测：document 上加播放器能收到，
    // 容器上的冒泡监听收不到）。
    element.addEventListener('dblclick', handler, true)
    return () => element.removeEventListener('dblclick', handler, true)
  }, [screenToFlowPosition])

  const notify = useCallback((message: string) => {
    setToast(message)
    setTimeout(() => setToast(null), 2600)
  }, [])

  // ── 节点操作 ────────────────────────────────────────────────────────────
  const createNode = useCallback(
    async (type: NodeType, x: number, y: number): Promise<WorkbenchNode | null> => {
      const response = await fetch(`${apiBaseUrl}/v1/canvases/${canvasId}/nodes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type, posX: Math.round(x), posY: Math.round(y) }),
      })
      if (!response.ok) {
        notify(`创建失败：${response.status}`)
        return null
      }
      const created = (await response.json()) as WorkbenchNode
      setNodes((current) => [...current, toFlowNode(created, skillsByNode)])
      // 返回给调用方：端口拖拽建节点要在建完之后立刻接线
      return created
    },
    [apiBaseUrl, canvasId, notify, setNodes, skillsByNode, token],
  )

  const deleteNode = useCallback(
    async (nodeId: string) => {
      const response = await fetch(`${apiBaseUrl}/v1/nodes/${nodeId}`, { method: 'DELETE', headers })
      if (!response.ok && response.status !== 204) {
        notify(`删除失败：${response.status}`)
        return
      }
      setNodes((current) => current.filter((node) => node.id !== nodeId))
      setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId))
    },
    [apiBaseUrl, notify, setEdges, setNodes, token],
  )

  const duplicateNode = useCallback(
    async (nodeId: string) => {
      const source = nodes.find((node) => node.id === nodeId)
      if (!source) return
      await createNode(source.data.nodeType as NodeType, source.position.x + 40, source.position.y + 60)
    },
    [createNode, nodes],
  )

  const renameNode = useCallback(
    async (nodeId: string) => {
      const current = nodes.find((node) => node.id === nodeId)
      const title = window.prompt('节点名称', String(current?.data.title ?? ''))
      if (title === null) return
      await fetch(`${apiBaseUrl}/v1/nodes/${nodeId}`, { method: 'PATCH', headers, body: JSON.stringify({ title }) })
      setNodes((existing) => existing.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, title } } : node)))
    },
    [apiBaseUrl, nodes, setNodes, token],
  )

  const runNode = useCallback(
    async (nodeId: string) => {
      setNodes((current) => current.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, running: true } } : node)))
      try {
        const response = await fetch(`${apiBaseUrl}/v1/nodes/${nodeId}/run`, { method: 'POST', headers })
        const body = (await response.json().catch(() => null)) as { status?: string; error?: { message?: string } } | null
        if (!response.ok) {
          notify(body?.error?.message ?? `执行失败：${response.status}`)
        } else {
          notify(`执行${body?.status === 'SUCCEEDED' ? '成功' : `：${body?.status}`}`)
          setNodes((current) => current.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, status: body?.status ?? 'READY' } } : node)))
        }
      } finally {
        setNodes((current) => current.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, running: false } } : node)))
      }
    },
    [apiBaseUrl, notify, setNodes, token],
  )

  /**
   * GATE 放行 / 拒绝。
   *
   * 拒绝时必须问理由：无理由的拒绝，上游不知道要改什么（服务端也会拒）。
   * 这里用 prompt 而不是弹窗组件，是因为拒绝是低频动作，
   * 为它引入一套 Modal 不值得；但绝不能静默拒绝。
   */
  const decideGateNode = useCallback(
    async (nodeId: string, approved: boolean) => {
      let note: string | undefined
      if (!approved) {
        const input = window.prompt('拒绝的理由（上游据此修改，必填）：')
        if (input === null) return
        note = input.trim()
        if (note.length === 0) {
          notify('必须填写拒绝理由')
          return
        }
      }
      const result = await decideGate(nodeId, note ? { approved, note } : { approved })
      if (!result.ok) {
        notify(`闸门操作失败：${result.message}`)
        return
      }
      notify(approved ? '已放行（下游需自己点运行）' : '已拒绝')
      setNodes((current) =>
        current.map((node) =>
          node.id === nodeId ? { ...node, data: { ...node.data, gateApproved: result.approved } } : node,
        ),
      )
    },
    [notify, setNodes],
  )

  const openPrompt = useCallback(
    async (nodeId: string) => {
      const bound = skillsByNode.get(nodeId) ?? []
      const answer = window.prompt(
        `给这个节点绑定技能（逗号分隔 slug，留空则解绑）\n可选：${skills.map((skill) => skill.slug).join(', ')}`,
        bound.join(','),
      )
      if (answer === null) return
      const slugs = answer.split(/[,，\s]+/).filter(Boolean)
      const ids = slugs.map((slug) => skills.find((skill) => skill.slug === slug)?.id).filter((id): id is string => Boolean(id))
      const response = await fetch(`${apiBaseUrl}/v1/nodes/${nodeId}/skills`, { method: 'PUT', headers, body: JSON.stringify({ skillIds: ids }) })
      if (!response.ok) {
        notify('绑定失败')
        return
      }
      const names = slugs.filter((slug) => skills.some((skill) => skill.slug === slug))
      skillsByNode.set(nodeId, names)
      setNodes((current) => current.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, skills: names } } : node)))
      notify(names.length > 0 ? `已绑定 ${names.join(', ')}（指纹会变，下次执行会重跑）` : '已解绑全部技能')
    },
    [apiBaseUrl, notify, setNodes, skills, skillsByNode, token],
  )

  /**
   * 端口拖到空白处松手：算出"哪些节点类型能接上这个端口"。
   *
   * 判定复用 contracts 的 `validateConnection` —— 与手工连线、服务端用的是同一套，
   * 不在这里另写一份类型兼容表（那样改一处忘一处，最后两边对不上）。
   */
  const allowedForPort = useCallback(
    (
      origin: { nodeId: string; handleId: string; handleType: 'source' | 'target' },
    ): { allowed: Set<NodeType>; portsByType: Map<NodeType, string[]>; reason: string } => {
      const fromNode = nodes.find((node) => node.id === origin.nodeId)
      const fromType = String(fromNode?.data?.nodeType ?? '') as NodeType
      const allowed = new Set<NodeType>()
      /**
       * 节点类型 → 该类型上**具体哪几根端口**能接上。
       *
       * 只有端口级信息才能把高亮画到具体那根线上；节点级只能整块变色，
       * 遇到有多个输入口的节点（EXTRACT 有两根）就分不清该接哪根。
       */
      const portsByType = new Map<NodeType, string[]>()

      if (!fromType) return { allowed, portsByType, reason: '找不到源节点' }

      if (origin.handleType === 'source') {
        // 从输出口拖出：目标节点必须有能接这个输出的输入端口
        for (const candidate of [...PRIMARY_NODES, ...ADVANCED_NODES]) {
          const target = candidate.type
          const matched = (NODE_PORTS[target]?.inputs ?? [])
            .filter((port) => !port.external)
            .filter((port) => validateConnection({ fromType, fromPort: origin.handleId, toType: target, toPort: port.name }).ok)
            .map((port) => port.name)
          if (matched.length > 0) {
            allowed.add(target)
            portsByType.set(target, matched)
          }
        }
        return { allowed, portsByType, reason: `能接 ${fromType}.${origin.handleId} 的节点` }
      }

      // 从输入口拖出：源节点必须有能喂这个输入的输出端口
      for (const candidate of [...PRIMARY_NODES, ...ADVANCED_NODES]) {
        const source = candidate.type
        const matched = (NODE_PORTS[source]?.outputs ?? [])
          .filter((port) => !port.external)
          .filter((port) => validateConnection({ fromType: source, fromPort: port.name, toType: fromType, toPort: origin.handleId }).ok)
          .map((port) => port.name)
        if (matched.length > 0) {
          allowed.add(source)
          portsByType.set(source, matched)
        }
      }
      return { allowed, portsByType, reason: `能喂 ${fromType}.${origin.handleId} 的节点` }
    },
    [nodes],
  )

  /** 搜索面板选中一个类型：建节点；若是端口拖拽来的，建完立刻接线 */
  const pickFromSearch = useCallback(
    async (type: NodeType) => {
      const current = search
      setSearch(null)
      if (!current) return

      const created = await createNode(type, current.flowX, current.flowY)
      if (!created || !current.origin) return

      const { origin } = current
      const sourceIsOrigin = origin.handleType === 'source'
      const fromType = sourceIsOrigin ? String(nodes.find((node) => node.id === origin.nodeId)?.data?.nodeType ?? '') : type
      const toType = sourceIsOrigin ? type : String(nodes.find((node) => node.id === origin.nodeId)?.data?.nodeType ?? '')

      // 挑一个能通过的端口组合。优先默认端口，不行再逐个试。
      const fromPorts = NODE_PORTS[fromType as NodeType]?.outputs ?? []
      const toPorts = NODE_PORTS[toType as NodeType]?.inputs ?? []
      let chosen: { fromPort: string; toPort: string } | null = null
      for (const fromPort of fromPorts) {
        for (const toPort of toPorts) {
          if (toPort.external) continue
          if (sourceIsOrigin && fromPort.name !== origin.handleId) continue
          if (!sourceIsOrigin && toPort.name !== origin.handleId) continue
          if (validateConnection({ fromType: fromType as NodeType, fromPort: fromPort.name, toType: toType as NodeType, toPort: toPort.name }).ok) {
            chosen = { fromPort: fromPort.name, toPort: toPort.name }
            break
          }
        }
        if (chosen) break
      }
      if (!chosen) {
        notify('新节点已建好，但端口不匹配，无法自动连线')
        return
      }

      const fromNodeId = sourceIsOrigin ? origin.nodeId : created.id
      const toNodeId = sourceIsOrigin ? created.id : origin.nodeId
      const response = await fetch(`${apiBaseUrl}/v1/canvases/${canvasId}/edges`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ fromNodeId, toNodeId, fromPort: chosen.fromPort, toPort: chosen.toPort }),
      })
      const payload = (await response.json().catch(() => null)) as { id?: string; error?: { message?: string } } | null
      if (!response.ok) {
        notify(`已建节点，连线被拒：${payload?.error?.message ?? response.status}`)
        return
      }
      setEdges((currentEdges) =>
        addEdge({ id: String(payload?.id), source: fromNodeId, target: toNodeId, sourceHandle: chosen!.fromPort, targetHandle: chosen!.toPort }, currentEdges),
      )
      notify(`已建 ${nodeLabel(type)} 并自动连线`)
    },
    [apiBaseUrl, canvasId, createNode, headers, nodes, notify, search, setEdges, token],
  )

  // 把回调注入到每个节点的 data 里（ReactFlow 的 data 是数据，不是 props）
  const nodesWithHandlers = useMemo(
    () =>
      nodes.map((node) => {
        // 拖线中的高亮态：
        //   'origin'   起点自己 —— 不加亮，免得和"能接的"混淆
        //   'compatible' 能接上 —— 亮起（ComfyUI 的关键反馈）
        //   'incompatible' 接不上 —— 压暗，告诉用户别往这儿松手
        let connectHighlight: 'origin' | 'compatible' | 'incompatible' | null = null
        /**
         * 端口级状态：端口名 → 'ok'（能接）| 'no'（接不上）。
         *
         * 只标"要连的那一侧"：从输出口拖出时，只看各节点的输入口；
         * 从输入口拖出时，只看输出口。另一侧的端口保持原样，避免一屏全是花花绿绿。
         */
        let portState: Record<string, 'ok' | 'no'> | null = null

        if (connectDraft) {
          if (node.id === connectDraft.originNodeId) {
            connectHighlight = 'origin'
            // 起点自己的那根端口标成 ok：让用户看清"我是从这根拉出来的"
            portState = { [connectDraft.originHandleId]: 'ok' }
          } else {
            const isCompatible = connectDraft.allowed.has(node.data.nodeType as NodeType)
            connectHighlight = isCompatible ? 'compatible' : 'incompatible'

            // 即使整节点接不上，也要把它的端口逐个标出来 ——
            // 用户需要看到"是这根口不行"，而不是只有一个整体变暗的方块。
            const matched = connectDraft.portsByType.get(node.data.nodeType as NodeType) ?? []
            const ports = connectDraft.originHandleType === 'source' ? node.data.inputs : node.data.outputs
            portState = {}
            for (const port of ports as SgNodeData['inputs']) {
              if (port.external) continue
              portState[port.name] = matched.includes(port.name) ? 'ok' : 'no'
            }
          }
        }

        return {
          ...node,
          data: {
            ...node.data,
            onRun: runNode,
            onDelete: deleteNode,
            onOpenPrompt: openPrompt,
            onGateDecision: decideGateNode,
            connectHighlight,
            portState,
          },
        }
      }),
    [nodes, runNode, deleteNode, openPrompt, decideGateNode, connectDraft],
  )

  // ── 连线 ────────────────────────────────────────────────────────────────
  const onConnect = useCallback(
    async (connection: Connection) => {
      const response = await fetch(`${apiBaseUrl}/v1/canvases/${canvasId}/edges`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ fromNodeId: connection.source, toNodeId: connection.target, fromPort: connection.sourceHandle ?? undefined, toPort: connection.targetHandle ?? undefined }),
      })
      const payload = (await response.json().catch(() => null)) as { id?: string; error?: { message?: string; code?: string } } | null
      if (!response.ok) {
        notify(`连线被拒：${payload?.error?.message ?? response.status}`)
        return
      }
      setEdges((current) =>
        addEdge({ id: String(payload?.id), source: connection.source, target: connection.target, sourceHandle: connection.sourceHandle ?? undefined, targetHandle: connection.targetHandle ?? undefined }, current),
      )
    },
    [apiBaseUrl, canvasId, notify, setEdges, token],
  )

  // ── 分组 ────────────────────────────────────────────────────────────────
  const packGroup = useCallback(async () => {
    const selected = nodes.filter((node) => node.selected)
    if (selected.length < 2) {
      notify('先在画布上框选至少两个节点')
      return
    }
    const title = window.prompt('给这个上下文组起个名字', '上下文组')
    if (title === null) return
    const response = await fetch(`${apiBaseUrl}/v1/canvases/${canvasId}/groups`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title, nodeIds: selected.map((node) => node.id), posX: Math.max(...selected.map((node) => node.position.x)), posY: Math.min(...selected.map((node) => node.position.y)) - 60 }),
    })
    if (!response.ok) {
      notify('打包失败')
      return
    }
    const group = (await response.json()) as { id: string; title: string; posX: number; posY: number; color: string }
    setGroups((current) => [...current, { ...group, memberIds: selected.map((node) => node.id), usedBy: [] }])
    notify(`已打包 ${selected.length} 个节点：${group.title}`)
  }, [apiBaseUrl, canvasId, nodes, notify, token])

  const moveGroup = useCallback(
    async (group: WorkbenchGroup, x: number, y: number) => {
      setGroups((current) => current.map((entry) => (entry.id === group.id ? { ...entry, posX: x, posY: y } : entry)))
    },
    [],
  )

  const unpackGroup = useCallback(
    async (groupId: string) => {
      const response = await fetch(`${apiBaseUrl}/v1/groups/${groupId}`, { method: 'DELETE', headers })
      if (response.ok || response.status === 204) setGroups((current) => current.filter((group) => group.id !== groupId))
    },
    [apiBaseUrl, token],
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 66px)' }}>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Sidebar
          skills={skills}
          onDragSkill={() => {}}
          onDragNode={() => {}}
          onAddNode={(type) => {
            const viewport = getViewport()
            void createNode(type, (600 - viewport.x) / viewport.zoom, (300 - viewport.y) / viewport.zoom)
          }}
        />

        <div style={{ flex: 1, position: 'relative' }} ref={wrapper}>
          <ReactFlow
            nodes={nodesWithHandlers}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            /**
             * 端口拖到空白处松手 → 列出能接上的节点（ComfyUI 的另一核心效率来源）。
             *
             * onConnectEnd 的第二个参数带 `toNode`：为 null 说明松手在空白处。
             */
            onConnectStart={(_event, params) => {
              if (!params.nodeId || !params.handleId) return
              const origin = {
                nodeId: params.nodeId,
                handleId: params.handleId,
                handleType: (params.handleType === 'target' ? 'target' : 'source') as 'target' | 'source',
              }
              connecting.current = origin
              // 一起算好"哪些节点、哪根端口能接"，拖的过程中实时高亮
              const plan = allowedForPort(origin)
              setConnectDraft({
                originNodeId: origin.nodeId,
                originHandleId: origin.handleId,
                originHandleType: origin.handleType,
                allowed: plan.allowed,
                portsByType: plan.portsByType,
              })
            }}
            onConnectEnd={(event, state) => {
              const origin = connecting.current
              connecting.current = null
              // 无论松手在哪，高亮都要撤掉（连上了、取消了都一样）
              setConnectDraft(null)
              if (!origin) return
              // 连到节点上了 → onConnect 已经处理，这里不管
              if (state?.toNode) return

              const native = event as unknown as MouseEvent
              const { allowed, reason } = allowedForPort(origin)
              if (allowed.size === 0) {
                notify('没有能接上这个端口的节点类型')
                return
              }
              const flow = screenToFlowPosition({ x: native.clientX, y: native.clientY })
              setSearch({ x: native.clientX, y: native.clientY, flowX: flow.x, flowY: flow.y, origin, allowed, reason })
            }}
            fitView
            minZoom={0.25}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            onNodeDragStop={async (_event, node) => {
              await fetch(`${apiBaseUrl}/v1/nodes/${node.id}`, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ posX: Math.round(node.position.x), posY: Math.round(node.position.y) }),
              })
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault()
              const native = event as unknown as MouseEvent
              const flow = screenToFlowPosition({ x: native.clientX, y: native.clientY })
              setMenu({ x: native.clientX, y: native.clientY, nodeId: null, flowX: flow.x, flowY: flow.y })
            }}
            onNodeContextMenu={(event, node) => {
              event.preventDefault()
              const native = event as unknown as MouseEvent
              setMenu({ x: native.clientX, y: native.clientY, nodeId: node.id, flowX: node.position.x, flowY: node.position.y })
            }}
            onDrop={async (event) => {
              event.preventDefault()
              const type = event.dataTransfer.getData('application/studygraph-node') as NodeType
              const skillId = event.dataTransfer.getData('application/studygraph-skill')
              if (skillId) {
                // 技能拖到画布空白处：提示用户拖到节点上
                notify('把技能拖到某个节点上才能绑定')
                return
              }
              if (!type) return
              const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
              await createNode(type, position.x, position.y)
            }}
            onDragOver={(event) => event.preventDefault()}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#e2e8f0" />
            <MiniMap
              pannable
              zoomable
              style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8 }}
              nodeColor={(node) => nodeColor(String(node.data?.nodeType ?? ''))}
            />
          </ReactFlow>

          {/* 分组卡片：浮在画布上，可折叠 */}
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            {groups.map((group) => {
              const isCollapsed = collapsed.has(group.id)
              const members = nodes.filter((node) => group.memberIds.includes(node.id))
              return (
                <div
                  key={group.id}
                  data-testid={`group-card-${group.id}`}
                  style={{
                    position: 'absolute',
                    left: group.posX,
                    top: group.posY,
                    width: isCollapsed ? 208 : Math.max(240, members.length * 70),
                    pointerEvents: 'auto',
                    background: isCollapsed ? `${group.color}14` : 'transparent',
                    border: `1.5px dashed ${group.color}`,
                    borderRadius: 10,
                    padding: isCollapsed ? 10 : 6,
                    fontFamily: 'inherit',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: group.color, fontWeight: 600 }}>
                    <button
                      type="button"
                      data-testid={`toggle-group-${group.id}`}
                      onClick={() => {
                        const next = new Set(collapsed)
                        if (isCollapsed) next.delete(group.id)
                        else next.add(group.id)
                        setCollapsed(next)
                      }}
                      style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: group.color, fontSize: 11 }}
                    >
                      {isCollapsed ? '▸' : '▾'}
                    </button>
                    {group.title}
                    <span style={{ color: '#94a3b8', fontWeight: 400 }}>{group.memberIds.length} 个节点</span>
                    <button
                      type="button"
                      onClick={() => void unpackGroup(group.id)}
                      title="解组（不删除节点）"
                      style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 11 }}
                    >
                      解组
                    </button>
                  </div>
                  {isCollapsed && (
                    <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>
                      作为上下文：{members.length} 个节点的产物
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {toast && (
            <div
              data-testid="canvas-toast"
              style={{ position: 'absolute', left: '50%', bottom: 16, transform: 'translateX(-50%)', background: '#0f172a', color: '#fff', padding: '7px 14px', borderRadius: 8, fontSize: 12, opacity: 0.94 }}
            >
              {toast}
            </div>
          )}

          {nodes.length === 0 && (
            <div
              data-testid="empty-canvas-hint"
              style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', color: '#94a3b8', gap: 6 }}
            >
              <div style={{ fontSize: 15, color: '#64748b' }}>空白画布</div>
              <div style={{ fontSize: 12 }}>在空白处右键新建节点，或用下面的 AI 说一句「把课件做成知识卡」</div>
            </div>
          )}
        </div>
      </div>

      {search && (
        <NodeSearch
          x={search.x}
          y={search.y}
          allowed={search.allowed ?? undefined}
          reason={search.reason ?? undefined}
          onPick={(type) => void pickFromSearch(type)}
          onClose={() => setSearch(null)}
        />
      )}

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onCreateNode={(type, x, y) => void createNode(type, x, y)}
          onRename={(nodeId) => void renameNode(nodeId)}
          onDelete={(nodeId) => void deleteNode(nodeId)}
          onDuplicate={(nodeId) => void duplicateNode(nodeId)}
          onRun={(nodeId) => void runNode(nodeId)}
          selectedCount={nodes.filter((node) => node.selected).length}
          onPackGroup={() => void packGroup()}
        />
      )}

      <AssistantBar
        canvasId={canvasId}
        apiBaseUrl={apiBaseUrl}
        token={token}
        onApplied={() => window.location.reload()}
      />
    </div>
  )
}

export function CanvasWorkbench(props: {
  canvasId: string
  apiBaseUrl: string
  token: string
  initialNodes: WorkbenchNode[]
  initialEdges: WorkbenchEdge[]
  initialGroups: WorkbenchGroup[]
  skills: SkillView[]
  nodeSkills: Record<string, string[]>
}) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  )
}
