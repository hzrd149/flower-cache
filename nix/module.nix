self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.flower-cache;
in
{
  options.services.flower-cache = {
    enable = lib.mkEnableOption "flower-cache Blossom proxy cache server";

    package = lib.mkPackageOption self.packages.${pkgs.stdenv.hostPlatform.system} "flower-cache" { };

    port = lib.mkOption {
      type = lib.types.port;
      default = 24242;
      description = "TCP port on which flower-cache listens.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Whether to open the configured flower-cache TCP port in the firewall.";
    };

    cacheDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/flower-cache";
      description = ''
        Directory where cached blobs and the SQLite metadata database are stored.
        Defaults to the systemd {file}`StateDirectory` under
        {file}`/var/lib/flower-cache`.
      '';
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = ''
        Extra environment variables passed to the flower-cache service, in
        addition to those derived from the module options. See
        <https://github.com/hzrd149/flower-cache#configuration> for the
        full list of supported variables.
      '';
      example = lib.literalExpression ''
        {
          MAX_CACHE_SIZE = "10GB";
          FALLBACK_SERVERS = "https://blossom.primal.net";
          LOOKUP_RELAYS = "wss://purplepag.es";
        }
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    networking.firewall.allowedTCPPorts = lib.optional cfg.openFirewall cfg.port;

    systemd.services.flower-cache = {
      description = "flower-cache Blossom proxy cache server";
      documentation = [ "https://github.com/hzrd149/flower-cache" ];
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];

      environment = {
        PORT = toString cfg.port;
        CACHE_DIR = cfg.cacheDir;
      } // cfg.environment;

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        Restart = "on-failure";
        RestartSec = 5;

        DynamicUser = true;
        StateDirectory = "flower-cache";
        WorkingDirectory = "/var/lib/flower-cache";
        UMask = "0077";

        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProtectControlGroups = true;
        ProtectHome = true;
        ProtectKernelModules = true;
        ProtectKernelTunnels = true;
        ProtectSystem = "strict";
        RestrictSUIDSGID = true;
      };
    };
  };
}
