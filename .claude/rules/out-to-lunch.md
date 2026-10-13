---
paths:
  - "out-to-lunch/**"
---

# out-to-lunch

- Every state change goes through `change()`, which applies `settle(fn(settle(l, now)), now)`: charge the time since the last change to the main loop's current phase, apply the change, re-read the phase. The phase is the highest-priority main-loop job (approval > review > tool > compact > tool-input > writing > thinking > request), or `engine` when none runs. `change()` swallows errors so tracking never breaks a turn.
- A 1-second `$.clock.every` tick, started in `session.start`, copies per-chunk character counts (kept in a module `Map`, not `$.state`) into state and re-settles while busy; each write redraws the band.
- `off`, `on` and the `on <seconds>` delay are session-only by design: every new session starts with the band off and no delay.
- No event marks when the person answers a permission prompt, so a tool's run after approval is counted as permission-prompt time.
