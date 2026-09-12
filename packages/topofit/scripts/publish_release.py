#!/usr/bin/env python3
"""Publish one validated TopoFit release directory to the Neurodesk dataset."""

import argparse
from pathlib import Path

from huggingface_hub import HfApi


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--repo", default="neurodeskorg/webapps")
    parser.add_argument("--path", default="topofit/0.5.1/onnx-20260911")
    args = parser.parse_args()
    if not (args.directory / "conversion-report.json").is_file():
        raise FileNotFoundError("Validated conversion-report.json is required.")
    api = HfApi()
    api.create_repo(args.repo, repo_type="dataset", exist_ok=True)
    commit = api.upload_folder(
        folder_path=args.directory,
        path_in_repo=args.path,
        repo_id=args.repo,
        repo_type="dataset",
        commit_message="Publish TopoFit 0.5.1 ONNX browser assets and parity evidence",
    )
    print(commit.oid)


if __name__ == "__main__":
    main()
