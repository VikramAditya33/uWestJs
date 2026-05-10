# Contributing

Thank you for your interest in contributing! Before opening a pull request, please take a few minutes to read through this guide. It exists to keep the codebase healthy and review cycles short.

---

## Read the docs first

Before writing any code, read the relevant documentation at [uwest.js.org/docs](https://uwest.js.org/docs). Additional docs will be added over time; check the docs site for anything that covers the area you are working in. Contributions that contradict or ignore documented behavior will be asked to revise before review begins.

---

## Getting Assigned to an Issue

Before starting work on any issue, please follow these steps to avoid duplicate effort:

1. Browse the [Issues tab](https://github.com/FOSSFORGE/uWestJS/issues) and find one you'd like to work on.
2. Leave a comment on the issue saying you'd like to work on it (e.g. _"I'd like to work on this issue"_).
3. Wait for a maintainer to officially assign it to you.
4. Once assigned, start working and open a Pull Request when ready.

> **Note:** Please do not open a PR without being assigned first, as your work may conflict with someone else's.

---

## CI must pass

Every PR must pass CI before it will be reviewed. This includes the linter. Do not submit a PR with lint failures and expect reviewers to overlook them. Run the linter locally before pushing and fix all warnings and errors. If a lint rule seems wrong for your case, open a separate issue to discuss it rather than disabling the rule inline.

---

## Write real, tested code

Do not submit code that has not been run. All new functionality and bug fixes must be accompanied by tests that actually exercise the change. PRs containing untested or speculative code (code that looks plausible but has not been verified to work) will be closed without merge.

When in doubt: run it, test it, confirm it does what you say it does.

---

## All tests must pass

There are no flaky tests in this project. If your changes cause any tests to fail, fix them before submitting. Do not mark failures as expected or skip tests to get CI green. If you believe a failing test is itself incorrect, address that in a separate PR or explain clearly in your submission why the test needs to change.

---

## Rebase and squash before submitting

Keep the commit history clean. Rebase your branch on top of the latest `main` (or the target branch) before opening a PR, and squash your commits into a small number of logical, well-described commits. A single commit is often appropriate for a focused change. Merge commits in your branch will be asked to be cleaned up before review begins.

A good commit message states _what_ changed and _why_, not just _how_.

---

## Summary checklist

Before opening a PR, confirm each of the following:

- [ ] I have read the relevant documentation at [uwest.js.org/docs](https://uwest.js.org/docs)
- [ ] The linter passes locally with no errors or warnings
- [ ] I have written tests for my changes
- [ ] All existing and new tests pass
- [ ] My branch is rebased on the latest `main`
- [ ] My commits are squashed into clean, logical units with descriptive messages
