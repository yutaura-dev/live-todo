import { AgentRun } from "../../../domain/agent/agent-run.js";
import { documentsOf } from "../../../store/document-store.js";
import type { AgentRunView } from "../../shared/api.js";

// Task の画面からも読むので、AgentService とは別に置く（task-service と agent-service が互いに読み込み合わないように）
export const agentRuns = documentsOf("agent-run", AgentRun);

export const agentRunViewOf = (run: AgentRun): AgentRunView => ({
  id: run.id,
  request: run.request,
  status: run.status,
  tools: run.tools,
  trigger: run.trigger,
  actionItemId: run.actionItemId,
  result: run.result,
  stopReason: run.stopReason,
  progress: run.progress,
  createdAt: run.createdAt,
});

export const runsOfTask = (all: ReadonlyArray<AgentRun>, taskId: string) =>
  all.filter((run) => run.taskId === taskId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(agentRunViewOf);
