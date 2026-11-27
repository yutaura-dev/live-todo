import { Context, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { Headers, HttpClient, HttpClientRequest } from "effect/http";
import type { MicrosoftAuthError } from "./microsoft-auth.js";
import { MicrosoftToken } from "./microsoft-token.js";

export class MicrosoftRequestError extends Schema.TaggedError<MicrosoftRequestError>()("MicrosoftRequestError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

export class MicrosoftRateLimitedError extends Schema.TaggedError<MicrosoftRateLimitedError>()("MicrosoftRateLimitedError", {
  resetAt: Schema.String,
}) {}

export type GraphError = MicrosoftRequestError | MicrosoftRateLimitedError | MicrosoftAuthError;

type GetOptions = { query?: Record<string, string>; headers?: Record<string, string> };

/** Microsoft Graph（v1.0）を、サインインしたユーザーとして読む */
export class GraphClient extends Context.Service<GraphClient, {
  get(path: string, options?: GetOptions): Effect.Effect<unknown, GraphError>;
  /** 一覧の value を、@odata.nextLink をたどってつなぐ（maxPages まで） */
  getAll(path: string, options?: GetOptions & { maxPages?: number }): Effect.Effect<ReadonlyArray<unknown>, GraphError>;
}>()("live-todo/sources/microsoft/GraphClient") {}

const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0`;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const ErrorBody = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) });
const Page = Schema.Struct({ value: Schema.Array(Schema.Unknown), "@odata.nextLink": Schema.optional(Schema.String) });

export const GraphClientLive = Layer.effect(
  GraphClient,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const token = yield* MicrosoftToken;

    const send = (url: string, headers: Record<string, string>) =>
      Effect.gen(function* () {
        const request = HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(yield* token.accessToken)}`),
        );
        // 元のエラーを入れない理由: 送ったリクエスト（アクセストークン）を持っていて、ログに出すと漏れるため
        return yield* http.execute(request).pipe(Effect.mapError((error) => new MicrosoftRequestError({ message: `Microsoft Graph に接続できない（${error.reason._tag}）` })));
      });

    const fetchUrl = Effect.fnUntraced(function* (url: string, headers: Record<string, string> = {}) {
      let response = yield* send(url, headers);
      if (response.status === 401) {
        yield* token.invalidate;
        response = yield* send(url, headers);
      }
      if (response.status === 429 || response.status === 503) {
        const seconds = Number.parseInt(Option.getOrElse(Headers.get(response.headers, "retry-after"), () => ""), 10) || DEFAULT_RETRY_AFTER_SECONDS;
        return yield* new MicrosoftRateLimitedError({ resetAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { seconds })) });
      }
      const json = yield* response.json.pipe(Effect.orElseSucceed(() => ({}) as unknown));
      if (response.status < 200 || response.status >= 300) {
        const code = Option.getOrUndefined(Schema.decodeUnknownOption(ErrorBody)(json))?.error.code ?? `HTTP ${response.status}`;
        const hint = response.status === 403 ? "。アプリに必要な権限があり、同意が済んでいるかを確かめてください（会社のテナントでは管理者の同意が要ることがある）" : "";
        return yield* new MicrosoftRequestError({ message: `Microsoft Graph が失敗した: ${code}${hint}`, status: response.status });
      }
      return json;
    });

    const urlOf = (path: string, query: Record<string, string> = {}) => {
      const url = new URL(`${GRAPH_BASE}${path}`);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      return url.toString();
    };

    return GraphClient.of({
      get: (path, options = {}) => fetchUrl(urlOf(path, options.query), options.headers),
      getAll: Effect.fnUntraced(function* (path, options = {}) {
        const items: unknown[] = [];
        let next: string | undefined = urlOf(path, options.query);
        for (let page = 0; page < (options.maxPages ?? DEFAULT_MAX_PAGES) && next !== undefined; page++) {
          const body: typeof Page.Type = yield* Schema.decodeUnknownEffect(Page)(yield* fetchUrl(next, options.headers)).pipe(
            Effect.mapError(() => new MicrosoftRequestError({ message: `Microsoft Graph の一覧の形が想定と違う: ${path}` })),
          );
          items.push(...body.value);
          const link: string | undefined = body["@odata.nextLink"];
          // Graph の外を指す次のページは、たどるとアクセストークンを外に送ってしまうので、たどらない
          next = link !== undefined && URL.canParse(link) && new URL(link).origin === GRAPH_ORIGIN ? link : undefined;
        }
        return items;
      }),
    });
  }),
);
