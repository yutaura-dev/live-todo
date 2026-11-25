{
  description = "live-todo: 開発環境";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          # グローバルインストール（brew / npm i -g）に頼らない理由:
          # 版が flake.lock で固定され、手元・CI・worktree で同じものが入る。
          # pkgs.pnpm ではなく corepack を使う理由:
          # nixpkgs の pnpm は版が遅れがちで、新しい設定キー（lockfile.includeResolutionSettings など）を
          # 含む pnpm-workspace.yaml を、packageManager の版に切り替える前に読んで失敗する。
          # corepack は設定を読まずに packageManager の版を取得して起動する。
          packages = [
            pkgs.nodejs_24
            pkgs.corepack_24
          ];
          COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
        };
      }
    );
}
