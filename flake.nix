{
  description = "ai-usage development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      eachSystem = nixpkgs.lib.genAttrs systems;

      # Bun 1.4.4 is the repository runtime: package.json `packageManager` and
      # `@types/bun` pin it, and CI reads the same field through setup-bun.
      # nixpkgs lags behind it (nixos-unstable still shipped 1.4.2 on
      # 2026-10-28), so the dev shell overrides the
      # upstream sources to keep the same Bun release across local,
      # `nix develop`, and CI. Delete this override and
      # use `pkgs.bun` directly once nixpkgs ships bun >= 1.4.4. When moving the
      # version, refresh both hashes with `nix store prefetch-file --json <url>`.
      bunVersion = "1.4.4";
      bunFor =
        pkgs:
        pkgs.bun.overrideAttrs (
          finalAttrs: previousAttrs: {
            __intentionallyOverridingVersion = true;
            version = bunVersion;
            passthru = previousAttrs.passthru // {
              sources = {
                "x86_64-linux" = pkgs.fetchurl {
                  url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-linux-x64-baseline.zip";
                  hash = "sha256-4ERutVmVdy65iUvrrppr42jZhai5Jx7hJEhvmUbu3XY=";
                };
                "aarch64-linux" = pkgs.fetchurl {
                  url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-linux-aarch64.zip";
                  hash = "sha256-uqa7NvUdblhWHgK76oJQOKnfRU9nPW13bou/hvjHhQ4=";
                };
              };
            };
          }
        );
    in
    {
      devShells = eachSystem (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.biome
              (bunFor pkgs)
            ];
          };
        }
      );
    };
}
