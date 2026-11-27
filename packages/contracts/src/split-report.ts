export interface SplitReasonCount { reason: string; count: number }
export interface SplitDetail { index: number; name: string; reason: string; details: string[]; definition?: string; quote?: string }
export interface SplitReport {
  total: number
  newNodes: number
  existing: number
  repeated: number
  blocked: number
  primaryReasons: SplitReasonCount[]
}
