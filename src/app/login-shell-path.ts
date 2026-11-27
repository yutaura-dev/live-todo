import { Duration, Effect, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const MARKER = "__LIVE_TODO_PATH__";
// シェルの設定ファイルが重いと止まることがあるので、待つのはここまでにする
const TIMEOUT = Duration.seconds(5);

/** -i も付ける理由: nix や Homebrew の PATH は .zshrc（対話シェルだけが読む）に書かれていることが多いため */
export const loginShellArgs = ["-ilc", `printf '${MARKER}%s${MARKER}' "$PATH"`] as const;

export function pathFromShellOutput(output: string): Option.Option<string> {
  const start = output.indexOf(MARKER);
  const end = output.indexOf(MARKER, start + MARKER.length);
  if (start < 0 || end < 0) return Option.none();
  const path = output.slice(start + MARKER.length, end).trim();
  return path === "" ? Option.none() : Option.some(path);
}

export function mergePath(current: string | undefined, fromShell: string): string {
  const entries = [...fromShell.split(":"), ...(current ?? "").split(":")].filter((entry) => entry !== "");
  return [...new Set(entries)].join(":");
}

/**
 * ログインシェルの PATH。Finder や Dock から起動したアプリの PATH は /usr/bin:/bin:/usr/sbin:/sbin だけで、
 * gws・claude・gh などを見つけられないため、起動時に読み込む。読めなければ none（今の PATH のまま動かす）
 */
export const loginShellPath = Effect.fnUntraced(function* (shell: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(ChildProcess.make(shell, [...loginShellArgs])).pipe(
    Effect.timeout(TIMEOUT),
    Effect.map(pathFromShellOutput),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
});
