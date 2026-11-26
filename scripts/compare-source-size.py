#!/usr/bin/env python3
"""Vergleicht die gepflegten Produktquellen zweier Git-Revisionen mit cloc."""

import argparse
from collections import Counter
import json
from pathlib import Path
import re
import subprocess
import tempfile


EXCLUDED_DIRECTORIES = {
    "scripts", "scripts-archive", "examples", "tests", "test", "testing", "fixtures",
    "node_modules", "generated", "vendor", "dist", "build",
}
EXCLUDED_PATH = re.compile(r"\.(test|spec|generated)\.|_tests[./]")
LANGUAGES = "TypeScript,Rust,JavaScript,CSS,HTML,SQL"


def product_paths(repository, commit):
    tree = subprocess.check_output(["git", "ls-tree", "-rz", commit], cwd=repository)
    paths = []

    for entry in tree.decode().split("\0"):
        if not entry:
            continue

        metadata, name = entry.split("\t", 1)
        mode, _, _ = metadata.split(" ")
        package, *rest = name.split("/")

        if not rest or not package.startswith("sortsys-") or package == "sortsys-v2-job_runner":
            continue

        if mode not in {"100644", "100755"} or EXCLUDED_PATH.search(name):
            continue

        if EXCLUDED_DIRECTORIES.intersection(rest[:-1]):
            continue

        if "\n" in name or "\r" in name:
            raise ValueError(f"cloc kann den Pfad nicht aus einer Dateiliste lesen: {name!r}")

        paths.append(name)

    return paths


def count_sources(repository, revision):
    commit = subprocess.check_output(
        ["git", "rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}"],
        cwd=repository, text=True,
    ).strip()
    paths = product_paths(repository, commit)
    files, lines = Counter(), Counter()
    if not paths:
        return commit, files, lines

    with tempfile.TemporaryDirectory(prefix="sortsys-source-size-") as temporary:
        directory = Path(temporary).resolve()
        names = directory / "paths.txt"
        names.write_text("\n".join(paths) + "\n", encoding="utf-8")
        archive = directory / "sources.tar"

        subprocess.run(
            ["git", "archive", "--output", archive, commit, "--", *paths],
            cwd=repository, check=True,
        )
        subprocess.run(["tar", "-xf", archive], cwd=directory, check=True)
        result = subprocess.check_output([
            "cloc", "--quiet", "--timeout=0", "--skip-uniqueness", "--json", "--by-file",
            "--fullpath", f"--include-lang={LANGUAGES}", f"--list-file={names}",
        ], cwd=directory)

        for name, value in json.loads(result).items():
            if name in {"header", "SUM"}:
                continue

            path = Path(name)
            relative = path.relative_to(directory) if path.is_absolute() else path
            package = relative.parts[0]
            files[package] += 1
            lines[package] += value["code"]

    return commit, files, lines


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base", help="Git-Revision des Ausgangsstands")
    parser.add_argument("current", nargs="?", default="HEAD", help="Git-Revision zum Vergleich")
    args = parser.parse_args()
    repository = Path(__file__).resolve().parent.parent

    base, before_files, before_lines = count_sources(repository, args.base)
    revision, after_files, after_lines = count_sources(repository, args.current)

    print(f"Ausgangsstand: {base}\nVergleich:    {revision}")
    print("Paket\tDateien vorher\tDateien nachher\tCodezeilen vorher\tCodezeilen nachher\tDifferenz")
    for package in sorted(before_files.keys() | after_files.keys()):
        delta = after_lines[package] - before_lines[package]
        print(f"{package}\t{before_files[package]}\t{after_files[package]}\t"
              f"{before_lines[package]}\t{after_lines[package]}\t{delta:+}")

    before_total, after_total = before_lines.total(), after_lines.total()
    print(f"Gesamt\t{before_files.total()}\t{after_files.total()}\t"
          f"{before_total}\t{after_total}\t{after_total - before_total:+}")


if __name__ == "__main__":
    main()
