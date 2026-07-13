#!/bin/bash
# Download Pyodide and required wheels for offline Electron app

set -e

PYODIDE_VERSION="0.27.0"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DICOMPARE_VERSION=$(sed -n "s/.*DICOMPARE_VERSION = '\([^']*\)'.*/\1/p" "$SCRIPT_DIR/../src/version.ts")
DEST_DIR="public/pyodide"

echo "📦 Setting up offline Pyodide for Electron..."
echo "   Pyodide version: $PYODIDE_VERSION"
echo "   Destination: $DEST_DIR"

# Create destination directory
mkdir -p "$DEST_DIR/wheels"

# Download Pyodide core files
echo ""
echo "⬇️  Downloading Pyodide core..."
PYODIDE_BASE="https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full"

CORE_FILES=(
    "pyodide.js"
    "pyodide.asm.js"
    "pyodide.asm.wasm"
    "python_stdlib.zip"
    "pyodide-lock.json"
)

# Get file size cross-platform
get_file_size() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        stat -f%z "$1" 2>/dev/null || echo 0
    else
        stat -c%s "$1" 2>/dev/null || wc -c < "$1" 2>/dev/null || echo 0
    fi
}

for file in "${CORE_FILES[@]}"; do
    if [ ! -f "$DEST_DIR/$file" ] || [ $(get_file_size "$DEST_DIR/$file") -lt 1000 ]; then
        echo "   Downloading $file..."
        curl -sL "$PYODIDE_BASE/$file" -o "$DEST_DIR/$file"
    else
        echo "   $file already exists, skipping"
    fi
done

# Use Python to extract package info from lock file and download
echo ""
echo "⬇️  Downloading Pyodide built-in packages..."

# Set UTF-8 encoding for Windows compatibility
export PYTHONIOENCODING=utf-8

python3 << 'PYTHON_SCRIPT'
import json
import subprocess
import os

DEST_DIR = "public/pyodide"
PYODIDE_BASE = "https://cdn.jsdelivr.net/pyodide/v0.27.0/full"

# Packages we need from Pyodide's built-in packages
# Include all transitive dependencies for nibabel, scipy, etc.
NEEDED_PACKAGES = [
    "micropip",
    "packaging",
    "sqlite3",
    "numpy",
    "pandas",
    "scipy",
    "jsonschema",
    "tqdm",
    "python-dateutil",
    "pytz",
    "six",
    "attrs",
    "referencing",
    "jsonschema-specifications",
    "rpds-py",
    # Additional dependencies for nibabel/scipy
    "typing-extensions",
    "openblas",
    "pillow",
    "contourpy",
    "cycler",
    "fonttools",
    "kiwisolver",
    "matplotlib",
    "matplotlib-pyodide",
    "pyparsing",
    "setuptools",
    "pyrsistent",
]

# Load lock file
with open(f"{DEST_DIR}/pyodide-lock.json") as f:
    lock_data = json.load(f)

packages = lock_data.get("packages", {})

for pkg_name in NEEDED_PACKAGES:
    # Try exact name and normalized name
    pkg_info = packages.get(pkg_name) or packages.get(pkg_name.replace("-", "_"))
    if not pkg_info:
        print(f"   Warning: {pkg_name} not found in lock file")
        continue

    file_name = pkg_info["file_name"]
    dest_path = f"{DEST_DIR}/{file_name}"

    # Check if file exists and is valid (not a 404 page)
    if os.path.exists(dest_path):
        size = os.path.getsize(dest_path)
        if size > 1000:
            print(f"   {file_name} already exists ({size} bytes), skipping")
            continue
        else:
            print(f"   {file_name} invalid ({size} bytes), re-downloading")

    url = f"{PYODIDE_BASE}/{file_name}"
    print(f"   Downloading {file_name}...")
    result = subprocess.run(["curl", "-sL", url, "-o", dest_path], capture_output=True)
    if result.returncode != 0:
        print(f"   Warning: Failed to download {file_name}")

print("\n[OK] Pyodide packages downloaded")
PYTHON_SCRIPT

# Download pure Python wheels from PyPI that aren't in Pyodide
echo ""
echo "⬇️  Downloading PyPI wheels for packages not in Pyodide..."

# These are pure Python packages that work with micropip
PYPI_WHEELS=(
    "pydicom==2.4.4"
    "tabulate"
    "nibabel"
    "dicompare==$DICOMPARE_VERSION"
    "twixtools"
)

# Use pip to download wheels
for pkg in "${PYPI_WHEELS[@]}"; do
    echo "   Downloading $pkg..."
    pip download --only-binary=:all: --no-deps --python-version 312 --platform any \
        -d "$DEST_DIR/wheels" "$pkg" 2>/dev/null || \
    pip download --no-deps -d "$DEST_DIR/wheels" "$pkg" 2>/dev/null || \
    echo "   Warning: Could not download $pkg"
done

echo ""
echo "📋 Downloaded Pyodide core files:"
ls -lh "$DEST_DIR"/*.{js,wasm,zip,json} 2>/dev/null | awk '{print "   " $9 " (" $5 ")"}'

echo ""
echo "📋 Downloaded Pyodide packages:"
ls -lh "$DEST_DIR"/*.whl 2>/dev/null | awk '{print "   " $9 " (" $5 ")"}'

echo ""
echo "📋 Downloaded PyPI wheels:"
ls -lh "$DEST_DIR/wheels"/*.whl 2>/dev/null | awk '{print "   " $9 " (" $5 ")"}'

echo ""
echo "✅ Pyodide offline setup complete!"
echo ""
echo "Total size:"
du -sh "$DEST_DIR"
