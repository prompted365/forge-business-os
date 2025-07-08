# Critical Error Fixes for Hive-Mind Memory and TTY Operations

## Overview
This PR fixes three critical errors discovered during stress testing of the hive-mind memory system and CLI operations.

## Issues Fixed

### 1. TypeError: this.cache.forEach is not a function
**Location:** `src/cli/simple-commands/hive-mind/memory.js:749`

**Root Cause:** The `OptimizedLRUCache` class didn't have a `forEach` method, but the garbage collection code was trying to use it.

**Solution:** Added a `forEach` method to the `OptimizedLRUCache` class that delegates to the internal Map's forEach method.

**Code Reference:**
```javascript
// Added at line 144 in memory.js
forEach(callback) {
  this.cache.forEach(callback);
}
```

### 2. EIO (Input/Output Error) TTY Crashes
**Location:** `src/cli/commands/sparc.ts` lines 243 and 325

**Root Cause:** Direct use of `process.stdin` in readline interfaces without error handling was causing crashes when TTY operations failed.

**Solution:** 
- Created `createSafeReadlineInterface()` function in `tty-error-handler.ts`
- Wrapped readline creation with TTY error handling
- Graceful degradation when TTY is unavailable

**Code Reference:**
```typescript
// New function in tty-error-handler.ts
export async function createSafeReadlineInterface(): Promise<any | null> {
  // Handles TTY errors gracefully, returns null if unavailable
}
```

### 3. Concurrency Conflicts
**Location:** `src/cli/simple-commands/hive-mind/memory.js` background tasks

**Root Cause:** Multiple background tasks (GC, cache optimization, DB optimization) were running concurrently and conflicting with user operations.

**Solution:** Implemented concurrency throttling with:
- `_backgroundTaskRunning` flag to prevent simultaneous background tasks
- `_criticalOperationInProgress` flag to protect user operations
- Task queue for deferred background operations

**Code Reference:**
```javascript
// Added wrapper method in memory.js
async _runBackgroundTask(taskName, taskFn) {
  // Ensures only one background task runs at a time
  // Skips if critical operation is in progress
}
```

## Testing
Created `test-fixes.js` to validate all fixes:
```bash
node test-fixes.js
```

The test script validates:
- Memory operations work without forEach errors
- TTY error handling and graceful degradation
- Concurrency control mechanisms
- Background task queueing and execution

## Technical Impact
These fixes ensure the system can:
- Handle memory garbage collection during heavy operations
- Operate in environments with unstable TTY (containers, CI/CD, SSH sessions)
- Manage concurrent background maintenance without data corruption
- Maintain stability under high load and stress conditions

## Performance Considerations
The concurrency throttling adds minimal overhead (single boolean check) while preventing critical failures. Background tasks are queued rather than lost, ensuring system maintenance continues without interfering with active operations.