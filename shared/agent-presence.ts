export interface ResourceClaim { kind: 'path' | 'resource'; value: string }
export interface AgentPresence {
  id: string;
  threadId: string;
  slot: string;
  cwd: string;
  summary: string;
  claims: ResourceClaim[];
  startedAt: number;
  updatedAt: number;
  stale: boolean;
}
export interface PresenceView {
  runs: AgentPresence[];
  conflicts: { runIds: [string, string]; claims: [ResourceClaim, ResourceClaim]; stale: boolean }[];
  partial: boolean;
}
