# @fungi.computer/approvals

## 0.4.0

### Minor Changes

- Changes since 0.3.0:

  - fix(approvals): hash the hold timer key and prove an old store opens
  - fix(hub): bound and always release a parked approval's hold
  - feat(hub): a parked approval holds the asking Session until it ends

## 0.3.0

### Minor Changes

- Changes since 0.2.9:

  - fix(hub): follow every command a parked card serves
  - fix(hub): withdraw parked cards by command, durably
  - feat(hub): park approvals until the person answers

## 0.2.9

### Patch Changes

- @fungi.computer/watchdog@0.1.7

## 0.2.8

### Patch Changes

- Changes since 0.2.7:

  - fix(approvals): treat a disable during a running write as uncertain
  - fix(approvals): align refusal guidance and preserve typed host verdicts
  - fix(approvals): keep certain App refusals terminal with their causes

## 0.2.7

### Patch Changes

- Updated dependencies
  - @fungi.computer/watchdog@0.1.6

## 0.2.6

### Patch Changes

- Changes since 0.2.5:

  - fix(inkcap): retain folder creation causes through refusal rows
  - fix(inkcap): preserve missing-folder writes and failed approval outcomes

## 0.2.5

### Patch Changes

- Updated dependencies
  - @fungi.computer/watchdog@0.1.5

## 0.2.4

### Patch Changes

- Changes since 0.2.3:

  - fix(approvals): align App display metadata with its catalog
  - fix(approvals): isolate waiting calls and name App write permissions
  - fix(hub): answer a waiting App write in its own call
  - fix(local): return approval outcomes in the originating tool call

- Updated dependencies
  - @fungi.computer/watchdog@0.1.4

## 0.2.3

### Patch Changes

- Updated dependencies
  - @fungi.computer/watchdog@0.1.3

## 0.2.2

### Patch Changes

- Updated dependencies
  - @fungi.computer/watchdog@0.1.2

## 0.2.1

### Patch Changes

- Updated dependencies
  - @fungi.computer/watchdog@0.1.1

## 0.2.0

### Minor Changes

- Changes since 0.1.0:

  - fix(approvals): bound confirmation and refuse invalid noted approvals
  - feat(approvals): lead follow-up turns with human denial reason
  - feat(approval): carry bounded denial feedback and optional rule coverage

## 0.1.0

### Minor Changes

- Changes since 0.0.2:

  - feat(local): remember human-approved exec prefixes
  - feat(local): dispatch approved sandbox escapes once through ledger handoff
  - feat(local): stage sandbox escapes as approval records

## 0.0.2

### Patch Changes

- Initial public release of @fungi.computer/approvals.
- Updated dependencies
  - @fungi.computer/watchdog@0.1.0
