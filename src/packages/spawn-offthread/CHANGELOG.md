# Changelog

## 0.1.1

- Fixed: once the host had started a worker thread, a failed write to the program's stdout or
  stderr ended the program with an unhandled `'error'` event. Node pipes a worker's output into
  `process.stdout` and `process.stderr`, and `console.log` only drops a line it cannot write while
  nothing else listens for `'error'` there. The host now removes those pipes and passes its
  workers' output on itself, so it leaves no listener on either stream.
- This is the first version built and published by this repository's GitHub workflow, so it comes
  with a provenance statement.

## 0.1.0

First release.
