#!/usr/bin/env python3
"""Build and verify portable SynthSR release archives."""

import argparse
from contextlib import contextmanager
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile

NATIVE_ROOT = Path(__file__).resolve().parent.parent
REPOSITORY_ROOT = NATIVE_ROOT.parent.parent
DOCUMENTS = ("README.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md")
PLATFORMS = {
    "linux-x64": {
        "executable": "synthsr",
        "library": "libwebgpu_dawn.so",
        "extension": ".tar.gz",
        "host": "linux",
        "target": "x86_64-linux",
    },
    "windows-x64": {
        "executable": "synthsr.exe",
        "library": "webgpu_dawn.dll",
        "extension": ".zip",
        "host": "win32",
        "target": "x86_64-windows",
    },
}
VERSION_PATTERN = re.compile(r"[0-9]+(?:\.[0-9A-Za-z_-]+)+")


def release_version(cargo_toml=NATIVE_ROOT / "Cargo.toml"):
    text = Path(cargo_toml).read_text(encoding="utf-8")
    package = text.split("[package]", 1)[1].split("[", 1)[0]
    match = re.search(r'^version\s*=\s*"([^"]+)"\s*$', package, re.MULTILINE)
    if not match or not VERSION_PATTERN.fullmatch(match.group(1)):
        raise ValueError("Cargo package version is missing or invalid")
    return match.group(1)


def archive_name(platform, version):
    if platform not in PLATFORMS:
        raise ValueError(f"unsupported platform: {platform}")
    if not VERSION_PATTERN.fullmatch(version):
        raise ValueError(f"invalid release version: {version!r}")
    return f"synthsr-{version}-{platform}{PLATFORMS[platform]['extension']}"


def _payload(platform, target_dir, documents_dir):
    spec = PLATFORMS[platform]
    files = [
        (spec["executable"], Path(target_dir) / spec["executable"]),
        (spec["library"], Path(target_dir) / spec["library"]),
        *((name, Path(documents_dir) / name) for name in DOCUMENTS),
    ]
    missing = [str(path) for _, path in files if not path.is_file()]
    if missing:
        raise FileNotFoundError("missing release payload: " + ", ".join(missing))
    return files


def _tar_archive(path, files, executable):
    partial = path.with_name(path.name + ".partial")
    with partial.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.GNU_FORMAT) as archive:
                for name, source in files:
                    info = tarfile.TarInfo(name)
                    info.size = source.stat().st_size
                    info.mode = 0o755 if name in (executable, "libwebgpu_dawn.so") else 0o644
                    info.mtime = info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    with source.open("rb") as stream:
                        archive.addfile(info, stream)
    partial.replace(path)


def _zip_archive(path, files, executable):
    partial = path.with_name(path.name + ".partial")
    with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, source in files:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            mode = 0o755 if name == executable else 0o644
            info.external_attr = mode << 16
            with source.open("rb") as source_stream, archive.open(info, "w") as output:
                shutil.copyfileobj(source_stream, output)
    partial.replace(path)


def build_archive(platform, version, target_dir, documents_dir, dist_dir):
    spec = PLATFORMS[platform]
    dist_dir = Path(dist_dir)
    dist_dir.mkdir(parents=True, exist_ok=True)
    archive = dist_dir / archive_name(platform, version)
    files = _payload(platform, target_dir, documents_dir)
    if spec["extension"] == ".tar.gz":
        _tar_archive(archive, files, spec["executable"])
    else:
        _zip_archive(archive, files, spec["executable"])
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_name(archive.name + ".sha256").write_bytes(
        f"{digest}  {archive.name}\n".encode("utf-8")
    )
    archive.chmod(0o644)
    archive.with_name(archive.name + ".sha256").chmod(0o644)
    return archive


def _extract_checked(platform, archive, destination):
    expected = {
        PLATFORMS[platform]["executable"],
        PLATFORMS[platform]["library"],
        *DOCUMENTS,
    }
    if platform == "linux-x64":
        with tarfile.open(archive, "r:gz") as bundle:
            members = bundle.getmembers()
            names = {member.name for member in members}
            if names != expected or any(not member.isfile() for member in members):
                raise ValueError(f"unexpected archive contents: {sorted(names)}")
            for member in members:
                source = bundle.extractfile(member)
                target = destination / member.name
                with target.open("wb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(member.mode)
    else:
        with zipfile.ZipFile(archive) as bundle:
            names = set(bundle.namelist())
            if names != expected or any(name.endswith("/") for name in names):
                raise ValueError(f"unexpected archive contents: {sorted(names)}")
            for name in names:
                with bundle.open(name) as source, (destination / name).open("wb") as output:
                    shutil.copyfileobj(source, output)


@contextmanager
def package_directory():
    directory = tempfile.TemporaryDirectory(prefix="synthsr package ")
    try:
        yield Path(directory.name)
    finally:
        for attempt in range(6):
            try:
                directory.cleanup()
                break
            except PermissionError as error:
                if getattr(error, "winerror", None) != 32 or attempt == 5:
                    raise
                time.sleep(0.1 * 2 ** attempt)


def verify_archive(platform, archive, fixture=REPOSITORY_ROOT / "apps/synthsr/test/fixtures/validation.nii.gz"):
    spec = PLATFORMS[platform]
    archive = Path(archive)
    checksum = archive.with_name(archive.name + ".sha256")
    checksum_fields = checksum.read_text(encoding="utf-8").split()
    if len(checksum_fields) != 2 or checksum_fields[1] != archive.name:
        raise ValueError("checksum file names a different archive")
    expected_digest = checksum_fields[0]
    actual_digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if actual_digest != expected_digest:
        raise ValueError("archive checksum does not match")
    if sys.platform != spec["host"]:
        raise RuntimeError(f"verify {platform} on its native runner")

    with package_directory() as extracted:
        _extract_checked(platform, archive, extracted)
        executable = extracted / spec["executable"]
        executable.chmod(0o755)
        environment = os.environ.copy()
        environment.pop("LD_LIBRARY_PATH", None)
        self_check = subprocess.run(
            [str(executable), "--self-check"], capture_output=True, text=True, check=True,
            cwd=extracted, env=environment,
        )
        version = release_version()
        for value in [f"synthsr {version}", f"target: {spec['target']}", "cpu: ok"]:
            if value not in self_check.stdout:
                raise ValueError(f"self-check did not report {value!r}")

        output = extracted / "validation-output.nii.gz"
        inference = subprocess.run(
            [str(executable), str(fixture), str(output), "--threads", "2", "--quiet"],
            capture_output=True,
            text=True,
            check=True,
            cwd=extracted,
            env=environment,
        )
        report = json.loads((extracted / "validation-output.json").read_text(encoding="utf-8"))
        if not output.is_file() or report.get("executionProvider") != "cpu" or report.get("threads") != 2:
            raise ValueError("packaged CPU inference did not produce the expected output and report")

    validation = archive.with_name(archive.name + ".validation.txt")
    validation.write_text(
        f"archive: {archive.name}\nsha256: {actual_digest}\n"
        f"extracted package: ok\npackaged CPU inference: ok\n\n{self_check.stdout}{inference.stdout}",
        encoding="utf-8",
    )
    validation.chmod(0o644)
    return validation


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("package", "verify"))
    parser.add_argument("platform", choices=tuple(PLATFORMS))
    args = parser.parse_args()
    version = release_version()
    archive = NATIVE_ROOT / "dist" / archive_name(args.platform, version)
    if args.action == "package":
        archive = build_archive(
            args.platform, version, NATIVE_ROOT / "target/release", NATIVE_ROOT, NATIVE_ROOT / "dist"
        )
        print(archive)
    else:
        print(verify_archive(args.platform, archive))


if __name__ == "__main__":
    main()
