# AskAway 1.0.6 Release Notes

## Fixes

- Made Telegram polling retry interval configurable in settings via `askaway.telegram.retryIntervalSeconds`.
- Added configurable Telegram idle polling pause via `askaway.telegram.idlePauseMinutes`.
- Changed Telegram idle pause default to disabled (`0`) to prevent missed replies when users respond after long delays.

## Why this matters

Previously, Telegram polling could pause after a fixed idle timeout, which could cause delayed replies (for example after 10-15 minutes) to not be picked up. With this release, polling behavior is configurable and can be tuned per workflow.

## New settings

- `askaway.telegram.retryIntervalSeconds`
  - Type: number
  - Default: `60`
  - Range: `10` to `900`
  - Description: steady retry interval after initial quick retries.

- `askaway.telegram.idlePauseMinutes`
  - Type: number
  - Default: `0` (disabled)
  - Range: `0` to `720`
  - Description: pause polling after Copilot idle period. Set to `0` to keep polling active.

## Recommended configuration for reliable delayed replies

```json
{
  "askaway.telegram.retryIntervalSeconds": 60,
  "askaway.telegram.idlePauseMinutes": 0
}
```
