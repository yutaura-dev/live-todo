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
          # 技術スタック（Tauri なら Rust toolchain など）は ADR で確定してから追加する。
          packages = [
            pkgs.nodejs_22
            pkgs.pnpm
          ];
        };
      }
    );
}
