{ self }:
{
  name = "flower-cache-module";

  nodes.machine =
    { ... }:
    {
      imports = [ self.nixosModules.default ];

      services.flower-cache = {
        enable = true;
        port = 24242;
        openFirewall = true;

        environment = {
          FALLBACK_SERVERS = "https://blossom.primal.net";
          ALLOWED_UPLOAD_IPS = "127.0.0.0/8,::1,::ffff:127.0.0.1";
        };
      };
    };

  testScript = ''
    machine.start()
    machine.wait_for_unit("flower-cache.service")
    machine.wait_for_open_port(24242)

    # Stats / index page is served at GET /
    machine.succeed("curl --fail --silent http://127.0.0.1:24242/ | grep -F 'Flower Cache'")

    # HEAD / is a health check
    machine.succeed("curl --fail --silent --head http://127.0.0.1:24242/")

    # Cache directory is created and owned by the dynamic user
    machine.succeed("test -d /var/lib/flower-cache")
    machine.succeed("systemctl show flower-cache.service -P DynamicUser | grep -Fx yes")
    machine.succeed("systemctl show flower-cache.service -P StateDirectory | grep -Fx flower-cache")

    # Service survives a restart
    machine.succeed("systemctl restart flower-cache.service")
    machine.wait_for_unit("flower-cache.service")
    machine.wait_for_open_port(24242)
  '';
}
