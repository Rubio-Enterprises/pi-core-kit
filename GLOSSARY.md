# Core kit

Building blocks shared by Pi extensions that need nothing from a Pi host, so they work and are tested on Node alone.

## Language

**Module**:
One independently importable building block, published under its own subpath.
_Avoid_: package, helper, util

**Config file**:
A JSON object an extension reads its settings or rules from, owned by the user or by tooling that writes it for them.
_Avoid_: settings file, config store, preferences

**Read outcome**:
What reading a config file produced: missing, a value, or invalid with a reason. What each outcome means is the extension's policy.
_Avoid_: result, status, error

**Safe update**:
Rewriting a config file from its current content so that a corrupt file is never overwritten and a concurrent change is never lost silently.
_Avoid_: save, write, persist

**Schema**:
The declared shape a config file must have to be a value rather than invalid.
_Avoid_: validator, type, spec

**Session cache**:
A named store of JSON entries that several Pi processes read and refresh cooperatively, falling back to memory when the disk is unusable.
_Avoid_: shared cache, usage cache, store

**Entry**:
One named JSON value in a session cache.
_Avoid_: key, record, file

**Lock**:
A cooperative, expiring claim that one process is refreshing an entry. It is advisory, not a security boundary.
_Avoid_: mutex, lease

**Stale takeover**:
Claiming a lock whose holder has died or whose age exceeds the stale limit.
_Avoid_: steal, force unlock
