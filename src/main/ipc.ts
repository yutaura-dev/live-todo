import { Schema, SchemaGetter } from "effect";

export { IPC_CHANNELS } from "../shared/channels.js";

// renderer から動かせるステータス。archived は元の項目が消えたときに同期が付けるもので、ユーザーは選ばない
const MovableStatus = Schema.Literals(["needs_review", "todo", "in_progress", "done", "dismissed"]);
export type MovableStatus = typeof MovableStatus.Type;

const TaskId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

// renderer が乗っ取られても main で想定外の操作をさせないよう、受け取る値はすべて Schema で検証する
export const decodeMoveRequest = Schema.decodeUnknownEffect(Schema.Struct({ taskId: TaskId, status: MovableStatus }));
export const decodeTaskId = Schema.decodeUnknownEffect(TaskId);

// renderer から書き換えられる秘密情報を、アプリが読むキーだけに絞る（任意の名前で保存させない）
const SecretKey = Schema.String.check(
  Schema.isPattern(/^(github\.[a-z0-9][a-z0-9-]*\.token|slack\.[a-z0-9][a-z0-9-]*\.(token|cookie)|notion\.[a-z0-9][a-z0-9-]*\.token|llm\.(anthropic|openai|azure-openai)\.api_key)$/),
);
export const decodeSecretKey = Schema.decodeUnknownEffect(SecretKey);

const SECRET_MAX_LENGTH = 4096;
export const decodeSecretInput = Schema.decodeUnknownEffect(
  Schema.Struct({
    key: SecretKey,
    value: Schema.String.pipe(
      Schema.decodeTo(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(SECRET_MAX_LENGTH)), {
        decode: SchemaGetter.transform((value: string) => value.trim()),
        encode: SchemaGetter.passthrough(),
      }),
    ),
  }),
);

export const decodeMergeRequest = Schema.decodeUnknownEffect(
  Schema.Struct({
    taskId: TaskId,
    method: Schema.Literals(["squash", "merge", "rebase"]),
    sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  }),
);

const StepId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100));
export const decodeConflictPushRequest = Schema.decodeUnknownEffect(
  Schema.Struct({ taskId: Schema.Int.check(Schema.isGreaterThan(0)), commitSha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)) }),
);

export const decodeStepRequest = Schema.decodeUnknownEffect(
  Schema.Struct({ taskId: TaskId, stepId: StepId, optionKey: Schema.optionalKey(StepId) }),
);

const MAX_PREVIEW_TARGETS = 100;
export const decodeFilterPreviewRequest = Schema.decodeUnknownEffect(
  Schema.Struct({
    accountId: Schema.String,
    filter: Schema.Struct({
      include: Schema.optional(Schema.Array(Schema.String)),
      exclude: Schema.optional(Schema.Array(Schema.String)),
    }),
    targets: Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(MAX_PREVIEW_TARGETS)),
  }),
);

const isCalendarUrl = (parsed: URL) =>
  parsed.hostname === "calendar.google.com" || (parsed.hostname === "www.google.com" && parsed.pathname.startsWith("/calendar/"));

const isMicrosoftUrl = (parsed: URL) =>
  (parsed.hostname === "microsoft.com" && parsed.pathname === "/devicelogin") ||
  (parsed.hostname === "login.microsoft.com" && parsed.pathname === "/device") ||
  parsed.hostname === "outlook.office365.com" ||
  parsed.hostname === "outlook.office.com";

const NOTION_HOSTS = new Set(["notion.so", "www.notion.so", "app.notion.com", "www.notion.com"]);

/** 外部のブラウザで開いてよい URL。Task の元の項目（GitHub の PR / issue、Slack、Gmail、Notion、Calendar、Microsoft のサインインと Outlook）だけに絞る */
export function isAllowedExternalUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return (
    parsed.protocol === "https:" &&
    (parsed.hostname === "github.com" || parsed.hostname === "mail.google.com" || /^[a-z0-9][a-z0-9-]*(\.enterprise)?\.slack\.com$/.test(parsed.hostname) ||
      NOTION_HOSTS.has(parsed.hostname) ||
      isCalendarUrl(parsed) ||
      isMicrosoftUrl(parsed))
  );
}
