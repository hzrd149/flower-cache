{
  description = "flower-cache - Blossom proxy cache server";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      forAllSystems =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          f system (import nixpkgs {
            inherit system;
          })
        );

      sourceExclusions = [
        ".cursor"
        ".git"
        ".github"
        ".planning"
        ".vscode"
        "CLAUDE.md"
        "cache"
        "dist"
        "node_modules"
      ];

      src = nixpkgs.lib.cleanSourceWith {
        src = ./.;
        filter =
          path: _type:
          !(nixpkgs.lib.elem (baseNameOf path) sourceExclusions);
      };
    in
    {
      nixosModules = {
        flower-cache = import ./nix/module.nix self;
        default = self.nixosModules.flower-cache;
      };

      packages = forAllSystems (
        system: pkgs:
        (import ./nix/package.nix {
            inherit pkgs src systems;
            version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
          })
        // nixpkgs.lib.optionalAttrs (system == "x86_64-linux") {
          # `nix build .#vm` — a disposable flower-cache demonstration VM.
          vm =
            (nixpkgs.lib.nixosSystem {
              system = "x86_64-linux";
              modules = [
                "${nixpkgs}/nixos/modules/virtualisation/qemu-vm.nix"
                self.nixosModules.default
                ./nix/example-vm.nix
              ];
            }).config.system.build.vm;
        }
      );

      apps = forAllSystems (system: _pkgs: {
        default = {
          type = "app";
          program = "${nixpkgs.lib.getExe self.packages.${system}.default}";
          meta.description = "Run flower-cache";
        };
      });

      devShells = forAllSystems (_system: pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.bun ];
        };
      });

      checks = forAllSystems (
        system: pkgs:
        {
          package = self.packages.${system}.default;
        }
        // nixpkgs.lib.optionalAttrs (system == "x86_64-linux") {
          nixos-module = pkgs.testers.runNixOSTest (import ./nix/test.nix { inherit self; });
        }
      );
    };
}
