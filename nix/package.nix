{
  pkgs,
  src,
  version,
  systems,
}:
let
  inherit (pkgs) lib stdenvNoCC;

  nodeModules = stdenvNoCC.mkDerivation {
    pname = "flower-cache-node-modules";
    inherit version src;

    impureEnvVars = lib.fetchers.proxyImpureEnvVars ++ [
      "GIT_PROXY_COMMAND"
      "SOCKS_SERVER"
    ];

    nativeBuildInputs = [
      pkgs.bun
      pkgs.writableTmpDirAsHomeHook
    ];

    dontConfigure = true;

    buildPhase = ''
      runHook preBuild

      export BUN_INSTALL_CACHE_DIR="$(mktemp -d)"
      bun install \
        --cpu="*" \
        --os="*" \
        --frozen-lockfile \
        --ignore-scripts \
        --no-progress \
        --production

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p "$out"
      cp -R node_modules "$out/"

      runHook postInstall
    '';

    # Fixup can embed host-specific Nix store paths in the fixed-output tree.
    dontFixup = true;

    outputHash = "sha256-pej9NKjgnTmgM65DgstHK2R/SETyZ8ld0xoDeYJkXrw=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };

  flower-cache = stdenvNoCC.mkDerivation {
    pname = "flower-cache";
    inherit version src;

    nativeBuildInputs = [ pkgs.makeWrapper ];

    dontBuild = true;

    installPhase = ''
      runHook preInstall

      app="$out/share/flower-cache"
      mkdir -p "$app" "$out/bin"
      cp index.ts package.json bun.lock tsconfig.json "$app/"
      cp -R src "$app/"
      cp -R ${nodeModules}/node_modules "$app/"

      makeWrapper ${lib.getExe pkgs.bun} "$out/bin/flower-cache" \
        --add-flags "run" \
        --add-flags "$app/index.ts"

      runHook postInstall
    '';

    meta = {
      description = "High-performance Blossom proxy server that caches blobs locally";
      homepage = "https://github.com/hzrd149/flower-cache";
      license = lib.licenses.mit;
      mainProgram = "flower-cache";
      platforms = systems;
    };
  };
in
{
  default = flower-cache;
  inherit flower-cache nodeModules;
}
