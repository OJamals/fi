"""Locate and execute the bundled dsh CLI shipped with the Python SDK runtime.

Two runtime carriers coexist under ``runtime/``, both injected by the repo's
``scripts/build-exe-for-python-sdk.ts`` build (neither is checked into git):

- **exe (production)**: single-file Node executables named
  ``deepseek-harness-sdk-runtime-<platform>-<arch>`` for Linux/macOS and an
  ``.exe`` counterpart for Windows. Each has a sibling ripgrep executable;
  macOS also uses a sibling ``-spawn-helper``. The target machine needs no
  Node installation.
- **node (dev-only)**: the full deploy closure under ``runtime/node/``
  (``package.json`` + ``node_modules/``), executed as ``node
  runtime/node/node_modules/@deepseek-ai/dsh/lib/bin.js`` on a
  system Node >= 22.19. It is the current checkout's source build, never
  selected automatically, and excluded from wheel/sdist distributions.

Both carriers execute the same dsh command grammar. The Python SDK selects the
``sdk`` profile and requires an explicit Harness home; the installed ``dsh``
console command requires ``DSH_HOME`` for the same reason.
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Mapping
from ._resources import validate_resources

PACKAGE_METADATA_FILENAME = "deepseek-harness-runtime.json"

RUNTIME_MODE_ENV_VAR = "DSH_RUNTIME_MODE"


#: Base names of the runtime ``DSH_<NAME>`` variables that may also be given as
#: ``FI_<NAME>``; a copy of ``FI_RUNTIME_ENVIRONMENT_NAMES`` in ``@deepseek-ai/dsh-home-paths``,
#: which a test in that package compares with this tuple.
FI_RUNTIME_ENVIRONMENT_NAMES: tuple[str, ...] = (
    "AGENTS_HOME",
    "BUNDLED_PRIMARY_RUNTIME",
    "BUNDLED_SKILL_DIR",
    "CONTEXT_WINDOW",
    "DESKTOP_DSH_DIR",
    "DESKTOP_HOST_INSPECT_PORT",
    "DESKTOP_LOGIN_SHELL_TIMEOUT_MS",
    "DESKTOP_MANDATORY_UPDATE_CONFIG",
    "DESKTOP_OPEN_DEVTOOLS",
    "DESKTOP_PRIMARY_RUNTIME_DIR",
    "DESKTOP_UPDATE_CHECK_INTERVAL_MS",
    "DESKTOP_UPDATE_CHECK_JITTER",
    "DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS",
    "DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS",
    "DESKTOP_UPDATE_JOURNAL_DIR",
    "GITHUB_REVIEW_WORKSPACE",
    "GITHUB_WEBHOOK_PORT",
    "GITHUB_WEBHOOK_SECRET",
    "HOME",
    "MAX_TOKENS_AS_SUCCESS",
    "MODEL",
    "PERMISSION_MODE",
    "PLATFORM_ALLOW_LOOPBACK_HTTP",
    "PLATFORM_COOKIE",
    "PLATFORM_ORIGIN",
    "PRIMARY_RUNTIME",
    "PRODUCT_ANALYTICS_OTLP_URL",
    "RUNTIME_MODE",
    "SYSTEM_PROMPT",
    "TELEMETRY_DISABLED",
    "TELEMETRY_MODE",
    "TELEMETRY_OTLP_URL",
    "TOOLS_MODE",
    "WEB_FETCH_PROVIDER",
    "WEB_SEARCH_PROVIDER",
)


def fi_environment_aliases(values: Mapping[str, str]) -> dict[str, str]:
    """The ``DSH_<NAME>`` entries implied by the runtime ``FI_<NAME>`` entries of ``values``.

    Every ``FI_<NAME>`` whose ``<NAME>`` is in ``FI_RUNTIME_ENVIRONMENT_NAMES`` yields
    ``DSH_<NAME>`` with the same value, including an empty value; other ``FI_*`` names
    yield nothing. Merging the result over ``values`` makes the ``FI_`` spelling win
    when both are present.
    """
    return {
        "DSH_" + name[len("FI_"):]: value
        for name, value in values.items()
        if name.startswith("FI_") and name[len("FI_"):] in FI_RUNTIME_ENVIRONMENT_NAMES
    }

_PLATFORM_TAGS = {"linux": "linux", "darwin": "macos", "win32": "win"}
_ARCH_TAGS = {"x86_64": "x64", "amd64": "x64", "arm64": "arm64", "aarch64": "arm64"}

_EXE_ACQUISITION_HINT = (
    "Two ways to get the executable: run `scripts/build-exe-for-python-sdk.ts` (via tsx) in a "
    "deepseek-harness checkout, or install the matching `deepseek-harness-runtime-bin` platform "
    "wheel retained by the `build-exe-for-python-sdk` CI workflow. For local development "
    "against a repo source build, explicitly select the dev-only node carrier with "
    f"{RUNTIME_MODE_ENV_VAR}=node (or resolve_bundled_launch_args('node'))."
)


def bundled_package_dir() -> Path:
    """Root directory of the installed runtime package data (the directory of this module)."""
    root = Path(__file__).resolve().parent
    metadata = root / PACKAGE_METADATA_FILENAME
    if not metadata.is_file():
        raise FileNotFoundError(f"deepseek-harness-runtime-bin is missing {metadata}")
    return root


def bundled_runtime_path() -> Path:
    """Absolute path of the bundled single-file runtime executable for the current platform.

    Raises FileNotFoundError when the platform is unsupported, the executable
    has not been placed into this package, the ripgrep or Office sidecar is
    missing, the authoring resources are incomplete, or the required macOS
    spawn helper is missing. Invalid authoring metadata or Python permissions
    raise ValueError. Missing executable/Office messages name
    the acquisition routes (acquisition strategy is deliberately separate from
    this lookup interface, so an on-demand download can replace it without
    touching callers).
    """
    tag = _current_platform_tag()
    extension = ".exe" if tag.startswith("win-") else ""
    path = bundled_package_dir() / "runtime" / f"deepseek-harness-sdk-runtime-{tag}{extension}"
    if not path.is_file():
        raise FileNotFoundError(
            f"deepseek-harness-runtime-bin is missing the runtime executable at {path}. "
            + _EXE_ACQUISITION_HINT
        )
    ripgrep = (
        path.with_name(f"{path.stem}-rg.exe")
        if tag.startswith("win-")
        else Path(f"{path}-rg")
    )
    if not ripgrep.is_file():
        raise FileNotFoundError(
            f"deepseek-harness-runtime-bin is missing the ripgrep sidecar at {ripgrep}. "
            + _EXE_ACQUISITION_HINT
        )
    if tag.startswith("macos-"):
        helper = Path(f"{path}-spawn-helper")
        if not helper.is_file():
            raise FileNotFoundError(
                f"deepseek-harness-runtime-bin is missing the node-pty spawn helper at {helper}. "
                + _EXE_ACQUISITION_HINT
            )
    office = path.with_name(f"{path.name.removesuffix('.exe')}-office")
    adapter = office / "node_modules/@deepseek-ai/libreoffice-kit/package.json"
    if not adapter.is_file():
        raise FileNotFoundError(
            f"deepseek-harness-runtime-bin is missing the Office sidecar at {office}. "
            + _EXE_ACQUISITION_HINT
        )
    native = tag.replace("win-", "win32-").replace("macos-", "darwin-")
    declared = json.loads(adapter.read_text(encoding="utf-8")).get("optionalDependencies", {})
    engine = native if f"@deepseek-ai/libreoffice-kit-{native}" in declared else "wasm"
    if not (office / "node_modules" / f"@deepseek-ai/libreoffice-kit-{engine}/prebuilds.json").is_file():
        raise FileNotFoundError(
            f"deepseek-harness-runtime-bin is missing the Office sidecar engine {engine} at {office}. "
            + _EXE_ACQUISITION_HINT
        )
    validate_resources(path.with_name(tag), tag)
    return path


def resolve_bundled_launch_args(mode: str | None = None) -> tuple[str, ...]:
    """The argv tuple that launches the bundled runtime.

    Mode selection: the explicit ``mode`` argument wins, then the
    ``DSH_RUNTIME_MODE`` environment variable (``exe`` | ``node``), then
    automatic resolution. Automatic resolution finds the production exe ONLY —
    the dev-only node carrier must be selected explicitly so a production
    deployment can never silently ride on a source build. Returns
    ``(exe_path,)`` in exe mode and ``(node_path, bin_js_path)`` in node mode;
    raises FileNotFoundError when the selected carrier is unavailable and
    ValueError for an unknown mode value.
    """
    environment = {**os.environ, **fi_environment_aliases(os.environ)}
    selected = mode if mode is not None else environment.get(RUNTIME_MODE_ENV_VAR)
    if selected is None or selected == "exe":
        return (str(bundled_runtime_path()),)
    if selected == "node":
        return _node_launch_args()
    raise ValueError(
        f"unsupported fi runtime mode {selected!r}: expected 'exe' or 'node' "
        "(explicit argument or $FI_RUNTIME_MODE)"
    )


def _current_platform_tag() -> str:
    plat = _PLATFORM_TAGS.get(sys.platform)
    arch = _ARCH_TAGS.get(platform.machine().lower())
    if (
        plat is None
        or arch is None
        or (plat == "win" and arch != "x64")
    ):
        raise FileNotFoundError(
            "no bundled fi SDK runtime exists for this platform "
            f"(sys.platform={sys.platform!r}, machine={platform.machine()!r}); supported: "
            "Linux x64/arm64, macOS x64/arm64, and Windows x64. " + _EXE_ACQUISITION_HINT
        )
    return f"{plat}-{arch}"


def _node_launch_args() -> tuple[str, str]:
    node_root = bundled_package_dir() / "runtime" / "node"
    bin_js = (
        node_root
        / "node_modules"
        / "@deepseek-ai"
        / "dsh"
        / "lib"
        / "bin.js"
    )
    if not bin_js.is_file():
        raise FileNotFoundError(
            f"the dev-only node runtime closure is missing at {node_root} "
            f"(no {bin_js}); run `scripts/build-exe-for-python-sdk.ts` in a deepseek-harness "
            "checkout, which builds and copies the deploy closure here. The node carrier "
            "is for repo-local development only — production uses the single-file exe."
        )
    node = shutil.which("node")
    if node is None:
        raise FileNotFoundError(
            "the node runtime mode needs a system `node` (>=22.19) on PATH; "
            "install Node.js or use the exe mode"
        )
    return (node, str(bin_js))


def main() -> None:
    """Launch the CLI with explicit FI_HOME or DSH_HOME; wait on Windows, replace the process on POSIX."""
    os.environ.update(fi_environment_aliases(os.environ))
    if not os.environ.get("DSH_HOME", "").strip():
        print(
            "fi-cli: the Python runtime command requires an explicit FI_HOME; "
            "it never uses ~/.fi implicitly",
            file=sys.stderr,
        )
        raise SystemExit(2)
    argv = (*resolve_bundled_launch_args(), *sys.argv[1:])
    if sys.platform == "win32":
        # Windows CRT exec does not replace the process; wait and preserve the runtime status.
        raise SystemExit(subprocess.run(argv, env=os.environ).returncode)
    os.execvpe(argv[0], argv, os.environ)


__all__ = [
    "PACKAGE_METADATA_FILENAME",
    "RUNTIME_MODE_ENV_VAR",
    "bundled_package_dir",
    "bundled_runtime_path",
    "FI_RUNTIME_ENVIRONMENT_NAMES",
    "fi_environment_aliases",
    "main",
    "resolve_bundled_launch_args",
]
