#!/usr/bin/env python3
"""Build and verify portable archives of a Node command-line package.

The package directory supplies package.json (name, version, the single bin
entry and dependencies) and release.json (display name, linked app, run
arguments, README text, validation script and release targets).
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass


ROOT = pathlib.Path(__file__).resolve().parents[3]
HERE = ROOT / "exes/node-cli"
DIST = HERE / "dist"
NODE_PLATFORMS = {"linux": "linux", "windows": "win32", "macos": "darwin"}


@dataclass(frozen=True)
class ReleaseTarget:
    id: str
    tool: str
    package: str
    package_dir: pathlib.Path
    display_name: str
    version: str
    archive_name: str
    directory: str
    executable: str
    archive_kind: str
    run: str
    readme_run: str
    readme_notes: tuple[str, ...]
    validation: pathlib.Path
    onnx_runtime: str
    build: bool
    node_version: str
    node_url: str
    node_sha256: str
    node_executable: str
    node_platform: str
    node_arch: str

    @property
    def windows(self) -> bool:
        return self.node_platform == "win32"

    @property
    def private_node(self) -> str:
        return "runtime/node.exe" if self.windows else "runtime/node"


def _read_json(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding="utf8"))


def load_target(repo: pathlib.Path, package_dir: str, target_id: str) -> ReleaseTarget:
    directory = (repo / package_dir).resolve()
    package = _read_json(directory / "package.json")
    release = _read_json(directory / "release.json")
    app = _read_json(repo / "apps" / release["app"] / "package.json")
    runtimes = _read_json(HERE / "node-runtimes.json")
    if package["version"] != app["version"]:
        raise ValueError(f"{package['name']} and app {release['app']} versions differ")
    if len(package.get("bin", {})) != 1:
        raise ValueError(f"{package['name']} must declare exactly one bin entry")
    [(tool, entry)] = package["bin"].items()
    if pathlib.PurePosixPath(entry) != pathlib.PurePosixPath("bin", f"{tool}.js"):
        raise ValueError(f"{package['name']} bin must be bin/{tool}.js for the launcher")
    if target_id not in release["targets"] or target_id not in runtimes["targets"]:
        raise ValueError(f"unknown {tool} release target: {target_id}")
    definition = release["targets"][target_id]
    runtime = runtimes["targets"][target_id]
    if pathlib.PurePath(definition["executable"]).stem != tool:
        raise ValueError(f"{target_id} executable must be named after {tool}")
    system, architecture = target_id.split("-", 1)
    version = package["version"]
    archive_kind = definition["archive"]
    archive_name = f"{tool}-{version}-{target_id}.{archive_kind}"
    if not all(character.isalnum() or character in ".-_" for character in archive_name):
        raise ValueError("release target produced an unsafe archive name")
    return ReleaseTarget(
        id=target_id,
        tool=tool,
        package=package["name"],
        package_dir=directory,
        display_name=release["displayName"],
        version=version,
        archive_name=archive_name,
        directory=f"{tool}-{version}-{target_id}",
        executable=definition["executable"],
        archive_kind=archive_kind,
        run=release["run"],
        readme_run=release["readme"]["run"],
        readme_notes=tuple(release["readme"]["notes"]),
        validation=directory / release["validation"],
        onnx_runtime=package["dependencies"]["onnxruntime-node"],
        build="build" in package.get("scripts", {}),
        node_version=runtimes["version"],
        node_url=runtime["url"],
        node_sha256=runtime["sha256"],
        node_executable=runtime["executable"],
        node_platform=NODE_PLATFORMS[system],
        node_arch=architecture,
    )


def _sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def create_manifest(root: pathlib.Path, version: str, target: str) -> dict:
    files = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"portable archives cannot contain a symlink: {path}")
        if path.is_file() and path.name != "manifest.json":
            relative = path.relative_to(root).as_posix()
            if relative.startswith("../") or relative.startswith("/"):
                raise ValueError(f"archive path escapes its root: {relative}")
            files.append({"path": relative, "bytes": path.stat().st_size, "sha256": _sha256(path)})
    return {"schema": 1, "version": version, "target": target, "files": files}


def _run(command: list[str], *, cwd: pathlib.Path = ROOT, env: dict | None = None) -> subprocess.CompletedProcess:
    path = (env or os.environ).get("PATH")
    executable = shutil.which(command[0], path=path)
    if executable is None:
        raise FileNotFoundError(f"required executable is not on PATH: {command[0]}")
    resolved = [executable, *command[1:]]
    return subprocess.run(resolved, cwd=cwd, env=env, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


def _host() -> str:
    system = {"win32": "windows", "darwin": "macos"}.get(sys.platform, "linux" if sys.platform.startswith("linux") else sys.platform)
    machine = platform.machine().lower()
    architecture = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64"}.get(machine, machine)
    return f"{system}-{architecture}"


def _assert_native_host(target: ReleaseTarget) -> None:
    host = _host()
    if host != target.id:
        raise ValueError(f"{target.id} must be packaged on a matching host, not {host}")


def _download_runtime(target: ReleaseTarget, destination: pathlib.Path) -> pathlib.Path:
    archive = destination / pathlib.PurePosixPath(target.node_url).name
    with urllib.request.urlopen(target.node_url) as response, archive.open("wb") as output:
        shutil.copyfileobj(response, output)
    actual = _sha256(archive)
    if actual != target.node_sha256:
        raise ValueError(f"Node {target.node_version} checksum mismatch: {actual}")
    return archive


def _archive_member(names: list[str], suffix: str) -> str:
    matches = [name for name in names if name == suffix or name.endswith("/" + suffix)]
    if matches:
        depth = min(name.count("/") for name in matches)
        matches = [name for name in matches if name.count("/") == depth]
    if len(matches) != 1:
        raise ValueError(f"Node archive must contain one top-level {suffix}; found {len(matches)}")
    return matches[0]


def _extract_node_files(archive: pathlib.Path, target: ReleaseTarget, destination: pathlib.Path) -> None:
    node = destination / target.private_node
    licenses = destination / "licenses/node"
    node.parent.mkdir(parents=True)
    licenses.mkdir(parents=True)
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as source:
            executable = _archive_member(source.namelist(), target.node_executable)
            license_name = _archive_member(source.namelist(), "LICENSE")
            node.write_bytes(source.read(executable))
            (licenses / "LICENSE").write_bytes(source.read(license_name))
    else:
        with tarfile.open(archive, "r:*") as source:
            names = source.getnames()
            executable = source.extractfile(_archive_member(names, target.node_executable))
            license_file = source.extractfile(_archive_member(names, "LICENSE"))
            if executable is None or license_file is None:
                raise ValueError("Node archive entries are not regular files")
            node.write_bytes(executable.read())
            (licenses / "LICENSE").write_bytes(license_file.read())
    if not target.windows:
        node.chmod(0o755)


def _deploy_application(stage: pathlib.Path, target: ReleaseTarget) -> None:
    environment = os.environ.copy()
    environment["ONNXRUNTIME_NODE_INSTALL"] = "skip"
    environment["CI"] = "true"
    if target.build:
        _run(["pnpm", "--filter", target.package, "run", "build"], env=environment)
    _run(
        ["pnpm", "--filter", target.package, "deploy", str(stage / "app"), "--prod", "--legacy"],
        env=environment,
    )


def _package_entries(container: pathlib.Path):
    if not container.is_dir():
        return
    for entry in sorted(container.iterdir()):
        if entry.name.startswith("."):
            continue
        if entry.name.startswith("@") and entry.is_dir():
            for package in sorted(entry.iterdir()):
                yield pathlib.PurePosixPath(entry.name, package.name), package
        else:
            yield pathlib.PurePosixPath(entry.name), entry


def _flatten_node_modules(app: pathlib.Path, package_name: str) -> None:
    source_root = app / "node_modules"
    flat_root = app / "node_modules.flat"
    packages = {}
    for container in (source_root / ".pnpm/node_modules", source_root):
        for relative, source in _package_entries(container):
            resolved = source.resolve()
            if resolved == app.resolve():
                continue
            package_json = resolved / "package.json"
            if package_json.is_file() and _read_json(package_json).get("name") == package_name:
                continue
            packages[relative] = resolved
    for relative, source in packages.items():
        destination = flat_root.joinpath(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, destination, symlinks=False)
        else:
            shutil.copy2(source, destination)
    shutil.rmtree(source_root)
    flat_root.rename(source_root)
    for command_directory in sorted(source_root.rglob(".bin"), reverse=True):
        if command_directory.is_dir():
            shutil.rmtree(command_directory)


def _prune_onnx_runtime(app: pathlib.Path, target: ReleaseTarget) -> None:
    runtime_root = app / "node_modules/onnxruntime-node/bin/napi-v6"
    keep = runtime_root / target.node_platform / target.node_arch
    if not (keep / "onnxruntime_binding.node").is_file():
        raise ValueError(f"ONNX Runtime target binding is missing: {keep}")
    for platform_directory in runtime_root.iterdir():
        if platform_directory.name != target.node_platform:
            shutil.rmtree(platform_directory)
    for architecture in (runtime_root / target.node_platform).iterdir():
        if architecture.name != target.node_arch:
            shutil.rmtree(architecture)
    if target.node_platform == "linux":
        for name in ("libonnxruntime_providers_cuda.so", "libonnxruntime_providers_tensorrt.so"):
            path = keep / name
            if path.exists():
                path.unlink()
    foreign = [path for path in runtime_root.rglob("onnxruntime_binding.node") if path.parent != keep]
    if foreign:
        raise ValueError(f"foreign ONNX Runtime bindings remain: {foreign}")


def _copy_dependency_licenses(app: pathlib.Path, destination: pathlib.Path) -> None:
    notices = []
    for package_json in sorted((app / "node_modules").rglob("package.json")):
        if ".bin" in package_json.parts:
            continue
        package_root = package_json.parent
        metadata = _read_json(package_json)
        name = metadata.get("name", package_root.name)
        version = metadata.get("version", "unknown")
        license_name = metadata.get("license", "see package metadata")
        notices.append(f"{name} {version}: {license_name}")
        relative = package_root.relative_to(app / "node_modules")
        safe = "__".join(relative.parts)
        files = [path for path in package_root.iterdir() if path.is_file() and path.name.upper().startswith(("LICENSE", "LICENCE", "NOTICE"))]
        for source in files:
            target = destination / safe / source.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "THIRD_PARTY.txt").write_text("\n".join(notices) + "\n", encoding="utf8")


def _build_launcher(destination: pathlib.Path, target: ReleaseTarget) -> None:
    _run(["cargo", "build", "--release", "--locked"], cwd=HERE)
    suffix = ".exe" if target.windows else ""
    source = HERE / f"target/release/node-cli-launcher{suffix}"
    shutil.copy2(source, destination / target.executable)
    if not suffix:
        (destination / target.executable).chmod(0o755)


def readme_text(target: ReleaseTarget) -> str:
    invocation = f".\\{target.executable}" if target.windows else f"./{target.executable}"
    quarantine = ""
    if target.node_platform == "darwin":
        quarantine = (
            "\nIf macOS refuses to open a program in a browser-downloaded archive,\n"
            f"remove the quarantine flag from the extracted directory:\n  xattr -dr com.apple.quarantine {target.directory}\n"
        )
    notes = "\n".join(target.readme_notes)
    return f"""{target.display_name} {target.version} for {target.id}

Keep this directory intact. No system Node.js installation is required.
{quarantine}
Check the installation:
  {invocation} self-check

{target.readme_run}:
  {invocation} {target.run}

{notes}
"""


def _normalized_mode(relative: pathlib.PurePath, target: ReleaseTarget) -> int:
    return 0o755 if relative.as_posix() in (target.executable, target.private_node) else 0o644


def _write_zip(stage: pathlib.Path, target: ReleaseTarget, archive: pathlib.Path) -> None:
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for source in sorted(path for path in stage.rglob("*") if path.is_file()):
            relative = pathlib.PurePosixPath(target.directory) / source.relative_to(stage).as_posix()
            info = zipfile.ZipInfo(relative.as_posix(), (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (_normalized_mode(relative.relative_to(target.directory), target) & 0xFFFF) << 16
            output.writestr(info, source.read_bytes())


def _write_tar(stage: pathlib.Path, target: ReleaseTarget, archive: pathlib.Path) -> None:
    with archive.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as output:
            for source in sorted(path for path in stage.rglob("*") if path.is_file()):
                relative = pathlib.PurePosixPath(target.directory) / source.relative_to(stage).as_posix()
                info = tarfile.TarInfo(relative.as_posix())
                info.size = source.stat().st_size
                info.mode = _normalized_mode(relative.relative_to(target.directory), target)
                info.mtime = info.uid = info.gid = 0
                info.uname = info.gname = ""
                with source.open("rb") as contents:
                    output.addfile(info, contents)


def package_target(target: ReleaseTarget) -> pathlib.Path:
    _assert_native_host(target)
    DIST.mkdir(parents=True, exist_ok=True)
    archive = DIST / target.archive_name
    with tempfile.TemporaryDirectory(prefix=f"{target.tool}-portable-") as temporary:
        work = pathlib.Path(temporary)
        stage = work / target.directory
        stage.mkdir()
        _deploy_application(stage, target)
        _flatten_node_modules(stage / "app", target.package)
        _prune_onnx_runtime(stage / "app", target)
        runtime_archive = _download_runtime(target, work)
        _extract_node_files(runtime_archive, target, stage)
        entry = stage / "app/bin" / f"{target.tool}.js"
        _run([str(stage / target.private_node), str(entry), "download-models", "--cache-dir", str(stage / "models")], cwd=stage)
        _build_launcher(stage, target)
        shutil.copy2(target.package_dir / "LICENSE", stage / "LICENSE")
        shutil.copy2(target.package_dir / "NOTICE", stage / "NOTICE")
        (stage / "licenses/onnxruntime").mkdir(parents=True)
        shutil.copy2(HERE / "licenses/onnxruntime-LICENSE", stage / "licenses/onnxruntime/LICENSE")
        _copy_dependency_licenses(stage / "app", stage / "licenses/npm")
        (stage / "README.txt").write_text(readme_text(target), encoding="utf8")
        manifest = create_manifest(stage, target.version, target.id)
        (stage / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf8")
        if target.archive_kind == "zip":
            _write_zip(stage, target, archive)
        else:
            _write_tar(stage, target, archive)
    checksum = _sha256(archive)
    archive.with_name(archive.name + ".sha256").write_text(f"{checksum}  {archive.name}\n", encoding="ascii")
    return archive


def _safe_archive_path(name: str) -> pathlib.PurePosixPath:
    path = pathlib.PurePosixPath(name.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"unsafe archive path: {name}")
    return path


def _extract_archive(archive: pathlib.Path, destination: pathlib.Path) -> None:
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as source:
            for member in source.infolist():
                path = _safe_archive_path(member.filename)
                if member.is_dir():
                    continue
                target = destination.joinpath(*path.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read(member))
                target.chmod((member.external_attr >> 16) & 0o777 or 0o644)
    else:
        with tarfile.open(archive, "r:gz") as source:
            for member in source.getmembers():
                path = _safe_archive_path(member.name)
                if not member.isfile():
                    raise ValueError(f"portable archive contains a non-file entry: {member.name}")
                contents = source.extractfile(member)
                if contents is None:
                    raise ValueError(f"cannot read archive entry: {member.name}")
                target = destination.joinpath(*path.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(contents.read())
                target.chmod(member.mode)


def _verify_manifest(root: pathlib.Path, target: ReleaseTarget) -> None:
    manifest = _read_json(root / "manifest.json")
    if manifest["version"] != target.version or manifest["target"] != target.id:
        raise ValueError("portable manifest identity mismatch")
    recorded = {entry["path"]: entry for entry in manifest["files"]}
    actual = create_manifest(root, target.version, target.id)["files"]
    if [entry["path"] for entry in actual] != list(recorded):
        raise ValueError("portable manifest file list mismatch")
    for entry in actual:
        if entry != recorded[entry["path"]]:
            raise ValueError(f"portable manifest checksum mismatch: {entry['path']}")


def verify_target(repo: pathlib.Path, target: ReleaseTarget) -> pathlib.Path:
    _assert_native_host(target)
    archive = DIST / target.archive_name
    checksum_file = archive.with_name(archive.name + ".sha256")
    expected = checksum_file.read_text(encoding="ascii").split()[0]
    if _sha256(archive) != expected:
        raise ValueError("portable archive checksum mismatch")
    with tempfile.TemporaryDirectory(prefix=f"{target.tool} archive check ") as temporary:
        extracted = pathlib.Path(temporary)
        _extract_archive(archive, extracted)
        root = extracted / target.directory
        _verify_manifest(root, target)
        executable = root / target.executable
        self_check = _run([str(executable), "self-check"], cwd=extracted)
        report = json.loads(self_check.stdout)
        expected_runtime = (root / target.private_node).resolve()
        if pathlib.Path(report["executable"]).resolve() != expected_runtime:
            raise ValueError(f"{target.tool} used a Node runtime outside the extracted archive")
        if report["onnxRuntime"] != target.onnx_runtime or report["node"] != f"v{target.node_version}":
            raise ValueError("portable runtime version mismatch")
        validation = _run(["node", str(target.validation), "--executable", str(executable)], cwd=repo)
    receipt = archive.with_name(archive.name + ".validation.txt")
    receipt.write_text(
        f"PASS {target.id}\narchive_sha256={expected}\nself_check={json.dumps(report, sort_keys=True)}\n{validation.stdout}",
        encoding="utf8",
    )
    return receipt


def verify_release_set(repo: pathlib.Path, package_dir: str, directory: pathlib.Path) -> None:
    release = _read_json(repo / package_dir / "release.json")
    expected = set()
    for target_id in release["targets"]:
        target = load_target(repo, package_dir, target_id)
        expected.update((target.archive_name, target.archive_name + ".sha256", target.archive_name + ".validation.txt"))
        archive = directory / target.archive_name
        checksum = (directory / (target.archive_name + ".sha256")).read_text(encoding="ascii").split()[0]
        if _sha256(archive) != checksum:
            raise ValueError(f"release checksum mismatch: {target.archive_name}")
        if not (directory / (target.archive_name + ".validation.txt")).read_text(encoding="utf8").startswith(f"PASS {target.id}\n"):
            raise ValueError(f"release validation receipt is missing: {target.id}")
    present = {path.name for path in directory.iterdir() if path.is_file()}
    if present != expected:
        raise ValueError(f"release asset set differs: expected {sorted(expected)}, found {sorted(present)}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("package", "verify", "verify-release-set"))
    parser.add_argument("package_dir", help="package directory, for example packages/topofit")
    parser.add_argument("value", help="release target, or the release asset directory for verify-release-set")
    arguments = parser.parse_args()
    if arguments.command == "verify-release-set":
        verify_release_set(ROOT, arguments.package_dir, pathlib.Path(arguments.value))
        print(f"PASS complete portable release set for {arguments.package_dir}")
        return
    target = load_target(ROOT, arguments.package_dir, arguments.value)
    result = package_target(target) if arguments.command == "package" else verify_target(ROOT, target)
    print(result)


if __name__ == "__main__":
    main()
