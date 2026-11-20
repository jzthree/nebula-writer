"""stl: build the corpus, run the style Turing test, read reports, revise the skill."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .corpus import JOURNALS, SECTIONS, build
from .experiment import Condition, RunConfig, Runner
from .improve import RevisionError, profile_table, revise
from .llm import Model
from .report import write_report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="stl", description="Style Turing test: can a judge tell a skill's rewrite from the published paragraph?")
    parser.add_argument("--data", type=Path, default=Path("data"))
    sub = parser.add_subparsers(dest="command", required=True)

    c = sub.add_parser("corpus", help="download open-access papers and extract paragraphs")
    c.add_argument("--journals", default=",".join(JOURNALS))
    c.add_argument("--papers", type=int, default=40, help="papers per journal")
    c.add_argument("--years", default="2018-2025")

    p = sub.add_parser("profile", help="measured style of the published paragraphs (training split)")
    p.add_argument("--journals", default=",".join(JOURNALS))

    r = sub.add_parser("run", help="run the test")
    r.add_argument("--name", required=True)
    r.add_argument("--journals", default=",".join(JOURNALS))
    r.add_argument("--split", default="dev", choices=["train", "dev", "test"])
    r.add_argument("--per-journal", type=int, default=12)
    r.add_argument("--sections", default=",".join(SECTIONS))
    r.add_argument("--condition", action="append", default=None, help="'baseline' or 'name=path/to/skill' (repeatable)")
    r.add_argument("--generator", default="claude")
    r.add_argument("--briefer", default="claude")
    r.add_argument("--judge", action="append", default=None, help="model spec, e.g. claude or agy:gemini-4-neon-high (repeatable)")
    r.add_argument("--references", type=int, default=3, help="published paragraphs shown to each judge for calibration")
    r.add_argument("--mode", default="both", choices=["paired", "single", "both"], help="paired: pick the published one of two; single: rate one paragraph alone")
    r.add_argument("--seed", type=int, default=7)
    r.add_argument("--workers", type=int, default=6)
    r.add_argument("--runs", type=Path, default=Path("runs"))

    e = sub.add_parser("exemplars", help="write the skill's bank of published example paragraphs (CC BY, training split)")
    e.add_argument("--skill", type=Path, default=Path("skills/journal-style"))
    e.add_argument("--journals", default=",".join(JOURNALS))
    e.add_argument("--per-section", type=int, default=12)

    rep = sub.add_parser("report", help="rewrite a run's report")
    rep.add_argument("run_dir", type=Path)

    i = sub.add_parser("improve", help="revise a journal's reference file from a dev run")
    i.add_argument("run_dir", type=Path)
    i.add_argument("--condition", default="skill")
    i.add_argument("--skill", type=Path, default=Path("skills/journal-style"))
    i.add_argument("--journals", default=None, help="default: the run's journals")
    i.add_argument("--reviser", default="claude@high")

    args = parser.parse_args(argv)
    if args.command == "corpus":
        start, end = (int(x) for x in args.years.split("-"))
        build(args.data, args.journals.split(","), args.papers, (start, end))
    elif args.command == "profile":
        print(profile_table(args.data, args.journals.split(",")))
    elif args.command == "run":
        if args.split == "test":
            print("Running on the held-out test split: use this once per skill version you want to report.", file=sys.stderr)
        config = RunConfig(
            name=args.name, journals=args.journals.split(","), split=args.split, per_journal=args.per_journal,
            sections=args.sections.split(","), conditions=[Condition.parse(s) for s in (args.condition or ["baseline", "skill=skills/journal-style"])],
            generator=Model.parse(args.generator), briefer=Model.parse(args.briefer),
            judges=[Model.parse(s) for s in (args.judge or ["claude", "agy:gemini-4-neon-high"])],
            references=args.references, mode=args.mode, seed=args.seed, workers=args.workers, out_dir=args.runs, data_dir=args.data,
        )
        print(Runner(config).run())
    elif args.command == "exemplars":
        from .exemplars import build as build_exemplars

        for path in build_exemplars(args.data, args.skill, args.journals.split(","), args.per_section):
            print(path)
    elif args.command == "report":
        print(write_report(args.run_dir, args.data))
    elif args.command == "improve":
        import json

        config = json.loads((args.run_dir / "config.json").read_text())
        for journal in (args.journals.split(",") if args.journals else config["journals"]):
            try:
                path, changes = revise(args.run_dir, args.data, args.skill, args.condition, journal, Model.parse(args.reviser))
            except RevisionError as error:
                print(f"== {journal}: not revised: {error}\n")
                continue
            print(f"== {path}\n{changes}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
