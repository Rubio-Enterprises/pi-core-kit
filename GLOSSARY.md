# Core kit

Building blocks shared by Pi extensions that need nothing from a Pi host, so they work and are tested on Node alone.

## Language

**Module**:
One independently importable building block, published under its own subpath.
_Avoid_: package, helper, util

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
