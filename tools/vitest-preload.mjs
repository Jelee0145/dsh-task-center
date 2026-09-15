/**
 * Preload shim that makes Vite's Windows realpath probe safe to run inside a
 * process sandbox.
 *
 * `windowsSafeRealPathSync` calls `exec("net use")` to discover mapped network
 * drives before choosing a realpath implementation. `child_process.exec` uses
 * piped stdio, and a sandboxed process cannot open those pipes: the spawn
 * throws `EPERM` synchronously, Vite does not catch it, and vitest aborts
 * during config loading before a single test runs.
 *
 * The probe only needs to know whether any drive is a network mapping. This
 * shim answers that question locally with "none" for that exact command and
 * leaves every other `child_process` call untouched, so the sandbox boundary
 * is respected rather than widened.
 *
 * It is a test-runner workaround for this checkout only. It is not published
 * and is never imported by package code: run vitest through it with
 * `node --import ./tools/vitest-preload.mjs <vitest entry>`.
 */

import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')
const originalExec = childProcess.exec

/** The one command Vite probes with, answered without spawning anything. */
const VITE_NETWORK_DRIVE_PROBE = 'net use'

childProcess.exec = function exec(command, ...rest) {
  if (command === VITE_NETWORK_DRIVE_PROBE) {
    const callback = rest.find(value => typeof value === 'function')
    const child = new EventEmitter()
    child.stdout = null
    child.stderr = null
    if (typeof callback === 'function') queueMicrotask(() => callback(null, '', ''))
    return child
  }
  return originalExec.call(this, command, ...rest)
}
