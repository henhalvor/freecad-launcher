{
  description = "FreeCAD Launcher — manage official FreeCAD stable and weekly AppImages on NixOS";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = {
    self,
    nixpkgs,
  }: let
    system = "x86_64-linux";
    pkgs = nixpkgs.legacyPackages.${system};
    inherit (pkgs) lib;

    appVersion = "1.0.0";

    # Tools the launcher is allowed to rely on. Everything else it needs must be
    # provided by this closure: it never assumes the interactive shell's PATH.
    runtimeInputs = with pkgs; [
      appimage-run
      f3d
      git
      pixi
      coreutils
      xdg-utils
    ];

    runtimePath = lib.makeBinPath runtimeInputs;

    # The Nix wrapper owns argument translation because Electron/Chromium claim
    # `--version` and `--help`. The public CLI is preserved for users and
    # generated desktop entries; the app sees namespaced flags instead.
    launcherRaw = pkgs.writeShellScriptBin "freecad-launcher-raw" ''
      set -euo pipefail
      APP="''${FREECAD_LAUNCHER_APP_DIR:?FREECAD_LAUNCHER_APP_DIR must point at the app directory}"

      declared_launch=0
      for arg in "$@"; do
        if [ "$arg" = "launch" ]; then declared_launch=1; fi
      done

      rewritten=()
      for arg in "$@"; do
        case "$arg" in
          --version)
            if [ "$declared_launch" = "1" ]; then
              rewritten+=(--release-id)
            else
              rewritten+=(--launcher-version)
            fi
            ;;
          -v)
            rewritten+=(--launcher-version)
            ;;
          --help | -h)
            rewritten+=(--launcher-help)
            ;;
          *)
            rewritten+=("$arg")
            ;;
        esac
      done

      exec ${pkgs.electron}/bin/electron "$APP" "''${rewritten[@]}"
    '';

    freecad-launcher = pkgs.buildNpmPackage {
      pname = "freecad-launcher";
      version = appVersion;
      src = ./.;

      npmDepsHash = "sha256-iEUV++5KQDMxXcTSb5KKSXOG163kUgn7FdqVjpjieH0=";
      npmBuildScript = "build";
      makeCacheWritable = true;

      nativeBuildInputs = [ pkgs.makeWrapper ];

      # npm supplies Electron types only; the runtime comes from pkgs.electron.
      env = {
        ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
        npm_config_ignore_scripts = "false";
      };

      doCheck = false;

      postInstall = ''
        mkdir -p $out/share/freecad-launcher
        cp -r dist $out/share/freecad-launcher/dist
        cat > $out/share/freecad-launcher/package.json <<'EOF'
        {
          "name": "freecad-launcher",
          "version": "${appVersion}",
          "private": true,
          "type": "module",
          "main": "dist/main/app.cjs"
        }
        EOF

        makeWrapper ${launcherRaw}/bin/freecad-launcher-raw $out/bin/freecad-launcher \
          --prefix PATH : ${runtimePath} \
          --set FREECAD_LAUNCHER_APP_DIR $out/share/freecad-launcher \
          --set FREECAD_LAUNCHER_CLI freecad-launcher

        install -Dm644 ${./assets/freecad-launcher.svg} \
          $out/share/icons/hicolor/scalable/apps/freecad-launcher.svg
      '';

      meta = with lib; {
        description = "Launcher for official FreeCAD stable and weekly AppImages, with a PR build lab";
        homepage = "https://github.com/henhalvor/freecad-launcher";
        license = licenses.mit;
        platforms = ["x86_64-linux"];
        mainProgram = "freecad-launcher";
      };
    };

    # Enters the pinned FreeCAD PR build shell and runs a fixed command array.
    # It never installs or launches the nixpkgs FreeCAD package.
    freecad-pr-runner = pkgs.writeShellApplication {
      name = "freecad-pr-runner";
      runtimeInputs = [pkgs.nix pkgs.coreutils];
      text = ''
        set -euo pipefail
        usage() {
          echo "usage: freecad-pr-runner build --source DIR --build-dir DIR --jobs N" >&2
        }
        if [ "$#" -lt 1 ]; then usage; exit 2; fi
        command="$1"; shift

        case "$command" in
          build)
            source_dir=""
            build_dir=""
            jobs="$(nproc)"
            while [ "$#" -gt 0 ]; do
              case "$1" in
                --source) source_dir="$2"; shift 2 ;;
                --build-dir) build_dir="$2"; shift 2 ;;
                --jobs) jobs="$2"; shift 2 ;;
                *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
              esac
            done
            if [ -z "$source_dir" ] || [ -z "$build_dir" ]; then usage; exit 2; fi
            exec nix develop ${self}#freecad-pr --command bash -c '
              set -euo pipefail
              src="$1"; build="$2"; jobs="$3"
              generator_args=()
              if command -v ninja >/dev/null 2>&1; then generator_args+=(-G Ninja); fi
              launcher_args=()
              if command -v ccache >/dev/null 2>&1; then
                launcher_args+=(-DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache)
              fi
              cmake -B "$build" -S "$src" -DCMAKE_BUILD_TYPE=Debug "''${generator_args[@]}" "''${launcher_args[@]}"
              cmake --build "$build" -j "$jobs"
            ' -- "$source_dir" "$build_dir" "$jobs"
            ;;
          *)
            usage
            exit 2
            ;;
        esac
      '';
    };
  in {
    packages.${system} = {
      inherit freecad-launcher freecad-pr-runner;
      default = freecad-launcher;
    };

    apps.${system}.default = {
      type = "app";
      program = "${freecad-launcher}/bin/freecad-launcher";
      meta.description = "Run FreeCAD Launcher";
    };

    devShells.${system} = {
      default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_22
          electron
          appimage-run
          f3d
          git
          pixi
          coreutils
          xdg-utils
        ];
        shellHook = ''
          export ELECTRON_EXECUTABLE_PATH="$(command -v electron)"
          export ELECTRON_SKIP_BINARY_DOWNLOAD=1
          echo "freecad-launcher dev shell — npm install, then npm run dev"
        '';
      };

      # FreeCAD build dependencies inherited from the nixpkgs FreeCAD package,
      # without exposing or launching the FreeCAD executable itself.
      freecad-pr = pkgs.mkShell {
        inputsFrom = [pkgs.freecad];
        packages = with pkgs; [
          git
          cmake
          ninja
          ccache
          pkg-config
          pixi
        ];
        CMAKE_GENERATOR = "Ninja";
      };
    };

    checks.${system}.default = freecad-launcher.overrideAttrs (old: {
      pname = "freecad-launcher-check";
      doCheck = true;
      checkPhase = ''
        runHook preCheck
        npm test
        npm run check
        runHook postCheck
      '';
    });

    nixosModules.default = {
      config,
      lib,
      pkgs,
      ...
    }: let
      cfg = config.services.freecad-launcher;
    in {
      options.services.freecad-launcher = {
        enable = lib.mkEnableOption "FreeCAD Launcher";
        package = lib.mkOption {
          type = lib.types.package;
          default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
          description = "The FreeCAD Launcher package to use.";
        };
      };

      config = lib.mkIf cfg.enable {
        # Electron's sandbox needs the Chromium setuid helper; the launcher is
        # never started with --no-sandbox.
        security.chromiumSuidSandbox.enable = true;
        environment.systemPackages = [cfg.package];
      };
    };

    homeModules.default = {
      config,
      lib,
      pkgs,
      ...
    }: let
      cfg = config.programs.freecad-launcher;
      package = cfg.package;
    in {
      options.programs.freecad-launcher = {
        enable = lib.mkEnableOption "FreeCAD Launcher";
        package = lib.mkOption {
          type = lib.types.package;
          default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
          description = "The FreeCAD Launcher package to use.";
        };
      };

      config = lib.mkIf cfg.enable {
        home.packages = [package];

        # The main desktop entry. Channel-following and version-pinned entries
        # are generated at runtime through the launcher CLI so environment
        # cleanup and profile selection survive updates.
        xdg.desktopEntries.freecad-launcher = {
          name = "FreeCAD Launcher";
          genericName = "CAD Application";
          comment = "Manage and launch FreeCAD AppImages";
          exec = "${package}/bin/freecad-launcher";
          icon = "freecad-launcher";
          terminal = false;
          categories = ["Graphics" "Science" "Education" "Engineering"];
          settings.StartupWMClass = "FreeCAD";
        };
      };
    };

    formatter.${system} = pkgs.alejandra;
  };
}
