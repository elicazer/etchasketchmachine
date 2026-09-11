# Custom PlatformIO test runner for the host_test (native) environment.
#
# The host suites use Catch2 v3 with a per-suite `int main` that calls
# `Catch::Session().run(argc, argv)` (see e.g. tests/test_frame/). PlatformIO's
# `test_framework = custom` setting (platformio.ini) makes PlatformIO look for
# this module at `<test_dir>/test_custom_runner.py` and instantiate the class
# named `CustomTestRunner`.
#
# This runner builds the native `program` binary as usual, then parses Catch2's
# default console-reporter output to surface per-test results and an overall
# pass/fail. The underlying program also returns a non-zero exit code on any
# failure, which PlatformIO's NativeTestOutputReader turns into an error, so the
# `pio test -e host_test` exit status is correct even if parsing changes.

import re

import click

from platformio.test.result import TestCase, TestCaseSource, TestStatus
from platformio.test.runners.base import TestRunnerBase


class CustomTestRunner(TestRunnerBase):
    # Catch2 v3 + rapidcheck come from the env's lib_deps (platformio.ini); no
    # extra deps are injected here.
    EXTRA_LIB_DEPS = None

    # A FAILED assertion block from Catch2's console reporter begins with a
    # "<file>:<line>: FAILED:" line.
    FAILED_RE = re.compile(r"^(?P<file>.+?):(?P<line>\d+): (?:FAILED|FATAL ERROR):")

    # The final one-line summaries Catch2 prints.
    ALL_PASSED_RE = re.compile(
        r"^All tests passed \((?P<assertions>\d+) assertion[s]? in "
        r"(?P<cases>\d+) test case[s]?\)"
    )
    SUMMARY_RE = re.compile(r"^test cases:\s+\d+\s*\|.*?(?P<failed>\d+) failed")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._failures = []          # list of (source_file, source_line)
        self._current_fail = None    # in-progress failure being captured
        self._finalized = False

    def on_testing_line_output(self, line):
        # Always echo so the developer sees the raw Catch2 report.
        click.echo(line, nl=False)

        stripped = line.rstrip("\n")

        # Capture the start of a failure block.
        m = self.FAILED_RE.match(stripped)
        if m:
            self._flush_current_fail()
            self._current_fail = {
                "file": m.group("file"),
                "line": int(m.group("line")),
                "text": [stripped],
            }
            return

        # Accumulate the body of an in-progress failure block (expansion, etc.).
        if self._current_fail is not None:
            if stripped.startswith("===") or not stripped.strip():
                self._flush_current_fail()
            else:
                self._current_fail["text"].append(stripped)

        # Overall result lines.
        if self.ALL_PASSED_RE.match(stripped):
            self._finalize(any_failures=False)
        else:
            sm = self.SUMMARY_RE.match(stripped)
            if sm:
                self._finalize(any_failures=int(sm.group("failed")) > 0)

    def _flush_current_fail(self):
        if self._current_fail is None:
            return
        cf = self._current_fail
        self._failures.append((cf["file"], cf["line"], "\n".join(cf["text"])))
        self._current_fail = None

    def _finalize(self, any_failures):
        if self._finalized:
            return
        self._finalized = True
        self._flush_current_fail()

        if self._failures:
            for source_file, source_line, message in self._failures:
                self.test_suite.add_case(
                    TestCase(
                        name=message.splitlines()[0] if message else "assertion",
                        status=TestStatus.FAILED,
                        message=message,
                        source=TestCaseSource(source_file, source_line),
                        stdout=message,
                    )
                )
        elif not any_failures:
            # No individual failures and the run reported success.
            self.test_suite.add_case(
                TestCase(
                    name=f"{self.test_suite.env_name}:{self.test_suite.test_name}",
                    status=TestStatus.PASSED,
                )
            )

        self.test_suite.on_finish()
