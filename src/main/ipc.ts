import { Schema } from "effect";

export { IPC_CHANNELS } from "../shared/channels.js";

// renderer から動かせるステータス。archived は元の項目が消えたときに同期が付けるもので、ユーザーは選ばない
const MovableStatus = Schema.Literals(["needs_review", "todo", "in_progress", "done", "dismissed"]);
export type MovableStatus = typeof MovableStatus.Type;

const TaskId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

// renderer が乗っ取られても main で想定外の操作をさせないよう、受け取る値はすべて Schema で検証する
export const decodeMoveRequest = Schema.decodeUnknownEffect(Schema.Struct({ taskId: TaskId, status: MovableStatus }));
export const decodeTaskId = Schema.decodeUnknownEffect(TaskId);

/** 外部のブラウザで開いてよい URL。Task の元の項目（GitHub の PR / issue）だけに絞る */
export function isAllowedExternalUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && parsed.hostname === "github.com";
}
