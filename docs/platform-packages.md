# Platform-specific packages

This implements [node-pty #864](https://github.com/microsoft/node-pty/issues/864)
using the optional-package model from [@lydell/node-pty](https://github.com/lydell/node-pty).
The public `node-pty` entry point and types stay the same. Exact-version optional
dependencies select `@node-pty/<os>-<cpu>` for Darwin, Linux, and Windows, on ARM64
and x64. Linux packages declare glibc, matching the existing 2.28 sysroot; the
install script also detects musl for package managers that ignore `libc`.

Unlike Lydell's prebuilt-only distribution, the wrapper keeps the source and
Windows `third_party` assets needed for node-gyp. Source builds, `--omit=optional`,
and `npm_config_build_from_source=true` remain supported. A forced source build
never removes files from an optional package shared by a package manager. Local
Release/Debug builds and legacy `prebuilds/` directories retain loading priority.

Native packages contain only runtime `.node` files, macOS `spawn-helper`, and
Windows `conpty/` files. They omit PDB debug symbols and have no install scripts.
The loader resolves the package's absolute directory so helper and DLL paths work
with hoisted dependencies and symlinked package-manager layouts. `--ignore-scripts`
works when the matching optional package is installed. Without optional packages
and without build scripts, native loading cannot work.

## Release workflow

Lydell's repository has build and publish scripts; its publish script publishes
native packages before the wrapper. `.github/workflows/platform-release.yml`
implements that order with native builds and real installed-tarball tests:

1. Dispatch with an explicit version and `beta` or `latest` tag. Publishing is off
   by default. Inputs are validated and passed through environment variables.
2. Six native runners build and run node-pty's tests. Linux uses the existing
   sysroot and glibc checks. Platform tests exercise real PTY spawning through an
   isolated optional package. Native headers must match their advertised target.
3. A packaging job checks that all six packages have matching versions and target
   constraints. It generates the wrapper with exact optional dependency versions,
   then creates seven tarballs and a SHA-512 release manifest.
4. Six runners install the actual matching tarball and wrapper with install scripts
   disabled, then spawn a PTY. Publication depends on all six passing.
5. An opt-in job on upstream `main`, protected by the `npm` environment, checks
   every tarball hash and publishes the six native packages before `node-pty`.
   Publication stops on any failure. Reruns skip versions only when npm reports
   identical tarball integrity; differing published bytes abort the release.

Azure's existing build/test/scan pipeline remains, but its publish switch is
removed to prevent it from publishing a monolithic wrapper independently. Its
checks are separate from the new GitHub release workflow; existing organizational
release/security gates must also be configured for the new `npm` environment.

### Maintainer setup

The `@node-pty` scope and six package names must be owned by the maintainers.
Configure npm trusted publishing for all seven packages to this repository,
`platform-release.yml`, and environment `npm`. New package bootstrap and protected
environment approvals require maintainer access. No npm packages, credentials,
or environments are created by this PR. The workflow requests OIDC only in the
publish job; dry runs and fork tests cannot publish. Download the `npm-release`
artifact to inspect the exact tarballs before enabling publication.

### Local commands

After `npm ci`, build one platform package:

```sh
npm run package:platforms -- platform release 1.2.0-beta.19 darwin-arm64
```

Collect all six platform directories under `release/`, then:

```sh
npm run package:platforms -- release release 1.2.0-beta.19
npm run publish:platforms -- release/tarballs beta
npm run test:release -- release/tarballs beta
```

The publish command is a dry run unless `--publish` is explicitly supplied. The
packed smoke test uses the current platform. `npm run test:platforms` covers
version/target rejection, incomplete releases, package metadata, integrity and
publish ordering, source fallback, and real native loading. npm is used for the
installed-tarball tests; pnpm/Yarn and a real npm publication need separate release
validation.

## Size example

Using the six native builds from node-pty 1.2.0-beta.18 and this branch's wrapper,
the macOS ARM64 installation contains 2,674,852 bytes across its two packages,
versus the beta's 26,907,504 bytes (90.1% less). The two tarballs total 1,251,650
bytes versus 7,152,900 bytes (82.5% less). These are package-file sums, excluding
shared dependencies and filesystem allocation. The result includes omitting PDB
symbols as well as omitting other platforms; it is not solely a platform-filtering
measurement. The wrapper retains about 2.5 MB including source-build assets.

The exact local release was dry-run validated and its wrapper/native tarballs
were installed with scripts disabled and used to spawn a real PTY on macOS ARM64.
The six-platform workflow still needs upstream execution and npm/environment setup.

[Per-package measurements](platform-package-sizes.json) include all six targets.
