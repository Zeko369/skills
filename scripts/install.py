#!/usr/bin/env python3
"""Link this checkout's skills into personal Codex/Cursor and Claude directories."""

import argparse
import os
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--check", action="store_true", help="check links without changing anything")
    modes.add_argument("--dry-run", action="store_true", help="show missing links without creating them")
    parser.add_argument("--home", type=Path, default=Path.home(), help="installation home (default: your home directory)")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    skills = sorted(p for p in repo.iterdir() if p.is_dir() and (p / "SKILL.md").is_file())
    if not skills:
        parser.error("no skill folders containing SKILL.md found in this checkout")

    home = args.home.expanduser().absolute()
    roots = [home / ".agents" / "skills", home / ".claude" / "skills"]
    pending = []
    conflicts = []
    for root in roots:
        for ancestor in [*reversed(root.parents), root]:
            if os.path.lexists(ancestor) and not ancestor.is_dir():
                conflicts.append(f"not a directory: {ancestor}")
                break
        else:
            for source in skills:
                destination = root / source.name
                if destination.is_symlink() and destination.resolve() == source.resolve():
                    print(f"OK    {destination} -> {source}")
                elif os.path.lexists(destination):
                    conflicts.append(f"existing entry: {destination}")
                else:
                    pending.append((source, destination))

    if conflicts:
        for conflict in conflicts:
            print(f"CONFLICT {conflict}", file=sys.stderr)
        print("No changes made. Move conflicting entries aside yourself, then rerun.", file=sys.stderr)
        return 1
    for source, destination in pending:
        if args.check or args.dry_run:
            print(f"MISSING {destination} -> {source}")
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            # No force/replace: a newly appearing conflicting entry also stays intact.
            destination.symlink_to(source, target_is_directory=True)
            print(f"LINK  {destination} -> {source}")
    if args.check and pending:
        return 1
    if not args.check and not args.dry_run:
        print(f"Installed {len(skills)} skill(s) for Codex, Cursor, and Claude Code.")
        print("Start a fresh agent session to verify discovery. This does not install or authenticate agent CLIs.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError) as error:
        print(f"Installation failed: {error}", file=sys.stderr)
        sys.exit(1)
