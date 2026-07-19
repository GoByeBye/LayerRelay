# Public release checklist

This checklist gates both the first public visibility change and each tagged release. No visibility change or release should be published while any item marked **BLOCKER** is incomplete.

## 1. Define the release contents

- [ ] The intended release commit is identified and the working tree is understood with `git status --short`.
- [ ] Every modified and untracked file has been reviewed deliberately; no broad staging operation pulled in machine-local state.
- [ ] All local and remote branches, tags, stashes, and releases have been inventoried.
- [ ] Obsolete pages, scratch files, worktrees, local agent state, captures, and machine-specific helpers are excluded or intentionally documented.
- [ ] Hardcoded personal paths, identities, printer data, stream identifiers, and private integration assumptions have been removed from the public surface.

## 2. License and provenance — BLOCKER

- [x] The provenance of the binary G-code decoder and every ported, adapted, vendored, generated, or copied component has been reviewed.
- [x] Upstream license obligations have been assessed before choosing the repository license. This includes network-copyleft and source-offer obligations where applicable.
- [x] The repository is licensed as `AGPL-3.0-or-later`; the root license and package metadata agree.
- [x] Required copyright notices, immutable source links, dated modification notices, and third-party attributions are present in `NOTICE.md` and `bgcode.js`.
- [x] No redistributable font, screenshot, or custom artwork is bundled; custom `/public/assets` content is ignored and requires its own provenance.
- [x] The locked production dependency graph was inventoried as MIT, ISC, or BSD-3-Clause and is compatible with the repository license.
- [x] Material AI assistance is disclosed in `NOTICE.md`; the disclosure is not treated as a substitute for source and license review.

Do not substitute a familiar permissive license for a provenance review. If any component's origin or grant is unclear, publication remains blocked until it is removed, replaced, rewritten with documented provenance, or cleared for use.

## 3. Secrets and privacy — BLOCKER

- [ ] All remote refs and tags are current locally: `git fetch --all --tags --prune`.
- [ ] A maintained secret scanner has scanned the entire reachable history and all refs, not only the working tree or proposed diff.
- [ ] The scan covered local branches, remote-tracking branches, tags, and stash refs. Any intentionally excluded ref is documented and reviewed separately.
- [ ] A second manual search checked for configuration files, tokens, passwords, private keys, RTSP URLs, printer addresses, usernames, local paths, stream IDs, and personal data.
- [ ] `git log --all -- config.json cache/` and equivalent filename checks confirm sensitive runtime files were never committed.
- [ ] Any credential that ever entered Git history, an issue, a log, or an artifact has been rotated; deleting the text alone is not considered remediation.
- [ ] `config.json`, cache state, logs, captures, local worktrees, dependency folders, and operator scratch files are ignored and absent from release artifacts and Docker build context.
- [ ] GitHub secret scanning and push protection are enabled before the repository becomes public.

Example Gitleaks invocation after fetching every ref:

```text
gitleaks git . --redact --log-opts="--all"
```

Record the scanner version, command, date, and disposition of every finding in private release notes. Do not commit a report containing live secrets.

## 4. Clean-clone verification

- [ ] A fresh clone was tested outside the development checkout.
- [ ] `bun ci`, `bun run check`, and `bun test` pass with Bun 1.3.14 on Ubuntu.
- [ ] The same checks pass with Bun 1.3.14 on Windows and macOS.
- [ ] The Docker image builds from the committed context without relying on ignored or machine-local files.
- [ ] Docker starts with a read-only configuration mount and persistent data volume.
- [ ] The container health check reports process health even when the printer or camera is offline.
- [ ] The default published container port binds to host loopback only.
- [ ] Native and Docker write tools authenticate correctly across the container boundary.
- [ ] The service is verified as a single replica so it cannot create duplicate printer pollers or RTSP readers.
- [ ] A representative OBS browser source was checked at documented dimensions.

## 5. Documentation and support

- [ ] README quick starts work verbatim on Windows, macOS, Linux, and Docker where claimed.
- [ ] Required and optional hardware, Bun, FFmpeg, printer firmware, camera, and OBS expectations are explicit.
- [ ] Every public configuration setting has a type, default, sensitivity note, and example.
- [ ] Remote-access and camera-privacy risks are prominent.
- [ ] Troubleshooting covers missing configuration, invalid JSON, unavailable FFmpeg, unreachable printer, camera failure, and port conflicts.
- [ ] SECURITY.md, CONTRIBUTING.md, issue forms, and the pull request template point users to the correct support paths.
- [ ] Screenshots and example configuration are sanitized and use neutral identities and data.

## 6. GitHub repository settings

- [ ] The repository description, topics, social preview, and default branch are set.
- [ ] Actions are enabled with read-only default workflow permissions.
- [ ] A ruleset protects the default branch, blocks force pushes and deletion, and requires the CI checks.
- [ ] Issues and private vulnerability reporting are enabled.
- [ ] Dependabot alerts, security updates, secret scanning, and push protection are enabled.
- [ ] Unneeded deploy keys, webhooks, collaborators, environments, actions secrets, and branch refs have been removed or reviewed.
- [ ] Workflow actions are pinned or covered by automated update review.

## 7. Version and release artifacts

- [ ] The package version and changelog describe the actual compatibility level; use a prerelease while external setup remains unproven.
- [ ] Release notes include supported platforms, breaking changes, known limitations, upgrade steps, and security-relevant changes.
- [ ] The release tag points at the exact verified commit.
- [ ] If a container image is published, its immutable tags identify the same source commit; otherwise the release notes record that no registry image is published.
- [ ] Every container image built for release embeds the exact source URL, revision, and selected license in its metadata.
- [ ] Deployment documentation requires modified network deployments to set `SOURCE_CODE_URL` to their exact corresponding source.
- [ ] If generated binary or container artifacts are published, an SBOM and build provenance are attached or generated; otherwise the source-only disposition is recorded in the release notes.
- [ ] Installation artifacts contain no development worktrees, credentials, caches, logs, or unrelated operator integrations; any bundled tests and operator tools are documented, credential-free, and exercised by CI.

Conditional items may be checked as not applicable only when the release notes
explicitly record that the corresponding artifact or publication channel is not
part of the release.

## 8. Final publication gate

- [ ] Every **BLOCKER** item above is complete and evidence has been reviewed.
- [ ] CI is green on the exact release commit.
- [ ] The final public file and history diff has been reviewed from a signed-out perspective.
- [ ] A rollback and credential-rotation plan exists if post-publication exposure is discovered.
- [ ] Only after all preceding checks pass, repository visibility or the release is published.

Record the release commit, reviewer, verification date, and links to private scan evidence before completing the final checkbox.
