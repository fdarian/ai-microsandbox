# ai-microsandbox

## 0.1.0

### Minor Changes

- 886a641: Require an image, add `workDir`, `bridgePort`, and `hostPort`, and fix resumed VM ownership and failed-create cleanup. Require microsandbox 0.6.18 and harness 1.0.123 or newer within major version 1.
- ee1053b: Initial release: `HarnessV1SandboxProvider` implementation backed by microsandbox.

### Patch Changes

- ebe4b20: Release cancelled process streams and file sinks correctly, clean up only VMs started by a failed or aborted resume, and reject relative working directories.
