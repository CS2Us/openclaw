// ESM entry — bridge the CommonJS napi-rs loader into ESM named exports.
//
// openclaw is strict ESM; the NAPI-RS generated loader (`index.js`) is CommonJS,
// so we pull it in via `createRequire` and re-export the two addon functions the
// chromite-bridge consumes. Keep this list in sync with index.d.ts.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const addon = require("../../../src/chromite/crates/chromite-client-napi/index.js");

export const resolveIdentity = addon.resolveIdentity;
export const runEdgeLoopNapi = addon.runEdgeLoopNapi;
