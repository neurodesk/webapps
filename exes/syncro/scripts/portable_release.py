#!/usr/bin/env python3
"""Build and verify SYNcro portable executable archives."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import pathlib
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass


ROOT = pathlib.Path(__file__).resolve().parents[3]
DIST = ROOT / "exes/syncro/dist"


@dataclass(frozen=True)
class ReleaseTarget:
    id: str
    version: str
    archive_name: str
    directory: str
    executable: str
    archive_kind: str
    node_version: str
    node_url: str
    node_sha256: str
    node_executable: str
    node_platform: str


def _read_json(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding="utf8"))


def load_target(repo: pathlib.Path, target_id: str) -> ReleaseTarget:
    package = _read_json(repo / "packages/syncro/package.json")
    app = _read_json(repo / "apps/syncro/package.json")
    release = _read_json(repo / "packages/syncro/release.json")
    runtimes = _read_json(repo / "exes/syncro/node-runtimes.json")
    if package["version"] != app["version"]:
        raise ValueError("SYNcro package and app versions differ")
    if target_id not in release["targets"] or target_id not in runtimes["targets"]:
        raise ValueError(f"unknown SYNcro release target: {target_id}")
    definition = release["targets"][target_id]
    runtime = runtimes["targets"][target_id]
    version = package["version"]
    archive_kind = definition["archive"]
    archive_name = f"syncro-{version}-{target_id}.{archive_kind}"
    if not all(character.isalnum() or character in ".-_" for character in archive_name):
        raise ValueError("release target produced an unsafe archive name")
    return ReleaseTarget(
        id=target_id,
        version=version,
        archive_name=archive_name,
        directory=f"syncro-{version}-{target_id}",
        executable=definition["executable"],
        archive_kind=archive_kind,
        node_version=runtimes["version"],
        node_url=runtime["url"],
        node_sha256=runtime["sha256"],
        node_executable=runtime["executable"],
        node_platform="win32" if target_id.startswith("windows-") else "linux",
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


def _assert_native_host(target: ReleaseTarget) -> None:
    host = "windows" if sys.platform == "win32" else "linux" if sys.platform.startswith("linux") else sys.platform
    machine = platform.machine().lower()
    if host not in target.id or machine not in ("x86_64", "amd64"):
        raise ValueError(f"{target.id} must be packaged on a matching x64 host, not {host}-{machine}")


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
    runtime = destination / "runtime"
    licenses = destination / "licenses/node"
    runtime.mkdir(parents=True)
    licenses.mkdir(parents=True)
    if target.archive_kind == "zip":
        with zipfile.ZipFile(archive) as source:
            executable = _archive_member(source.namelist(), target.node_executable)
            license_name = _archive_member(source.namelist(), "LICENSE")
            (runtime / "node.exe").write_bytes(source.read(executable))
            (licenses / "LICENSE").write_bytes(source.read(license_name))
    else:
        with tarfile.open(archive, "r:xz") as source:
            names = source.getnames()
            executable = source.extractfile(_archive_member(names, target.node_executable))
            license_file = source.extractfile(_archive_member(names, "LICENSE"))
            if executable is None or license_file is None:
                raise ValueError("Node archive entries are not regular files")
            (runtime / "node").write_bytes(executable.read())
            (licenses / "LICENSE").write_bytes(license_file.read())
            (runtime / "node").chmod(0o755)


def _deploy_application(stage: pathlib.Path) -> None:
    environment = os.environ.copy()
    environment["ONNXRUNTIME_NODE_INSTALL"] = "skip"
    environment["CI"] = "true"
    _run(["pnpm", "--filter", "@neurodesk/syncro", "run", "build"], env=environment)
    _run(
        ["pnpm", "--filter", "@neurodesk/syncro", "deploy", str(stage / "app"), "--prod", "--legacy"],
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


def _flatten_node_modules(app: pathlib.Path) -> None:
    source_root = app / "node_modules"
    flat_root = app / "node_modules.flat"
    packages = {}
    for container in (source_root / ".pnpm/node_modules", source_root):
        for relative, source in _package_entries(container):
            resolved = source.resolve()
            if resolved == app.resolve():
                continue
            package_json = resolved / "package.json"
            if package_json.is_file() and _read_json(package_json).get("name") == "@neurodesk/syncro":
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
    keep = runtime_root / target.node_platform / "x64"
    if not (keep / "onnxruntime_binding.node").is_file():
        raise ValueError(f"ONNX Runtime target binding is missing: {keep}")
    for platform_directory in runtime_root.iterdir():
        if platform_directory.name != target.node_platform:
            shutil.rmtree(platform_directory)
    for architecture in (runtime_root / target.node_platform).iterdir():
        if architecture.name != "x64":
            shutil.rmtree(architecture)
    if target.id == "linux-x64":
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
    _run(["cargo", "build", "--release", "--locked"], cwd=ROOT / "exes/syncro")
    suffix = ".exe" if target.id.startswith("windows-") else ""
    source = ROOT / f"exes/syncro/target/release/syncro-launcher{suffix}"
    shutil.copy2(source, destination / target.executable)
    if not suffix:
        (destination / target.executable).chmod(0o755)


def _write_readme(stage: pathlib.Path, target: ReleaseTarget) -> None:
    invocation = ".\\syncro.exe" if target.id.startswith("windows-") else "./syncro"
    text = f"""SYNcro {target.version} for {target.id}

Keep this directory intact. No system Node.js installation is required.

Check the installation:
  {invocation} self-check

Run normalization:
  {invocation} input.nii.gz results --threads 4

Models and the MNI template are included and checked locally.
No network connection or previously populated cache is required.

SYNcro is research software. Review the output alignment before use.
"""
    (stage / "README.txt").write_text(text, encoding="utf8")


def _normalized_mode(relative: pathlib.PurePath) -> int:
    return 0o755 if relative.as_posix() in ("syncro", "syncro.exe", "runtime/node", "runtime/node.exe") else 0o644


def _write_zip(stage: pathlib.Path, target: ReleaseTarget, archive: pathlib.Path) -> None:
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for source in sorted(path for path in stage.rglob("*") if path.is_file()):
            relative = pathlib.PurePosixPath(target.directory) / source.relative_to(stage).as_posix()
            info = zipfile.ZipInfo(relative.as_posix(), (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (_normalized_mode(relative.relative_to(target.directory)) & 0xFFFF) << 16
            output.writestr(info, source.read_bytes())


def _write_tar(stage: pathlib.Path, target: ReleaseTarget, archive: pathlib.Path) -> None:
    with archive.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as output:
            for source in sorted(path for path in stage.rglob("*") if path.is_file()):
                relative = pathlib.PurePosixPath(target.directory) / source.relative_to(stage).as_posix()
                info = tarfile.TarInfo(relative.as_posix())
                info.size = source.stat().st_size
                info.mode = _normalized_mode(relative.relative_to(target.directory))
                info.mtime = info.uid = info.gid = 0
                info.uname = info.gname = ""
                with source.open("rb") as contents:
                    output.addfile(info, contents)


def package_target(repo: pathlib.Path, target: ReleaseTarget) -> pathlib.Path:
    _assert_native_host(target)
    DIST.mkdir(parents=True, exist_ok=True)
    archive = DIST / target.archive_name
    with tempfile.TemporaryDirectory(prefix="syncro-portable-") as temporary:
        work = pathlib.Path(temporary)
        stage = work / target.directory
        stage.mkdir()
        _deploy_application(stage)
        _flatten_node_modules(stage / "app")
        _prune_onnx_runtime(stage / "app", target)
        runtime_archive = _download_runtime(target, work)
        _extract_node_files(runtime_archive, target, stage)
        private_node = stage / "runtime" / ("node.exe" if target.id.startswith("windows-") else "node")
        _run([str(private_node), str(stage / "app/bin/syncro.js"), "download-models", "--cache-dir", str(stage / "models")], cwd=stage)
        _build_launcher(stage, target)
        shutil.copy2(repo / "packages/syncro/LICENSE", stage / "LICENSE")
        shutil.copy2(repo / "packages/syncro/NOTICE", stage / "NOTICE")
        (stage / "licenses/onnxruntime").mkdir(parents=True)
        shutil.copy2(repo / "exes/syncro/licenses/onnxruntime-LICENSE", stage / "licenses/onnxruntime/LICENSE")
        _copy_dependency_licenses(stage / "app", stage / "licenses/npm")
        _write_readme(stage, target)
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
    with tempfile.TemporaryDirectory(prefix="syncro archive check ") as temporary:
        extracted = pathlib.Path(temporary)
        _extract_archive(archive, extracted)
        root = extracted / target.directory
        _verify_manifest(root, target)
        executable = root / target.executable
        self_check = _run([str(executable), "self-check"], cwd=extracted)
        report = json.loads(self_check.stdout)
        expected_runtime = (root / "runtime" / ("node.exe" if target.id.startswith("windows-") else "node")).resolve()
        if pathlib.Path(report["executable"]).resolve() != expected_runtime:
            raise ValueError("SYNcro used a Node runtime outside the extracted archive")
        if report["onnxRuntime"] != "1.29.0" or report["node"] != f"v{target.node_version}":
            raise ValueError("portable runtime version mismatch")
        package_check = _run(
            ["node", "packages/syncro/validation/package-check.mjs", "--executable", str(executable)],
            cwd=repo,
        )
    validation = archive.with_name(archive.name + ".validation.txt")
    validation.write_text(
        f"PASS {target.id}\narchive_sha256={expected}\nself_check={json.dumps(report, sort_keys=True)}\n{package_check.stdout}",
        encoding="utf8",
    )
    return validation


def verify_release_set(repo: pathlib.Path, directory: pathlib.Path) -> None:
    expected = set()
    for target_id in ("windows-x64", "linux-x64"):
        target = load_target(repo, target_id)
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
    parser.add_argument("value")
    arguments = parser.parse_args()
    if arguments.command == "verify-release-set":
        verify_release_set(ROOT, pathlib.Path(arguments.value))
        print("PASS complete SYNcro portable release set")
        return
    target = load_target(ROOT, arguments.value)
    result = package_target(ROOT, target) if arguments.command == "package" else verify_target(ROOT, target)
    print(result)


if __name__ == "__main__":
    main()
