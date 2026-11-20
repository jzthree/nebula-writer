"""Calls to the local agent CLIs (Claude Code, Antigravity, Codex) as plain
text models: no tools, no project instructions, no skills, so every call
sees only the prompt it is given. Results are cached by their exact inputs,
so an interrupted run resumes where it stopped and a rerun costs nothing.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Model:
    backend: str  # claude | agy | codex
    model: str | None = None
    effort: str | None = None

    @staticmethod
    def parse(spec: str) -> "Model":
        """'claude', 'claude:opus', 'claude:opus@high', 'agy:gemini-4-neon-high'."""
        effort = None
        if "@" in spec:
            spec, effort = spec.split("@", 1)
        backend, _, model = spec.partition(":")
        if backend not in ("claude", "agy", "codex"):
            raise ValueError(f"unknown backend {backend!r} (claude, agy, codex)")
        return Model(backend, model or None, effort)

    @property
    def label(self) -> str:
        return self.backend + (f":{self.model}" if self.model else "") + (f"@{self.effort}" if self.effort else "")


class LLMError(RuntimeError):
    pass


class Client:
    def __init__(self, cache_dir: Path, timeout: float | None = None, retries: int = 2):
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.timeout = timeout
        self.retries = retries
        # A neutral working directory: no CLAUDE.md, AGENTS.md or project files to pick up.
        self.workdir = Path(tempfile.mkdtemp(prefix="style-turing-cli-"))

    def _cache_path(self, model: Model, system: str, prompt: str) -> Path:
        key = hashlib.sha256(json.dumps([model.label, system, prompt]).encode()).hexdigest()
        return self.cache_dir / key[:2] / f"{key}.json"

    def complete(self, model: Model, system: str, prompt: str) -> str:
        path = self._cache_path(model, system, prompt)
        if path.exists():
            return json.loads(path.read_text())["output"]
        last: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                started = time.time()
                output = self._call(model, system, prompt)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps({"model": model.label, "seconds": round(time.time() - started, 1), "output": output}))
                return output
            except (LLMError, subprocess.TimeoutExpired) as error:
                last = error
                time.sleep(5 * (attempt + 1))
        raise LLMError(f"{model.label} failed: {last}")

    def complete_json(self, model: Model, system: str, prompt: str) -> dict:
        text = self.complete(model, system, prompt)
        parsed = extract_json(text)
        if parsed is None:
            # One more try without the cache, asking only for the JSON.
            path = self._cache_path(model, system, prompt)
            path.unlink(missing_ok=True)
            text = self.complete(model, system, prompt + "\n\nAnswer with the JSON object only.")
            parsed = extract_json(text)
        if parsed is None:
            raise LLMError(f"{model.label} returned no JSON: {text[:300]!r}")
        return parsed

    def _call(self, model: Model, system: str, prompt: str) -> str:
        if model.backend == "claude":
            binary = shutil.which("claude") or "claude"
            args = [binary, "-p", "--output-format", "json", "--tools", "", "--system-prompt", system,
                    "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config", "--setting-sources", ""]
            if model.model:
                args += ["--model", model.model]
            if model.effort:
                args += ["--effort", model.effort]
            done = subprocess.run(args, input=prompt, capture_output=True, text=True, cwd=self.workdir, timeout=self.timeout)
            try:
                body = json.loads(done.stdout)
            except json.JSONDecodeError:
                raise LLMError(f"claude exit {done.returncode}: {(done.stderr or done.stdout)[-500:]}")
            if body.get("is_error"):
                raise LLMError(f"claude: {str(body.get('result'))[:500]}")
            return str(body.get("result") or "")
        if model.backend == "agy":
            binary = shutil.which("agy") or "agy"
            text = f"{system}\n\nDo not use any tools; answer from this message alone.\n\n{prompt}"
            args = [binary, "-p", text, "--output-format", "json", "--disable-slash-commands"]
            if model.model:
                args += ["--model", model.model]
            if model.effort:
                args += ["--effort", model.effort]
            done = subprocess.run(args, capture_output=True, text=True, cwd=self.workdir, timeout=self.timeout)
            try:
                body = json.loads(done.stdout)
            except json.JSONDecodeError:
                raise LLMError(f"agy exit {done.returncode}: {(done.stderr or done.stdout)[-500:]}")
            if body.get("status") != "SUCCESS":
                raise LLMError(f"agy: {json.dumps(body)[:500]}")
            return str(body.get("response") or "")
        if model.backend == "codex":
            binary = shutil.which("codex") or "codex"
            out = self.workdir / f"codex-{time.time_ns()}.txt"
            args = [binary, "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--output-last-message", str(out)]
            if model.model:
                args += ["--model", model.model]
            if model.effort:
                args += ["-c", f"model_reasoning_effort={model.effort}"]
            done = subprocess.run(args + ["-"], input=f"{system}\n\n{prompt}", capture_output=True, text=True, cwd=self.workdir, timeout=self.timeout)
            if done.returncode != 0 or not out.exists():
                raise LLMError(f"codex exit {done.returncode}: {(done.stderr or done.stdout)[-500:]}")
            return out.read_text()
        raise LLMError(f"unknown backend {model.backend}")


def extract_json(text: str) -> dict | None:
    """The JSON object in a model's answer, with or without a code fence."""
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    candidates = [fenced.group(1)] if fenced else []
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        candidates.append(text[start:end + 1])
    for candidate in candidates:
        try:
            value = json.loads(candidate)
            if isinstance(value, dict):
                return value
        except json.JSONDecodeError:
            continue
    return None
