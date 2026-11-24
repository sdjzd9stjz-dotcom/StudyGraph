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
  useViewport,
} from '@xyflow/react'
import type { Connection, Edge as FlowEdge, Node as FlowNode } from '@xyflow/react'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { NODE_PORTS, canLinkGroupTo, validateConnection } from '../../../../packages/contracts/src/client'
import type { NodeType } from '../../../../packages/contracts/src/client'
import { ADVANCED_NODES, PRIMARY_NODES, nodeLabel, nodeColor } from '../../lib/canvas-meta'
import { renderLectureHtml } from '../../lib/lecture-html'
import { decideGate } from '../../lib/api'
import { AssistantBar } from './AssistantBar'
import { ContextMenu } from './ContextMenu'
import type { MenuContext } from './ContextMenu'
import { GroupCreateDialog } from './GroupCreateDialog'
import { SgGroupNode } from './SgGroupNode'
import type { SgGroupData } from './SgGroupNode'
import { SgNode } from './SgNode'
import type { SgNodeData } from './SgNode'
import { NodeChat } from './NodeChat'
import { NodeSearch } from './NodeSearch'
import { Sidebar } from './Sidebar'
import type { SkillView } from './Sidebar'
import { buildFrames, frameSize, restoreTargets, stackTargets } from '../../lib/group-motion'
import { orderByDependency } from '../../lib/run-order'
import { selectionForContextMenu, toggleSelection } from '../../lib/selection'
import { usePrompt } from '../ui/PromptDialog'

const nodeTypes = { sg: SgNode, sgGroup: SgGroupNode }

/**
 * 组的节点 id 前缀。
 *
 * 组不是数据库里的 Node，但必须参与画布的缩放/拖动/连线 ——
 * 所以给它一个合成 id 放进同一个 nodes 数组，靠前缀区分。
 * 凡是把 id 发回 /v1/nodes/<id> 的地方都要先判断它是不是组（否则会 404）。
 */
const GROUP_ID_PREFIX = '__group__'
const isGroupNodeId = (id: string): boolean => id.startsWith(GROUP_ID_PREFIX)
const groupNodeId = (groupId: string): string => GROUP_ID_PREFIX + groupId

export interface WorkbenchNode {
  id: string
  type: string
  title: string | null
  status: string
  posX: number
  posY: number
  /** 只有 GATE 用到（approved / note），其余类型忽略 */
  params?: Record<string, unknown> | null
  /** 最近一次运行产物的可读文本（服务端生成）；null = 还没跑过 */
  outputText?: string | null
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
  /** 收起状态存在库里：否则重进画布会全部弹开 */
  collapsed?: boolean
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
    // 产物的可读文本：画布看起来要像"知识地图"，节点上得有内容而不只是类型名
    outputSummary: node.outputText ?? null,
    inputs: ports.inputs.map((port) => ({ name: port.name, type: port.type, external: port.external === true })),
    outputs: ports.outputs.map((port) => ({ name: port.name, type: port.type, external: port.external === true })),
    // 参数要在节点上可编辑：题型识别、变式这些节点处理的是具体某道题，
    // 原文没法从上游拿到，界面不给填就是死的
    params: node.params ?? null,
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
  /** 最新节点数组：capture 阶段的事件回调里读不到当前的 `nodes`，只能走 ref */
  const nodesRef = useRef(nodes)
  // 每次渲染更新：事件回调是 native listener，闭包里的 nodes 会是旧的
  nodesRef.current = nodes

  /**
   * 把服务端新出现的节点并进画布。
   *
   * 为什么需要：`useNodesState` 只在挂载时取一次初值。上传课件后调 `router.refresh()`，
   * props 变了、库里也真建好了 SOURCE 节点，但画布上的 `nodes` 是本地 state，不会跟着变 ——
   * 用户看到"已上传"却一张节点都没有，会以为上传失败了（实际遇到）。
   *
   * 只做**追加**，不整体替换：替换会把用户正在拖拽的位置、本地删掉的节点一起冲掉。
   */
  useEffect(() => {
    const incoming = initialNodes.map((node) => toFlowNode(node, skillsByNode))
    setNodes((current) => {
      const byId = new Map(incoming.map((node) => [node.id, node]))

      // 已存在的节点：只同步服务端字段（状态、产出摘要、标题、参数），保留本地位置与选中态。
      // 以前这里只追加不更新 —— 运行完节点后卡片上还是旧摘要，必须手动刷新页面（真实踩过）。
      const merged = current.map((node) => {
        const fresh = byId.get(node.id)
        if (!fresh) return node
        const data = node.data as SgNodeData
        const updated = fresh.data as SgNodeData
        const same =
          data.status === updated.status &&
          data.outputSummary === updated.outputSummary &&
          data.title === updated.title &&
          data.skills === updated.skills
        return same
          ? node
          : {
              ...node,
              data: {
                ...node.data,
                status: updated.status,
                outputSummary: updated.outputSummary,
                title: updated.title,
                skills: updated.skills,
                inputs: updated.inputs,
                outputs: updated.outputs,
              },
            }
      })

      const known = new Set(current.map((node) => node.id))
      const added = incoming.filter((node) => !known.has(node.id))
      const changed = added.length > 0 || merged.some((node, index) => node !== current[index])
      return changed ? [...merged, ...added] : current
    })
  }, [initialNodes, skillsByNode, setNodes])
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(
    initialEdges.map((edge) => ({ id: edge.id, source: edge.fromNodeId, target: edge.toNodeId, sourceHandle: edge.fromPort, targetHandle: edge.toPort })),
  )
  /**
   * 连线也要跟着服务端更新。
   *
   * 和 nodes 同理：`useEdgesState` 只取一次初值。服务端新建的连线（比如「按概念拆分」
   * 自动把抽取节点连到每张卡）在 router.refresh() 后只出现在 props 里，
   * 不同步的话用户会看到新卡是孤立的、没有线。
   * 只追加服务端有、本地没有的；本地刚画上但还没回包的连线保留。
   */
  useEffect(() => {
    const incoming = initialEdges.map((edge) => ({
      id: edge.id,
      source: edge.fromNodeId,
      target: edge.toNodeId,
      sourceHandle: edge.fromPort,
      targetHandle: edge.toPort,
    }))
    setEdges((current) => {
      const known = new Set(current.map((edge) => edge.id))
      const added = incoming.filter((edge) => !known.has(edge.id))
      return added.length > 0 ? [...current, ...added] : current
    })
  }, [initialEdges, setEdges])
  const [groups, setGroups] = useState<(WorkbenchGroup & { measured?: FlowNode['measured'] })[]>(initialGroups)
  const [menu, setMenu] = useState<MenuContext | null>(null)
  /** 当前打开对话的节点（每个节点自己就是一个会话） */
  const [chatTarget, setChatTarget] = useState<{ id: string; title: string; type: string } | null>(null)
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
    /** 拖线起点的节点类型（组节点为 null）：组节点据此判断自己能不能被接上 */
    fromType: NodeType | null
  } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  /** 重命名 / 起名 / 拒绝理由：Electron 没有 window.prompt，统一用应用内弹窗 */
  const { prompt, confirm, dialog } = usePrompt()
  /**
   * 收起的打包组（用户 2026-11-23 要求：点「展开」按节点铺开，收起时看不到内部）。
   *
   * 收起组内成员**真的从画布上隐藏**，而不是只画一个框：
   * 之前收起只是把框画窄，里面的节点还露在外面，看起来像"框和内容对不上"。
   */
  /**
   * 收起状态从**服务端**初始化（用户报「重进画布打包组自动解包/虚线框消失」）。
   * 之前是空集合，每次进画布全部当展开；现在的真值在 NodeGroup.collapsed。
   */
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(initialGroups.filter((group) => group.collapsed).map((group) => group.id)),
  )
  /** 分组右键菜单位置（组没有节点 id，单独一份状态） */
  const [groupMenu, setGroupMenu] = useState<{ groupId: string; x: number; y: number } | null>(null)
  /**
   * 正在播放收起/展开动画的组。
   *
   * 收起是"瞬间隐藏节点"，直接切会显得很突兀、也看不出发生了什么。
   * 这里让框先缩到最小、同时淡出，动画结束后才真正隐藏成员 ——
   * duration 必须和 style 里的 transition 一致，否则会出现"卡一下再跳"。
   */
  const [animating, setAnimating] = useState<{ groupId: string; to: 'collapsed' | 'expanded' } | null>(null)
  /**
   * 建组对话框的草稿。
   *
   * 存"选中的 id"和"组外相连的 id"：用户在对话框里勾选是否纳入时，
   * 不需要重新算一遍连线（画布在弹窗期间还可能变化）。
   */
  const [packDraft, setPackDraft] = useState<{
    ids: string[]
    outside: string[]
    outsideNames: string[]
  } | null>(null)
  /**
   * toggleGroup 的引用。
   *
   * groupNodes 在这之前定义，而 toggleGroup 依赖 nodes/setNodes，只能定义在后面。
   * 用 ref 转一层。**必须先声明再使用**：memo 的函数体在首次渲染时就会读这个
   * 绑定，声明放在后面会触发 TDZ（Cannot access before initialization），
   * 整个画布组件直接崩掉 —— 表现就是"点打包什么也没发生"。
   */
  const toggleGroupRef = useRef<(group: WorkbenchGroup) => void>(() => {})

  const groupNodes = useMemo<FlowNode[]>(
    () =>
      groups.map((group) => {
        /**
         * 锚点：`posX/posY` 是**折叠卡片所在的绝对位置**，也是展开后虚线框的左上角。
         *
         * 两种形态锚在同一点，开合时框不会跳到别处（用户 2026-11-24 明确要求）。
         * 展开尺寸由成员相对这个锚点的偏移算出来 —— 所以成员挪动/增减，框会跟着变。
         */
        const anchor = { x: group.posX, y: group.posY }
        const memberPoints = nodes
          .filter((node) => group.memberIds.includes(node.id))
          .map((node) => ({ x: node.position.x - anchor.x, y: node.position.y - anchor.y }))
        const size = frameSize(memberPoints)

        const isCollapsed = collapsed.has(group.id)

        return {
          id: groupNodeId(group.id),
          type: 'sgGroup',
          /**
           * 显式给宽高（用户报「重进画布虚线框消失」）。
           *
           * React Flow 渲染节点时判定 `measured.width ? visible : hidden`，
           * 而 `measured` 要等它测量完才回填。首帧没有宽度 → 直接 hidden；
           * 组节点又是从 groups 派生的，若测量结果没写回，就一直是 hidden。
           * 这里直接给出尺寸（收起卡片 208 宽、展开按成员包围盒），
           * 首帧就有宽度，不再依赖"测量回来"这个时序。
           */
          width: isCollapsed ? 208 : size.width,
          height: isCollapsed ? 64 : size.height,
          style: isCollapsed ? undefined : { pointerEvents: 'none' },
          position: anchor,
          draggable: true,
          selectable: true,
          data: {
            groupId: group.id,
            title: group.title,
            color: group.color,
            memberCount: group.memberIds.length,
            collapsed: collapsed.has(group.id),
            usedBy: group.usedBy.length,
            frameWidth: size.width,
            frameHeight: size.height,
            onToggle: (groupId: string) => {
              const target = groups.find((item) => item.id === groupId)
              if (target) toggleGroupRef.current(target)
            },
            onOpenMenu: (groupId: string, clientX: number, clientY: number) => {
              setGroupMenu({ groupId, x: clientX, y: clientY })
            },
            /**
             * 拖线高亮（用户 2026-11-24：「同时更新一下高亮的显示」）。
             *
             * 之前只有普通节点参与高亮，组节点在拖线时毫无反应 ——
             * 从组拖出来时看不出哪些节点能接，从节点拖出来时也看不出组能不能当上游。
             */
            connectHighlight: (() => {
              if (!connectDraft) return null
              if (connectDraft.originNodeId === groupNodeId(group.id)) return 'origin'
              // 组的唯一用途是当上游给别人喂上下文：只有"往组里拖"才可能接上
              return connectDraft.originHandleType === 'target' &&
                canLinkGroupTo(connectDraft.fromType ?? '')
                ? 'compatible'
                : 'incompatible'
            })(),
          } satisfies SgGroupData,
        }
      }),
    [groups, collapsed, nodes, connectDraft],
  )
  /**
   * 收起前每个成员的位置。
   *
   * 用户明确要求：「展开要回到收起前的相对位置，而不是聚在一起」。
   * 收起时把坐标存下来，展开时按它还原；刷新过页面就没有快照，退回网格排布。
   */
  const memberOrigins = useRef<Map<string, Record<string, { x: number; y: number }>>>(new Map())
  /**
   * toggleGroup 的引用。
   *
   * groupNodes 是本组件里靠前定义的 useMemo，而 toggleGroup 依赖 nodes/setNodes，
   * 只能定义在后面。用 ref 转一层，避免把两段逻辑互相牵扯（也避免循环依赖）。
   */
  const hiddenNodeIds = useMemo(() => {
    const ids = new Set<string>()
    for (const group of groups) {
      if (!collapsed.has(group.id)) continue
      for (const memberId of group.memberIds) ids.add(memberId)
    }
    return ids
  }, [groups, collapsed])
  const wrapper = useRef<HTMLDivElement>(null)
  /**
   * 右键拖动画布时不要弹右键菜单。
   *
   * 用户 2026-11-23 要求：左键选择/框选/移动节点，**右键拖动画布**。
   * 但浏览器在右键松开时会照常派发 contextmenu —— 拖了半个屏幕再弹菜单很烦。
   * 所以记下右键按下的位置，松手时若已经移出几像素，就当"平移"处理，不弹菜单。
   */
  const rightDown = useRef<{ x: number; y: number; selectedIds: string[] } | null>(null)
  /**
   * Shift+左键按下那一刻的选中快照。
   *
   * 为什么要存整份而不是只存"被点的那个"：
   * 库在 click 里会先 `addSelectedNodes([node])`，把**其它节点的选中全部清掉**，
   * 然后才调用我们的 onNodeClick。只翻转被点的节点，"其它已选中的"已经没了 ——
   * 结果就是 Shift 点第二个节点时第一个反而被取消（用户报的"Shift+左键无法增选"）。
   */
  const shiftDown = useRef<{ nodeId: string; selectedIds: string[] } | null>(null)
  const RIGHT_DRAG_THRESHOLD = 4
  const { screenToFlowPosition, getViewport } = useReactFlow()
  /**
   * 分组框要跟着画布缩放/平移走。
   *
   * 分组框是叠在 ReactFlow 之上的普通 DOM（因为它要可点击、要能超出节点层），
   * 不订阅视口的话，用户一缩放，框就和节点错位。
   * 用 useViewport 而不是监听 onMove：前者是订阅，拖动时自动重渲，不会漏帧。
   */
  const viewport = useViewport()

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
  const router = useRouter()

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
    /**
     * 记右键按下的位置（捕获阶段）：右键拖动平移结束后要判断"这是拖了还是单击"。
     * 用 pointerdown 而不是 contextmenu：前者在按下那一刻就有坐标，
     * 后者到松手才来，那时已经没法还原起点。
     */
    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 2) {
        /**
         * 按下右键的这一刻就把选中项记下来。
         *
         * 库在右键时会重写选中态（点中的节点变成唯一选中），
         * 等 contextmenu 事件到的时候已经是"只选了 1 个" ——
         * 这就是"框选 4 个之后右键没有打包项"的原因。
         */
        rightDown.current = {
          x: event.clientX,
          y: event.clientY,
          selectedIds: nodesRef.current.filter((node) => node.selected).map((node) => node.id),
        }
      }
      /**
       * Shift+左键：记下**点击之前**的选中状态。
       *
       * 库在 pointerdown 之后就会把点中的节点设为选中（并把别的清掉），
       * 等 click 事件再来取反，读到的已经是"它被选中了"，于是永远变成取消选中。
       * 判定要用按下那一刻的状态。
       */
      if (event.button === 0 && event.shiftKey) {
        const target = (event.target as HTMLElement | null)?.closest?.('.react-flow__node') as HTMLElement | null
        const nodeId = target?.dataset?.id ?? null
        shiftDown.current = nodeId
          ? { nodeId, selectedIds: nodesRef.current.filter((item) => item.selected).map((item) => item.id) }
          : null
      }
    }
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
    element.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      element.removeEventListener('dblclick', handler, true)
      element.removeEventListener('pointerdown', onPointerDown, true)
    }
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

  /**
   * 按概念拆分知识卡（用户 2026-11-23：「加上右键入口」）。
   *
   * 一个概念一个节点。以前只能通过对话或接口触发，界面上没有入口，
   * 用户只能手工建卡 —— 而手工建的卡没有 conceptName，每张都产出全部概念。
   * 拆完后重新拉一次画布，新节点才能带着连线和位置回来。
   */
  const splitCards = useCallback(
    async (nodeId: string) => {
      const response = await fetch(`${apiBaseUrl}/v1/nodes/${nodeId}/split-cards`, { method: 'POST', headers })
      const payload = (await response.json().catch(() => null)) as
        | { created?: Array<unknown>; skipped?: Array<{ name: string; reason: string }>; error?: { message?: string } }
        | null
      if (!response.ok) {
        notify(payload?.error?.message ?? `拆分失败：${response.status}`)
        return
      }
      const created = payload?.created?.length ?? 0
      const skipped = payload?.skipped ?? []
      if (created === 0) {
        // 全被跳过要说清楚原因，否则用户以为按钮坏了
        const reason = skipped[0] ? `（${skipped[0].name}：${skipped[0].reason}）` : ''
        notify(`没有新建知识卡${reason}`)
        return
      }
      notify(`已拆出 ${created} 张知识卡${skipped.length > 0 ? `，跳过 ${skipped.length} 个概念` : ''}`)
      // 新节点与新连线由服务端返回的 props 带回来（见上方同步 effect）
      router.refresh()
    },
    [apiBaseUrl, headers, notify, router, token],
  )

  const renameNode = useCallback(
    async (nodeId: string) => {
      const current = nodes.find((node) => node.id === nodeId)
      const title = await prompt({
        title: '重命名节点',
        defaultValue: String(current?.data.title ?? ''),
        okText: '保存',
      })
      if (title === null) return
      await fetch(`${apiBaseUrl}/v1/nodes/${nodeId}`, { method: 'PATCH', headers, body: JSON.stringify({ title }) })
      setNodes((existing) => existing.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, title } } : node)))
    },
    [apiBaseUrl, nodes, prompt, setNodes, token],
  )

  const runNode = useCallback(
    async (nodeId: string) => {
      setNodes((current) => current.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, running: true } } : node)))
      try {
        const response = await fetch(`${apiBaseUrl}/v1/nodes/${nodeId}/run`, { method: 'POST', headers })
        const body = (await response.json().catch(() => null)) as { status?: string; error?: { message?: string; code?: string } } | null
        if (!response.ok) {
          /**
           * 404 = 画布上的这张卡在库里已经没有了（别的窗口删掉了、或克隆/导入留下的残留）。
           * 直接把这张幽灵卡从画布上移除并说明原因 —— 只弹"节点不存在"会让用户
           * 对着一个删不掉、点不动的方块反复点（真实反馈）。
           */
          if (body?.error?.code === 'NODE_NOT_FOUND' || response.status === 404) {
            setNodes((current) => current.filter((node) => node.id !== nodeId))
            setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId))
            notify('这个节点在数据库里已经不存在，已从画布上移除')
            return
          }
          notify(body?.error?.message ?? `执行失败：${response.status}`)
        } else {
          notify(`执行${body?.status === 'SUCCEEDED' ? '成功' : `：${body?.status}`}`)
          setNodes((current) => current.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, status: body?.status ?? 'READY' } } : node)))
          // 产物变了，卡片上那段摘要也要跟着变 —— 否则学生要手动刷新才看得到运行结果
          router.refresh()
        }
      } finally {
        setNodes((current) => current.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, running: false } } : node)))
      }
    },
    [apiBaseUrl, notify, setEdges, setNodes, token],
  )

  /**
   * 按依赖顺序运行选中的节点（用户 2026-11-24 要求）。
   *
   * **串行**跑，不并发：下游要读上游刚产出的产物，并发就拿到旧的。
   * 顺序由 orderByDependency 决定（上游在前）；有环时环上的节点仍会跑，
   * 但要提示一句，否则用户会以为顺序错了。
   * 中途某个节点失败就停下 —— 后面的都是它的下游，接着跑只会连环失败。
   */
  const runSelectedInOrder = useCallback(
    async (ids: string[]) => {
      const edgePairs = edges.map((edge) => ({ source: edge.source, target: edge.target }))
      const { ordered, cyclic } = orderByDependency(ids, edgePairs)
      if (ordered.length === 0) return

      if (cyclic.length > 0) {
        notify(`${cyclic.length} 个节点互相依赖，会按选中顺序排在最后`)
      }

      for (const nodeId of ordered) {
        const response = await fetch(`${apiBaseUrl}/v1/nodes/${nodeId}/run`, { method: 'POST', headers })
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
          notify(`在「${String(nodes.find((node) => node.id === nodeId)?.data?.title ?? nodeId)}」处停下：${body?.error?.message ?? response.status}`)
          router.refresh()
          return
        }
      }
      notify(`已按依赖顺序运行 ${ordered.length} 个节点`)
      router.refresh()
    },
    [apiBaseUrl, edges, headers, nodes, notify, router, token],
  )

  /** 批量删除选中的节点：删前确认，逐个走接口（服务端会连带删连线） */
  const deleteSelected = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return
      const ok = await confirm({
        title: '删除节点',
        message: `删除选中的 ${ids.length} 个节点？\n\n连在它们上面的线会一起消失，无法恢复。`,
        okText: '删除',
        danger: true,
      })
      if (!ok) return
      for (const nodeId of ids) await deleteNode(nodeId)
      notify(`已删除 ${ids.length} 个节点`)
    },
    [confirm, deleteNode, notify],
  )

  /**
   * 保存节点参数。
   *
   * 用 PATCH 而不是单独的 params 接口：`PATCH /v1/nodes/:id` 本来就接受 params，
   * 客户端再包一层只会多一处需要保持一致的地方。
   *
   * 保存后**不自动运行**（硬约束 2）：改参数会改变指纹，节点会失效，
   * 但什么时候花这笔钱由学生决定。
   */
  const saveNodeParams = useCallback(
    async (nodeId: string, params: Record<string, unknown>) => {
      const response = await fetch(`${apiBaseUrl}/v1/nodes/${nodeId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ params }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
        notify(body?.error?.message ?? `保存失败：HTTP ${response.status}`)
        return
      }
      setNodes((current) =>
        current.map((node) =>
          node.id === nodeId
            ? { ...node, data: { ...node.data, params, status: 'DRAFT' } }
            : node,
        ),
      )
      notify('参数已保存，需要点 ▶ 重新运行才生效')
    },
    [apiBaseUrl, headers, notify, setNodes],
  )

  /**
   * 一键整理：服务端算好分层坐标，本地直接套用（不等整页刷新，点完就动）。
   *
   * 只改位置：不建不删、不连线、不执行，也不改任何节点状态。
   */
  const arrangeNodes = useCallback(async () => {
    const response = await fetch(`${apiBaseUrl}/v1/canvases/${canvasId}/layout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = (await response.json().catch(() => null)) as
      | { moved?: number; positions?: Record<string, { x: number; y: number }>; error?: { message?: string } }
      | null
    if (!response.ok) {
      notify(body?.error?.message ?? `整理失败：HTTP ${response.status}`)
      return
    }
    const positions = body?.positions ?? {}
    setNodes((current) =>
      current.map((node) => {
        const pos = positions[node.id]
        return pos ? { ...node, position: { x: pos.x, y: pos.y } } : node
      }),
    )
    notify(`已整理 ${body?.moved ?? Object.keys(positions).length} 个节点`)
  }, [apiBaseUrl, canvasId, notify, setNodes, token])

  /**
   * 导出讲义 PDF。
   *
   * 正文从服务端取（`GET /v1/nodes/:id/lecture`）—— 画布上那段 `outputSummary`
   * 只是给人看的摘要，拿去打印会把讲义变成一张目录。
   * 真正的打印由桌面主进程完成（Chromium 的 printToPDF），浏览器里没有这座桥，
   * 所以这里明确告诉用户"只在桌面版可用"，而不是静默失败。
   */
  const exportLecture = useCallback(
    async (nodeId: string) => {
      const response = await fetch(`${apiBaseUrl}/v1/nodes/${nodeId}/lecture`, {
        headers: { authorization: `Bearer ${token}` },
      })
      const data = (await response.json().catch(() => null)) as
        | { title?: string; markdown?: string; error?: { message?: string } }
        | null
      if (!response.ok) {
        notify(data?.error?.message ?? `还没有讲义（HTTP ${response.status}），先运行这个节点`)
        return
      }

      const html = renderLectureHtml(String(data?.title ?? '课程讲义'), String(data?.markdown ?? ''))
      const bridge = (window as unknown as {
        studygraph?: { savePdf?: (html: string, name: string) => Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }> }
      }).studygraph

      if (!bridge?.savePdf) {
        notify('导出 PDF 需要桌面版客户端（浏览器预览里没有打印桥）')
        return
      }

      const result = await bridge.savePdf(html, String(data?.title ?? '课程讲义'))
      if (!result.ok) {
        if (!result.canceled) notify(`导出失败：${result.error ?? '未知错误'}`)
        return
      }
      notify(`已导出：${result.filePath}`)
    },
    [apiBaseUrl, notify, token],
  )

  /**
   * GATE 放行 / 拒绝。
   *
   * 拒绝时必须问理由：无理由的拒绝，上游不知道要改什么（服务端也会拒）。
   * 这里用统一的输入弹窗（不是 window.prompt：Electron 里它直接返回 null）。
   */
  const decideGateNode = useCallback(
    async (nodeId: string, approved: boolean) => {
      let note: string | undefined
      if (!approved) {
        const input = await prompt({
          title: '拒绝这个闸门',
          description: '理由必填：上游节点据此知道要改什么。',
          placeholder: '例如：第 3 张卡的推导不完整',
          okText: '拒绝',
        })
        if (input === null) return
        note = input
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
    [notify, prompt, setNodes],
  )

  const openPrompt = useCallback(
    async (nodeId: string) => {
      const bound = skillsByNode.get(nodeId) ?? []
      const answer = await prompt({
        title: '绑定技能',
        description: `用逗号分隔技能 slug，留空则解绑。可选：${skills.map((skill) => skill.slug).join(', ')}`,
        defaultValue: bound.join(','),
        allowEmpty: true,
        okText: '保存',
      })
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
    [apiBaseUrl, notify, prompt, setNodes, skills, skillsByNode, token],
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
       * 从**组节点**拖出（用户 2026-11-24：「为组添加可以接到的节点」）。
       *
       * 组不是普通节点：它没有端口类型，连的是 NodeGroupLink。
       * 能接的范围由 contracts 的 GROUP_LINK_TARGETS 决定（复习/深入理解/讲义/先修），
       * 这里只负责把高亮画出来 —— 口径必须与服务端一致，否则会出现
       * "界面亮着能接、松手被 400 拒绝"。
       */
      if (isGroupNodeId(origin.nodeId)) {
        const portsByType = new Map<NodeType, string[]>()
        for (const candidate of [...PRIMARY_NODES, ...ADVANCED_NODES]) {
          if (!canLinkGroupTo(candidate.type)) continue
          allowed.add(candidate.type)
          // 组给的是"一整批节点的摘要"，落到目标节点的第一个非外部输入口上
          const input = (NODE_PORTS[candidate.type]?.inputs ?? []).find((port) => !port.external)
          if (input) portsByType.set(candidate.type, [input.name])
        }
        return { allowed, portsByType, reason: '组可以接：复习 / 深入理解 / 导出讲义 / 先修' }
      }
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

  /** 当前选中的真实节点（排除组节点）：工具条按钮与菜单共用这一份 */
  const selectedNodeIds = useMemo(
    () => nodes.filter((node) => node.selected && !isGroupNodeId(node.id)).map((node) => node.id),
    [nodes],
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
            onSaveParams: saveNodeParams,
            onChat: (nodeId: string) => setChatTarget({ id: nodeId, title: String(node.data.title ?? node.data.label ?? node.data.nodeType), type: String(node.data.nodeType) }),
            onExport: exportLecture,
            connectHighlight,
            portState,
          },
        }
      }),
    [nodes, runNode, deleteNode, openPrompt, decideGateNode, saveNodeParams, exportLecture, connectDraft],
  )

  // ── 连线 ────────────────────────────────────────────────────────────────
  const onConnect = useCallback(
    async (connection: Connection) => {
      /**
       * 从组节点拖出来的线：不建 Edge，而是建 NodeGroupLink。
       * 组不是 Node，Edge 的外键接不上（服务端会 400），
       * 语义上也不同：组给下游的是"全部成员产物的合并上下文"。
       */
      if (isGroupNodeId(connection.source)) {
        const groupId = connection.source.slice(GROUP_ID_PREFIX.length)
        if (isGroupNodeId(connection.target)) {
          notify('组之间不能直接连线')
          return
        }
        await linkGroupTo(groupId, connection.target)
        return
      }
      if (isGroupNodeId(connection.target)) {
        notify('组只能作为上游（从组右侧的点拖到节点上）')
        return
      }
      /**
       * 单入口容错。
       *
       * 有的节点只有一个输入口（如 REVIEW），用户从卡片拖过去时如果端口类型不完全匹配，
       * ReactFlow 仍然会画出这条线，但服务端 400 拒绝 —— 结果是**图上有线、库里没有**，
       * 之后的删除、运行、连线都对着一个不存在的关系操作，看起来就是"节点存在但提示不存在"。
       * 这里不猜类型，只做一件事：单入口节点隐式使用它唯一的那个口，让连线真实落地或明确失败。
       */
      const targetType = nodes.find((node) => node.id === connection.target)?.data?.nodeType as NodeType | undefined
      const targetPorts = targetType ? NODE_PORTS[targetType] : undefined
      const targetHandle =
        connection.targetHandle ??
        (targetPorts && targetPorts.inputs.length === 1 ? targetPorts.inputs[0]!.name : undefined)
      const sourceType = nodes.find((node) => node.id === connection.source)?.data?.nodeType as NodeType | undefined
      const sourcePorts = sourceType ? NODE_PORTS[sourceType] : undefined
      const sourceHandle =
        connection.sourceHandle ??
        (sourcePorts && sourcePorts.outputs.length === 1 ? sourcePorts.outputs[0]!.name : undefined)

      const response = await fetch(`${apiBaseUrl}/v1/canvases/${canvasId}/edges`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ fromNodeId: connection.source, toNodeId: connection.target, fromPort: sourceHandle, toPort: targetHandle }),
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
  /**
   * 打包成上下文组。
   *
   * `ids` 由调用方传入（右键菜单里那份快照），**不再现场读 `node.selected`**：
   * 右键按下时库会改写选中态，等菜单点击时再读就只剩被点中的那一个，
   * 于是"框选 4 个 → 右键 → 打包"永远只有 1 个成员、或者直接不出现打包项。
   */
  /**
   * 打包成组：**只弹一个对话框**，把组名和"是否纳入相连节点"一次问完。
   *
   * 之前是「先 confirm 再 prompt」的两段式：第二次弹窗会覆盖第一次的 Promise，
   * 表现就是点完没反应、建不出组（用户报的「现在无法建组了」）。
   * 现在只要一次确认，没有这段时序问题。
   *
   * ids 由调用方传入（右键菜单里的快照），不现场读 node.selected ——
   * 右键按下时库已经改写过选中态。
   */
  const packGroup = useCallback(
    (ids: string[]) => {
      const idSet = new Set(ids)
      const selected = nodes.filter((node) => idSet.has(node.id))
      if (selected.length < 2) {
        notify('至少要选中两个节点才能打包')
        return
      }

      /**
       * 跨组边检测（用户 2026-11-24 要求）：
       * 组里有节点连到组外时，收起后那条线"看不见但还在"，上下游关系就断了。
       * 这里算出**一整片**相连的外围节点（含传递闭包），在对话框里让用户勾选是否纳入。
       */
      const outside: string[] = []
      {
        const set = new Set(idSet)
        let grew = true
        while (grew) {
          grew = false
          for (const edge of edges) {
            const fromIn = set.has(edge.source)
            const toIn = set.has(edge.target)
            if (fromIn === toIn) continue
            const outsider = fromIn ? edge.target : edge.source
            if (!outsider || set.has(outsider) || isGroupNodeId(outsider)) continue
            set.add(outsider)
            outside.push(outsider)
            grew = true
          }
        }
      }

      const outsideNames = outside.map((id) => String(nodes.find((node) => node.id === id)?.data?.title ?? id))
      // 先确认"点到了、也真的进到打开对话框这一步"：没有这句就无法区分
      // "打包没被触发"和"对话框渲染失败"
      notify(`准备打包 ${selected.length} 个节点`)
      setPackDraft({ ids: [...idSet], outside, outsideNames })
    },
    [edges, nodes, notify],
  )

  /** 对话框确认后真正建组（唯一入口，避免两套逻辑分叉） */
  const createGroup = useCallback(
    async (draft: { ids: string[]; outside: string[] }, input: { title: string; includeOutside: boolean }) => {
      const ids = input.includeOutside ? [...new Set([...draft.ids, ...draft.outside])] : draft.ids
      const members = nodes.filter((node) => ids.includes(node.id))
      if (members.length < 2) {
        notify('至少要两个节点才能成组')
        return
      }
      setPackDraft(null)

      const response = await fetch(`${apiBaseUrl}/v1/canvases/${canvasId}/groups`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: input.title,
          nodeIds: members.map((node) => node.id),
          // 锚点 = 展开框的左上角 = 折叠卡片的位置：取成员的最左/最上，再让出标题条
          posX: Math.round(Math.min(...members.map((node) => node.position.x)) - 20),
          posY: Math.round(Math.min(...members.map((node) => node.position.y)) - 52),
        }),
      })
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
        notify(failure?.error?.message ?? `打包失败：HTTP ${response.status}`)
        return
      }
      const group = (await response.json()) as { id: string; title: string; posX: number; posY: number; color: string }
      // 定位用：服务端已建好，但若界面上看不见，这行能区分"数据没进来"还是"渲染没出来"
      console.info('[pack] group created', group, 'members', members.length)
      setGroups((current) => [...current, { ...group, memberIds: members.map((node) => node.id), usedBy: [] }])
      notify(`已打包 ${members.length} 个节点：${group.title}`)

      // AI 补名字：失败不打扰用户，名字还是刚才填的那个
      fetch(`${apiBaseUrl}/v1/groups/${group.id}/auto-name`, { method: 'POST', headers })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { ok?: boolean; title?: string } | null) => {
          if (!data?.ok || !data.title) return
          setGroups((current) => current.map((item) => (item.id === group.id ? { ...item, title: data.title! } : item)))
          notify(`AI 起名：${data.title}`)
        })
        .catch(() => undefined)
    },
    [apiBaseUrl, canvasId, headers, nodes, notify],
  )

  const moveGroup = useCallback(
    async (group: WorkbenchGroup, x: number, y: number) => {
      setGroups((current) => current.map((entry) => (entry.id === group.id ? { ...entry, posX: x, posY: y } : entry)))
    },
    [],
  )

  const unpackGroup = useCallback(
    async (groupId: string, options?: { skipWarning?: boolean }) => {
      const group = groups.find((item) => item.id === groupId)
      /**
       * 拆组前提醒（用户 2026-11-24 要求）。
       *
       * 组被下游当上下文引用过时，拆组会把这些 NodeGroupLink 一起删掉 ——
       * 结果是下游节点的输入**悄悄少了一大块**，跑出来的内容变少但没有任何报错。
       * 这类"静默丢上下文"最容易被误认为模型变笨了。
       */
      if (!options?.skipWarning && group && group.usedBy.length > 0) {
        const names = group.usedBy
          .slice(0, 4)
          .map((id) => String(nodes.find((node) => node.id === id)?.data?.title ?? id))
          .join('、')
        const ok = await confirm({
          title: '这一组被下游引用了',
          message:
            `${group.usedBy.length} 个节点把这一组当作上下文：${names}${group.usedBy.length > 4 ? ' 等' : ''}。\n\n` +
            '拆组会解除这些"组作为上下文"的关系，下游下次运行时就拿不到这一组的产物了。\n\n' +
            '节点本身都会保留在画布上，不会被删除。',
          okText: '仍然拆组',
          danger: true,
        })
        if (!ok) return
      }

      const response = await fetch(`${apiBaseUrl}/v1/groups/${groupId}`, { method: 'DELETE', headers })
      if (response.ok || response.status === 204) setGroups((current) => current.filter((item) => item.id !== groupId))
    },
    [apiBaseUrl, confirm, groups, nodes, token],
  )

  /**
   * 展开 / 收起一个分组（用户 2026-11-24 要求：左上角要有一个快捷按钮）。
   *
   * 展开时把成员排回组内网格：之前展开后节点还停在各自原来的位置，
   * 一旦被拖远过，框就会拉到半个屏幕 —— 看起来像"框和内容对不上"。
   * 只调整这一组的成员，不碰画布上其它节点。
   */
  const toggleGroup = useCallback(
    (group: WorkbenchGroup) => {
      const isCollapsed = collapsed.has(group.id)
      const memberIds = group.memberIds
      const FRAME_MS = 16
      const FRAME_COUNT = 14 // ≈ 220ms：短到不烦人，长到看得出"它们在往一起收"

      if (!isCollapsed) {
        /**
         * 收起（用户 2026-11-24 要求）。
         *
         * 先把每个成员当前坐标存进 memberOrigins —— 展开要靠它还原，
         * 不存就只能退回网格，"精心摆好的链被重排"是真实抱怨。
         * 然后把所有人一起飞向组的右上角（叠放点），逐帧插值；
         * 动画结束才真正隐藏成员并显示组卡片。
         */
        const from = nodes
          .filter((node) => memberIds.includes(node.id))
          .map((node) => node.position)
        if (from.length === 0) return

        const saved: Record<string, { x: number; y: number }> = {}
        nodes.forEach((node) => {
          if (memberIds.includes(node.id)) saved[node.id] = { x: node.position.x, y: node.position.y }
        })
        memberOrigins.current.set(group.id, saved)

        // 朝左上角收：目标点就是折叠卡片本身所在的绝对位置
        const targets = stackTargets({ x: group.posX, y: group.posY }, from.length)
        const frames = buildFrames(from, targets, FRAME_COUNT)
        setAnimating({ groupId: group.id, to: 'collapsed' })

        let frame = 0
        const step = () => {
          const positions = frames[frame]
          if (!positions) {
            /**
             * 全部成员已经叠到锚点上，这时才隐藏成员、露出折叠卡片
             * （用户 2026-11-24：「按折叠后全部叠一起动画后才出现折叠组」）。
             * 顺序反了会看到卡片早早出现、节点还在往它里面飞。
             */
            setCollapsed((current) => new Set(current).add(group.id))
            // 收起状态存库：重进画布时要保持收起，而不是自己弹开
            void fetch(apiBaseUrl + '/v1/groups/' + group.id, {
              method: 'PATCH',
              headers,
              body: JSON.stringify({ collapsed: true }),
            }).catch(() => undefined)
            /**
             * 尺寸从"虚线框"变成"折叠卡片"，之前记下的 measured 已经不适用。
             * 不清掉的话，画布会继续用旧宽高做连线锚点与包围盒计算，
             * 收起后的卡片会偏到框原来的右边缘去。清空后由画布重新测量。
             */
            setGroups((current) => current.map((item) => (item.id === group.id ? { ...item, measured: undefined } : item)))
            setAnimating(null)
            return
          }
          setNodes((current) => {
            let index = 0
            return current.map((node) => {
              if (!memberIds.includes(node.id)) return node
              const point = positions[index++]
              return point ? { ...node, position: point } : node
            })
          })
          frame += 1
          window.setTimeout(step, FRAME_MS)
        }
        step()
        return
      }

      /**
       * 展开：先让成员出现在堆叠点上（不可见状态），下一帧再飞回各自位置。
       * 这样动画是"从那一叠里散开"，而不是"凭空出现"。
       */
      const saved = memberOrigins.current.get(group.id)
      const restored = restoreTargets(saved, memberIds, { x: group.posX, y: group.posY })
      const restoreById = new Map(restored.map((item) => [item.id, item.point]))

      setCollapsed((current) => {
        const next = new Set(current)
        next.delete(group.id)
        return next
      })
      // 展开同样写库，否则下次进来还是收起的
      void fetch(apiBaseUrl + '/v1/groups/' + group.id, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ collapsed: false }),
      }).catch(() => undefined)
      // 从"折叠卡片"变回"虚线框"：旧的 measured 是卡片尺寸，必须清掉重新测量
      setGroups((current) => current.map((item) => (item.id === group.id ? { ...item, measured: undefined } : item)))
      setAnimating({ groupId: group.id, to: 'expanded' })

      const start = stackTargets({ x: group.posX, y: group.posY }, memberIds.length)
      const targets = memberIds.map((id) => restoreById.get(id) ?? { x: group.posX, y: group.posY })
      const frames = buildFrames(start, targets, FRAME_COUNT)

      setNodes((current) =>
        current.map((node) => {
          const index = memberIds.indexOf(node.id)
          return index < 0 ? node : { ...node, position: start[index] ?? node.position }
        }),
      )

      let frame = 0
      const step = () => {
        const positions = frames[frame]
        if (!positions) {
          setAnimating(null)
          return
        }
        setNodes((current) =>
          current.map((node) => {
            const index = memberIds.indexOf(node.id)
            const point = index < 0 ? undefined : positions[index]
            return point ? { ...node, position: point } : node
          }),
        )
        frame += 1
        window.setTimeout(step, FRAME_MS)
      }
      window.setTimeout(step, FRAME_MS)
    },
    [collapsed, nodes, setNodes],
  )
  // groupNodes 的 data.onToggle 通过 ref 调用它（见 toggleGroupRef 的说明）
  toggleGroupRef.current = toggleGroup

  const renameGroup = useCallback(
    async (group: WorkbenchGroup) => {
      const title = await prompt({
        title: '重命名分组',
        defaultValue: group.title,
        okText: '保存',
      })
      if (title === null) return
      const response = await fetch(`${apiBaseUrl}/v1/groups/${group.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ title }),
      })
      if (!response.ok) {
        notify(`重命名失败：${response.status}`)
        return
      }
      setGroups((current) => current.map((item) => (item.id === group.id ? { ...item, title } : item)))
    },
    [apiBaseUrl, headers, notify, prompt, token],
  )

  /**
   * 删除整组。
   *
   * 和「解组」的区别必须让用户看清：解组只取消分组、节点全留着；
   * 删除组会**连成员节点一起删**。两个动作放在同一个菜单里，
   * 措辞和确认框必须把这点说明白，否则一次误点就丢一堆跑过的产物。
   */
  const deleteGroup = useCallback(
    async (group: WorkbenchGroup) => {
      const linked = group.usedBy.length > 0 ? `\n另有 ${group.usedBy.length} 个节点把这一组当作上下文，这些引用也会一并解除。` : ''
      const ok = await confirm({
        title: '删除分组',
        message: `「${group.title}」里的 ${group.memberIds.length} 个节点会一起删除，无法恢复。${linked}\n\n只想取消分组、保留节点的话，请用「解组」。`,
        okText: '全部删除',
        danger: true,
      })
      if (!ok) return
      for (const nodeId of group.memberIds) await deleteNode(nodeId)
      // 节点已经全删了，再弹"被下游引用"的提醒没有意义
      await unpackGroup(group.id, { skipWarning: true })
      notify(`已删除分组「${group.title}」`)
    },
    [confirm, deleteNode, notify, unpackGroup],
  )

  /**
   * 把分组连到一个下游节点（组的右侧输出点拖过去）。
   *
   * 这条关系写进 NodeGroupLink，而不是普通 Edge：
   * 组不是节点，画布上没有它的端口；执行时由 collectInputs 把
   * 全部成员的产物当作下游的上游上下文（见 execute.ts 的 groupLinks）。
   */
  const linkGroupTo = useCallback(
    async (groupId: string, nodeId: string) => {
      const response = await fetch(`${apiBaseUrl}/v1/groups/${groupId}/link`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ nodeId }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
        notify(body?.error?.message ?? `接不上：${response.status}`)
        return
      }
      setGroups((current) =>
        current.map((group) =>
          group.id === groupId && !group.usedBy.includes(nodeId)
            ? { ...group, usedBy: [...group.usedBy, nodeId] }
            : group,
        ),
      )
      const target = nodes.find((node) => node.id === nodeId)
      notify(`已把分组接到「${String(target?.data?.title ?? nodeId)}」`)
    },
    [apiBaseUrl, headers, nodes, notify, token],
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

        {/*
          overflow: hidden 是必需的：分组虚线框是叠在上层的绝对定位 DOM，
          按屏幕坐标定位。缩放/平移之后框的范围可能超出画布区域，
          裁不掉就会画到底部「AI 配置」「概念卡」两块面板上（用户看到的现象）。
        */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden', minWidth: 0 }} ref={wrapper}>
          {/*
            一键整理：按依赖方向把节点排成左→右。
            浮动在画布左上角 —— 它是"看完图之后想让它更清楚"时才点的动作，
            放进菜单里反而找不到。
          */}
          <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 5, display: 'flex', gap: 6 }}>
            <button
              type="button"
              data-testid="arrange-nodes"
              title="按依赖方向重排节点位置（不改结构、不执行）"
              onClick={() => void arrangeNodes()}
              style={{
                border: '1px solid #cbd5e1',
                background: '#fff',
                color: '#334155',
                borderRadius: 8,
                padding: '6px 12px',
                fontSize: 12,
                cursor: 'pointer',
                boxShadow: '0 1px 3px rgba(15,23,42,0.08)',
              }}
            >
              ▦ 整理
            </button>
            {/*
              打包成组的不依赖右键菜单的入口（用户 2026-11-24 报「点了打包依旧不行」）。
              右键那条路要经过"多选覆盖层 → 快照 → 菜单"三道，任一道出问题都会静默失败；
              工具条按钮直接读当前选中的节点，链路最短，也方便排查。
            */}
            <button
              type="button"
              data-testid="pack-selected"
              title="把选中的节点打包成组（也可以右键 → 打包）"
              disabled={selectedNodeIds.length < 2}
              onClick={() => packGroup(selectedNodeIds)}
              style={{
                border: '1px solid #cbd5e1',
                background: selectedNodeIds.length >= 2 ? '#fff' : '#f8fafc',
                color: selectedNodeIds.length >= 2 ? '#334155' : '#cbd5e1',
                borderRadius: 8,
                padding: '6px 12px',
                fontSize: 12,
                cursor: selectedNodeIds.length >= 2 ? 'pointer' : 'not-allowed',
                boxShadow: '0 1px 3px rgba(15,23,42,0.08)',
              }}
            >
              ▣ 打包{selectedNodeIds.length >= 2 ? ` ${selectedNodeIds.length} 个` : ''}
            </button>
          </div>
          {chatTarget && (
            <NodeChat
              nodeId={chatTarget.id}
              nodeTitle={chatTarget.title}
              nodeType={chatTarget.type}
              apiBaseUrl={apiBaseUrl}
              token={token}
              onClose={() => setChatTarget(null)}
            />
          )}
          <ReactFlow
            nodes={[
              ...nodesWithHandlers.filter((node) => !hiddenNodeIds.has(node.id)),
              ...groupNodes,
            ]}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={(changes) => {
              // 组节点从 groups 派生，尺寸若只写入普通 nodes，下次渲染就会重新变为 hidden。
              const sizes = new Map<string, FlowNode['measured']>()
              for (const change of changes) {
                if (change.type === 'dimensions' && change.dimensions && isGroupNodeId(change.id)) {
                  sizes.set(change.id.slice(GROUP_ID_PREFIX.length), change.dimensions)
                }
              }
              if (sizes.size) {
                setGroups((current) => {
                  let changed = false
                  const next = current.map((group) => {
                    const size = sizes.get(group.id)
                    if (!size) return group
                    // 值没变就别产生新对象：否则 setGroups → 重渲染 → 又触发一次测量，来回打转
                    if (group.measured?.width === size.width && group.measured?.height === size.height) return group
                    changed = true
                    return { ...group, measured: size }
                  })
                  return changed ? next : current
                })
              }
              onNodesChange(changes)
            }}
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
                // 组节点没有普通类型：置 null，由组自己的分支判断
                fromType: isGroupNodeId(origin.nodeId)
                  ? null
                  : ((nodes.find((node) => node.id === origin.nodeId)?.data?.nodeType ?? null) as NodeType | null),
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
            /**
             * ── 鼠标操作方案（用户 2026-11-23 要求）────────────────────────
             * 左键  ：单击选中 / 空白处拖出选框 / 拖动节点移动
             * Shift+左键：增选（再点一次取消选中）
             * 右键拖动：平移画布（右键单击仍弹菜单）
             * 中键拖动：也可以平移（老习惯，保留）
             * 滚轮  ：缩放
             *
             * 三点说明：
             *  · `panOnDrag={[1, 2]}`：只允许中键(1)、右键(2)平移。默认是左键平移，
             *    那样左键拖空白只会移动画布，永远框选不了。
             *  · `selectionOnDrag`：空白处左键拖动即为框选。
             *  · `selectionKeyCode` 设成 null：框选不需要按住任何修饰键
             *    （默认要按 Shift，那是"平移为主"时代的设定）。
             */
            panOnDrag={[1, 2]}
            selectionOnDrag
            selectionKeyCode={null}
            /**
             * 增选/减选由我们自己接管（见 onNodeClick）。
             *
             * 库的 Shift 实现依赖「按下 Shift 时全局 multiSelectionActive」，
             * 在 Electron 窗口里焦点切换后这个状态会丢，表现为"Shift+左键没反应"。
             * 关掉库的处理，避免两边各自改一次选中态导致互相抵消。
             */
            multiSelectionKeyCode={null}
            onNodeClick={(event, node) => {
              if (!event.shiftKey) return
              /**
               * Shift+左键 = 增选 / 减选这一个节点，其它节点的选中原样保留。
               *
               * 做法：拿 pointerdown 时记下的选中集合，翻转目标节点，再整份写回。
               * 不用 `!node.selected` —— 库在我们之前已经把这一下变成"选中"了，
               * 那样取反永远得到"取消选中"。
               * 用 setTimeout 推到库的这次 click 处理之后，保证最终状态是我们的。
               */
              const snapshot = shiftDown.current
              shiftDown.current = null
              const before = snapshot?.selectedIds ?? nodesRef.current.filter((item) => item.selected).map((item) => item.id)
              const next = toggleSelection(before, node.id)
              const base = new Set(next)
              window.setTimeout(() => {
                setNodes((current) => current.map((item) => ({ ...item, selected: base.has(item.id) })))
              }, 0)
            }}
            onPaneClick={() => {
              // 点空白清空选中：和资源管理器一致，避免"残留选中"导致下次打包带上旧节点
              setNodes((current) =>
                current.some((item) => item.selected)
                  ? current.map((item) => (item.selected ? { ...item, selected: false } : item))
                  : current,
              )
            }}
            selectNodesOnDrag={false}
            /**
             * 删除键：默认行为只是从本地状态里移除，刷新就回来（图上删了库里没删）。
             * 这里关掉默认、自己接管，逐个走删除接口，并且删之前问一句 ——
             * 选中一片再按 Backspace 是很容易误触的动作。
             */
            deleteKeyCode={null}
            onKeyDown={(event) => {
              if (event.key !== 'Backspace' && event.key !== 'Delete') return
              const target = event.target as HTMLElement
              if (target.closest('input, textarea, [contenteditable="true"]')) return
              // 组节点也带 selected，但它不是可删除的 Node —— 过滤掉，否则会去删一个不存在的 id
              const selected = nodes.filter((node) => node.selected && !isGroupNodeId(node.id))
              if (selected.length === 0) return
              event.preventDefault()
              void (async () => {
                const ok = await confirm({
                  title: '删除节点',
                  message: `删除选中的 ${selected.length} 个节点？\n\n连在它们上面的线会一起消失，无法恢复。`,
                  okText: '删除',
                  danger: true,
                })
                if (!ok) return
                for (const node of selected) await deleteNode(node.id)
              })()
            }}
            onNodeDragStop={async (_event, node) => {
              const position = { x: Math.round(node.position.x), y: Math.round(node.position.y) }
              /**
               * 组节点：位置存进 NodeGroup，不能发去 /v1/nodes（那里没有这个 id）。
               * 这条也是"收起后拖不动"的修法 —— 组现在是真节点，拖动由画布完成，
               * 松手时把新坐标写回分组记录即可。
               */
              if (isGroupNodeId(node.id)) {
                const groupId = node.id.slice(GROUP_ID_PREFIX.length)
                const group = groups.find((item) => item.id === groupId)
                const deltaX = position.x - (group?.posX ?? position.x)
                const deltaY = position.y - (group?.posY ?? position.y)

                /**
                 * 拖动组 = 整体平移（用户 2026-11-24）。
                 *
                 * 锚点变了就必须把成员一起挪同样的距离，否则展开时成员还停在原地，
                 * 看起来像"框跑了、节点留在里面"。收起态时成员是隐藏的，一起挪也无害 ——
                 * 展开后它们仍然落在框内原来的相对位置。
                 */
                if (group && (deltaX !== 0 || deltaY !== 0)) {
                  memberOrigins.current.set(
                    groupId,
                    Object.fromEntries(
                      Object.entries(memberOrigins.current.get(groupId) ?? {}).map(([id, point]) => [
                        id,
                        { x: point.x + deltaX, y: point.y + deltaY },
                      ]),
                    ),
                  )
                  const moved: Array<{ id: string; x: number; y: number }> = []
                  setNodes((current) =>
                    current.map((item) => {
                      if (!group.memberIds.includes(item.id)) return item
                      const next = { x: item.position.x + deltaX, y: item.position.y + deltaY }
                      moved.push({ id: item.id, x: Math.round(next.x), y: Math.round(next.y) })
                      return { ...item, position: next }
                    }),
                  )
                  // 成员坐标要落库，否则刷新后组框与成员对不上
                  await Promise.all(
                    moved.map((item) =>
                      fetch(`${apiBaseUrl}/v1/nodes/${item.id}`, {
                        method: 'PATCH',
                        headers,
                        body: JSON.stringify({ posX: item.x, posY: item.y }),
                      }),
                    ),
                  )
                }

                await fetch(`${apiBaseUrl}/v1/groups/${groupId}`, {
                  method: 'PATCH',
                  headers,
                  body: JSON.stringify({ posX: position.x, posY: position.y }),
                })
                setGroups((current) =>
                  current.map((item) => (item.id === groupId ? { ...item, posX: position.x, posY: position.y } : item)),
                )
                return
              }
              await fetch(`${apiBaseUrl}/v1/nodes/${node.id}`, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ posX: position.x, posY: position.y }),
              })
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault()
              const native = event as unknown as MouseEvent
              // 右键平移结束时也会走到这里：位移超过阈值就不弹菜单
              const start = rightDown.current
              rightDown.current = null
              if (start && Math.hypot(native.clientX - start.x, native.clientY - start.y) > RIGHT_DRAG_THRESHOLD) return
              const flow = screenToFlowPosition({ x: native.clientX, y: native.clientY })
              setMenu({
                x: native.clientX,
                y: native.clientY,
                nodeId: null,
                flowX: flow.x,
                flowY: flow.y,
                // 空白处右键：沿用按下那一瞬的选中项（框选后想打包就靠它）
                selectedIds: start?.selectedIds ?? [],
              })
            }}
            /**
             * 多选状态下的右键。
             *
             * 框选后库会把选中节点包进一个 `.react-flow__nodesselection` 覆盖层，
             * 右键落在它上面时 onNodeContextMenu / onPaneContextMenu **都不会触发** ——
             * 用户看到的就是"框选了好几个节点，右键没反应"（本次报障的第 2 条）。
             * 只接这一个回调，用按下时的快照还原整组选中。
             */
            onSelectionContextMenu={(event) => {
              event.preventDefault()
              const native = event as unknown as MouseEvent
              const start = rightDown.current
              rightDown.current = null
              if (start && Math.hypot(native.clientX - start.x, native.clientY - start.y) > RIGHT_DRAG_THRESHOLD) return
              const ids = start?.selectedIds?.length
                ? start.selectedIds.filter((id) => !isGroupNodeId(id))
                : nodes.filter((node) => node.selected && !isGroupNodeId(node.id)).map((node) => node.id)
              const flow = screenToFlowPosition({ x: native.clientX, y: native.clientY })
              setMenu({
                x: native.clientX,
                y: native.clientY,
                // nodeId 为 null → 走"空白处"分支，里面有打包 / 批量运行 / 批量删除
                nodeId: null,
                flowX: flow.x,
                flowY: flow.y,
                selectedIds: ids,
              })
            }}
            onNodeContextMenu={(event, node) => {
              event.preventDefault()
              const native = event as unknown as MouseEvent
              const start = rightDown.current
              rightDown.current = null
              if (start && Math.hypot(native.clientX - start.x, native.clientY - start.y) > RIGHT_DRAG_THRESHOLD) return
              /**
               * 右键点在**组节点**上：走分组菜单。
               * 组没有普通节点的运行/重命名语义 —— 混用会让菜单里的操作对着一个不存在的节点执行。
               */
              if (isGroupNodeId(node.id)) {
                setGroupMenu({ groupId: node.id.slice(GROUP_ID_PREFIX.length), x: native.clientX, y: native.clientY })
                return
              }
              /**
               * 节点上右键：如果这个节点本来就在多选里，保留整组选中；
               * 否则只当它是单节点操作（库已经把选中态改成只选它了）。
               */
              const selectedIds = selectionForContextMenu(start?.selectedIds ?? [], node.id)
              setMenu({
                x: native.clientX,
                y: native.clientY,
                nodeId: node.id,
                flowX: node.position.x,
                flowY: node.position.y,
                selectedIds,
              })
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
          selectedCount={menu.selectedIds.length}
          selectedIds={menu.selectedIds}
          onPackGroup={() => void packGroup(menu.selectedIds)}
          onSplitCards={(nodeId) => void splitCards(nodeId)}
          onRunSelected={(ids) => void runSelectedInOrder(ids)}
          onDeleteSelected={(ids) => void deleteSelected(ids)}
          nodeType={
            menu.nodeId
              ? String(nodes.find((node) => node.id === menu.nodeId)?.data?.nodeType ?? '')
              : null
          }
        />
      )}

      {/* 分组右键菜单：组不是节点，单独一份菜单 */}
      {groupMenu && (() => {
        const group = groups.find((item) => item.id === groupMenu.groupId)
        if (!group) return null
        const isCollapsed = collapsed.has(group.id)
        const item = (label: string, onClick: () => void, opts?: { danger?: boolean; testId?: string }) => (
          <button
            key={label}
            type="button"
            data-testid={opts?.testId}
            onClick={() => { setGroupMenu(null); onClick() }}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              border: 'none',
              background: 'transparent',
              borderRadius: 6,
              padding: '7px 10px',
              fontSize: 13,
              cursor: 'pointer',
              color: opts?.danger ? '#dc2626' : '#1f2937',
            }}
            onMouseEnter={(event) => { event.currentTarget.style.background = '#f1f5f9' }}
            onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent' }}
          >
            {label}
          </button>
        )
        return (
          <>
            <div
              onClick={() => setGroupMenu(null)}
              onContextMenu={(event) => { event.preventDefault(); setGroupMenu(null) }}
              style={{ position: 'fixed', inset: 0, zIndex: 40 }}
            />
            <div
              data-testid="group-context-menu"
              style={{
                position: 'fixed',
                left: groupMenu.x,
                top: groupMenu.y,
                zIndex: 50,
                minWidth: 172,
                background: '#fff',
                border: '1px solid #e2e8f0',
                borderRadius: 8,
                boxShadow: '0 10px 28px rgba(15,23,42,0.16)',
                padding: 4,
              }}
            >
              {item(isCollapsed ? '展开这一组' : '收起这一组', () => toggleGroup(group), { testId: 'group-menu-toggle' })}
              {/*
                按依赖顺序运行整组：组最常见的用法就是"一条链跑一遍"，
                逐个点 ▶ 既慢又容易漏序（下游先跑拿到空上游）。
              */}
              {item(`按依赖顺序运行这 ${group.memberIds.length} 个节点`, () => void runSelectedInOrder(group.memberIds), { testId: 'group-menu-run' })}
              {item('重命名', () => void renameGroup(group), { testId: 'group-menu-rename' })}
              <div style={{ height: 1, background: '#e2e8f0', margin: '4px 2px' }} />
              {/* 解组只散开分组；删除组会连成员一起删 —— 措辞必须让人一眼分清 */}
              {item(`解组（保留 ${group.memberIds.length} 个节点）`, () => void unpackGroup(group.id), { testId: 'group-menu-unpack' })}
              {item(`删除整组（含 ${group.memberIds.length} 个节点）`, () => void deleteGroup(group), { danger: true, testId: 'group-menu-delete' })}
            </div>
          </>
        )
      })()}

      {packDraft && (
        <GroupCreateDialog
          memberCount={packDraft.ids.length}
          outside={packDraft.outsideNames}
          onCancel={() => setPackDraft(null)}
          onConfirm={(input) => void createGroup(packDraft, input)}
        />
      )}

      {dialog}

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
