// Response shapes of the gateway's /api endpoints, as consumed by the UI.

export interface AgentCardInfo {
  name: string;
  description?: string;
  protocolVersion?: string;
  skills?: { id: string; tags?: string[] }[];
}

export interface AgentInfo {
  port: number;
  online: boolean;
  card: AgentCardInfo;
}

export interface ArdEntry {
  identifier: string;
  displayName: string;
  enabled: boolean;
}

export interface ArdHit {
  displayName: string;
  score: number;
}

export interface ChainState {
  balances: Record<string, number>;
  policy: { owner: string; perTxCap: number; cumulativeCap: number; spent: number };
  identity: { identifier: string; name: string }[];
  validations: Record<string, { score: number } | undefined>;
  contracts?: Record<string, string>;
  evmRpc?: string;
}

export interface SendResult {
  reply?: string;
  taskId?: string;
  contextId?: string;
  state?: string;
  error?: string;
}
