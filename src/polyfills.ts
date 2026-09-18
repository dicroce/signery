// @signpdf and node-forge expect the Node.js Buffer global. This module must be
// imported before any of them so the polyfill is in place when they load.
import { Buffer } from "buffer";

(globalThis as Record<string, unknown>).Buffer = Buffer;
