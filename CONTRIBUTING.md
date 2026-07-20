# Contributing

Thanks for helping improve LayerRelay. The project is primarily tested with a Prusa CORE One and INDX toolchanger, so clearly identify assumptions about other printers, firmware, cameras, or OBS versions.

## Before opening an issue

- Search existing issues.
- Use the bug or feature issue form and include reproducible, sanitized details.
- Report vulnerabilities through the process in [SECURITY.md](SECURITY.md), not a public issue.
- Never attach real configuration, credentials, private URLs, unredacted logs, or private camera imagery.

## Development setup

Use Bun 1.3.14 or newer in the 1.x line. CI pins Bun 1.3.14 on every platform.

```text
git clone https://github.com/GoByeBye/LayerRelay.git
cd LayerRelay
bun ci
bun run check
bun test
```

The automated tests do not require a printer, camera, FFmpeg, or `config.json`.

To run the service manually, copy `config.example.json` to the ignored `config.json`, then replace placeholders with local values. On PowerShell use `Copy-Item config.example.json config.json`; on macOS or Linux use `cp config.example.json config.json`. Never commit the resulting file or anything under `cache/`.

Run one focused test file with an explicit path, for example:

```text
bun test ./test/toolswaps.test.js
```

## Making changes

- Keep patches focused and preserve unrelated work.
- Match the existing style: CommonJS for the main service and ES modules for `.mjs` scripts.
- Keep text files LF-only as configured by `.gitattributes`.
- Add regression coverage for bug fixes and tests for new behavior.
- Update the README or configuration documentation when behavior, defaults, setup, API shape, or security boundaries change.
- Keep printer polling conservative; overlapping pollers can overload the printer.
- Preserve credential redaction and the single-poller runtime boundary.

The repository is licensed under `AGPL-3.0-or-later`. Do not add copied code,
generated assets, fonts, icons, or other third-party material without documenting
its exact source and license terms. Contributions and dependencies must be
compatible with the project license, preserve required notices, and include a
dated modification notice when adapting covered code.

## AI-assisted contributions

Disclose material use of generative AI in the pull request summary, including
the tool and the parts of the change it assisted. Contributors remain responsible
for reviewing the result, testing it, and verifying its security, correctness,
license compatibility, and provenance.

Do not submit AI-generated code, text, or assets whose source or license
obligations cannot be established. An AI disclosure documents the development
process; it does not replace the source and license records required for copied,
adapted, generated, or vendored material. See the project-wide disclosure in
[NOTICE.md](NOTICE.md#ai-assisted-development).

## Pull requests

Before submitting a pull request:

1. Rebase or merge the current default branch as appropriate.
2. Run `bun run check` and `bun test`.
3. Build the Docker image when the runtime, dependencies, configuration, or container files changed.
4. Sanitize screenshots and logs.
5. Complete the pull request template, including platform coverage and provenance checks.

CI must pass on Ubuntu, Windows, and macOS before merging.
