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

      # Bun 1.4.0 is the repository baseline (package.json `packageManager`, CI
      # `bun-version`, and `@types/bun` all pin it). nixpkgs still ships 1.3.13,
      # so the dev shell overrides the upstream sources to keep one runtime
      # across local, `nix develop`, and CI. Delete this override and use
      # `pkgs.bun` directly once nixpkgs reaches 1.4.0.
      bunVersion = "1.4.0";
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
                  hash = "sha256-GE+0WV8NQBohfPfHjBvEMLqDMU2reouUgFurv3+nCX8=";
                };
                "aarch64-linux" = pkgs.fetchurl {
                  url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-linux-aarch64.zip";
                  hash = "sha256-SxozLuhhmD65O8/m93D/+U4+MbLDiL2uo8jtNeWO7Q4=";
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
