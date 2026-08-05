# flower-cache NixOS VM example

The repository flake exposes `packages.${system}.vm` as a complete, bootable
NixOS QEMU VM. It imports `nixosModules.default` from
[`module.nix`](./module.nix) and runs flower-cache with a small demonstration
configuration.

The VM uses a graphical QEMU display (`virtualisation.graphics = true`) so the
guest console opens in its own window and does not take over the launching
terminal with a login prompt.

## Build and run locally

Build the QEMU VM from the repository root:

```sh
nix build path:.#vm
```

The explicit `path:.` form includes untracked files while developing the
example. After `nix/example-vm.nix` has been added to Git, the shorter
`nix build .#vm` works as well.

Start it in a terminal:

```sh
result/bin/run-flower-cache-vm-vm
```

QEMU opens a display window showing the guest console. The VM auto-logs in
as `root` on the serial console, so a shell prompt appears as soon as boot
finishes. The launching terminal shows QEMU's monitor output; press
<kbd>Ctrl-C</kbd> in it to quit the VM.

The VM forwards guest port `24242` to `127.0.0.1:24242` on the host. Once
systemd reports the service is up, check it from another terminal:

```sh
curl --fail http://127.0.0.1:24242/
```

The VM uses a temporary disk (`diskImage = null`); cached blobs are not
preserved between boots.

## Deploy to an existing NixOS machine

The same configuration can be evaluated and activated remotely with
`nixos-rebuild`. Replace the host below with a machine on which root SSH access
is already configured:

```sh
nixos-rebuild switch \
  --flake path:.#vm \
  --target-host root@flower.example.com \
  --build-host root@flower.example.com
```

For a real deployment, copy [`example-vm.nix`](./example-vm.nix) into your own
NixOS flake, remove the QEMU-only `virtualisation` block, add the target's
hardware configuration, and set `FALLBACK_SERVERS` / `LOOKUP_RELAYS` to
production values. A minimal consumer looks like this:

```nix
{
  inputs.flower-cache.url = "github:hzrd149/flower-cache";

  outputs = { nixpkgs, flower-cache, ... }: {
    nixosConfigurations.my-host = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        flower-cache.nixosModules.default
        ./configuration.nix
        {
          services.flower-cache = {
            enable = true;
            openFirewall = true;
            environment = {
              MAX_CACHE_SIZE = "10GB";
              FALLBACK_SERVERS = "https://blossom.primal.net";
              LOOKUP_RELAYS = "wss://purplepag.es";
            };
          };
        }
      ];
    };
  };
}
```
