import { Context, Effect, Layer, Option } from "effect";
import { Account, addAccount, connect, removeAccount, restoreAccount } from "../../../domain/account/account.js";
import { DocumentStore, documentsOf } from "../../../store/document-store.js";
import type { StoreCorrupted } from "../../../store/task-store.js";
import type { Reply } from "../../shared/api.js";
import { SourceGateway } from "./gateway.js";

export const accounts = documentsOf("account", Account);

export type AccountView = { id: string; label: string; origin: string; status: Account["status"]; problem: Account["problem"]; secret: string | null };

const user = { kind: "user" } as const;
const KEY = /^[a-z0-9-]+$/;

/** .env.local に書くトークンの名前（キーの "-" は "_" に、英字は大文字に。.env.example の決まり） */
export const githubSecretOf = (key: string) => `LIVE_TODO_SECRET_GITHUB_${key.replaceAll("-", "_").toUpperCase()}_TOKEN`;

const viewOf = (account: Account): AccountView => ({
  id: account.id,
  label: account.label,
  origin: account.origin,
  status: account.status,
  problem: account.problem,
  secret: typeof account.scope === "object" && account.scope !== null && "secret" in account.scope ? String((account.scope as { secret: unknown }).secret) : null,
});

/** アカウントを足してつなぐ・外す（今は GitHub だけ）。トークンは .env.local に置き、ここでは名前だけを持つ */
export class AccountService extends Context.Service<
  AccountService,
  {
    list(): Effect.Effect<ReadonlyArray<AccountView>, StoreCorrupted>;
    addGitHub(input: { key: string; label: string }): Effect.Effect<Reply<AccountView>, StoreCorrupted>;
    remove(id: string): Effect.Effect<Reply<AccountView>, StoreCorrupted>;
    connected(): Effect.Effect<ReadonlyArray<Account>, StoreCorrupted>;
  }
>()("live-todo/desktop/AccountService") {
  static readonly layer = Layer.effect(
    AccountService,
    Effect.gen(function* () {
      const gateway = yield* SourceGateway;
      const docs = yield* DocumentStore;
      const withDocs = <A, E>(effect: Effect.Effect<A, E, DocumentStore>) => Effect.provideService(effect, DocumentStore, docs);

      const addGitHub = (input: { key: string; label: string }) =>
        Effect.gen(function* () {
          if (!KEY.test(input.key)) return { ok: false, reason: "名前は英小文字・数字・ハイフンで書いてください" } as const;
          const secret = githubSecretOf(input.key);
          const viewer = yield* gateway.githubViewer(secret).pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isNone(viewer)) return { ok: false, reason: `トークンが通りません。.env.local の ${secret} を確かめてください` } as const;
          const origin = `github://${viewer.value.login}@github.com`;
          const scope = { kind: "github", secret, login: viewer.value.login, teams: viewer.value.teams };
          const same = (yield* accounts.all()).find((account) => account.origin === origin);
          if (same !== undefined && same.status !== "外した") return { ok: false, reason: "同じ GitHub のアカウントを、もう足しています" } as const;
          // 外したアカウントと同じ origin なら、前の ID のまま戻す（前の事実・Task・取り込みの続きを引き継ぐ。account.spec）
          const base = same === undefined ? yield* Effect.orDie(addAccount({ id: `github-${input.key}`, origin, label: input.label, scope }, user, "同じ origin のアカウントはない")) : yield* Effect.orDie(restoreAccount(same, user));
          const account = yield* Effect.orDie(connect({ ...base, scope, label: input.label }, user, "通った"));
          yield* accounts.save(account);
          return { ok: true, value: viewOf(account) } as const;
        });

      const remove = (id: string) =>
        Effect.gen(function* () {
          const found = yield* accounts.find(id);
          if (Option.isNone(found)) return { ok: false, reason: "アカウントが見つかりません" } as const;
          const removed = yield* removeAccount(found.value, user).pipe(Effect.map((a) => ({ ok: true, value: a }) as const), Effect.catch((e) => Effect.succeed({ ok: false, reason: e.reason } as const)));
          if (!removed.ok) return removed;
          yield* accounts.save(removed.value);
          return { ok: true, value: viewOf(removed.value) } as const;
        });

      return AccountService.of({
        list: () => withDocs(Effect.map(accounts.all(), (all) => all.map(viewOf))),
        addGitHub: (input) => withDocs(addGitHub(input)),
        remove: (id) => withDocs(remove(id)),
        connected: () => withDocs(Effect.map(accounts.all(), (all) => all.filter((account) => account.status === "つないでいる"))),
      });
    }),
  );
}
