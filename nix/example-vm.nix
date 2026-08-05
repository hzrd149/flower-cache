{
  config,
  ...
}:
{
  networking.hostName = "flower-cache-vm";

  services.flower-cache = {
    enable = true;
    openFirewall = true;

    environment = {
      FALLBACK_SERVERS = "https://blossom.primal.net";
      LOOKUP_RELAYS = "wss://purplepag.es";
    };
  };

  # Use a graphical QEMU display so the VM console opens in its own window
  # instead of taking over the launching terminal with a getty login prompt.
  virtualisation = {
    graphics = true;
    memorySize = 2048;
    cores = 2;
    # Keep the demonstration disposable instead of writing a qcow2 image into
    # the directory from which it was launched.
    diskImage = null;
    forwardPorts = [
      {
        from = "host";
        proto = "tcp";
        host.address = "127.0.0.1";
        host.port = config.services.flower-cache.port;
        guest.port = config.services.flower-cache.port;
      }
    ];
  };

  # Auto-login as root on the serial console so the VM prints a shell prompt
  # as soon as it boots, instead of waiting for credentials.
  services.getty.autologinUser = "root";

  system.stateVersion = "26.05";
}
