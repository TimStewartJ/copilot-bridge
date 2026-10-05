// A failed log write must not end the process — import this FIRST, before anything can log.
import { installStdioWriteGuard } from "./stdio-write-guard.js";

installStdioWriteGuard();
