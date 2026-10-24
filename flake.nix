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

      # Bun 1.4.3 is the repository runtime: package.json `packageManager` and
      # `@types/bun` pin it, and CI reads the same field through setup-bun.
      # nixpkgs lags behind it (nixos-unstable shipped 1.4.2 on 2026-10-22;
      # NixOS/nixpkgs#574334 tracks 1.4.3), so the dev shell overrides the
      # upstream sources to keep the same Bun release across local,
      # `nix develop`, and CI. Delete this override and
      # use `pkgs.bun` directly once nixpkgs ships bun >= 1.4.3. When moving the
      # version, refresh both hashes with `nix store prefetch-file --json <url>`.
      bunVersion = "1.4.3";
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
                  hash = "sha256-H8LtrIQxApCeOhvh2NmALMYHHPB05n6IIx9P/g+LOXs=";
                };
                "aarch64-linux" = pkgs.fetchurl {
                  url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-linux-aarch64.zip";
                  hash = "sha256-76mBPaXtckI7+Ef5FujSxHwNd2rdlyNUAmp14Q2pqiE=";
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
