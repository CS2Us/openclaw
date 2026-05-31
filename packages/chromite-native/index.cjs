// CommonJS entry — re-export the napi-rs generated loader.
//
// The native addon is built (out of the openclaw tree) by the chromite-client-napi
// crate; its NAPI-RS-generated `index.js` loader picks the right platform `.node`.
// We re-require it here so the openclaw workspace package `@openclaw/chromite-native`
// resolves to the actual addon without vendoring the (gitignored, platform-specific)
// `.node` binary into the openclaw repo.
//
// Build the addon first (see chromite-client-napi/package.json):
//   cd src/chromite/crates/chromite-client-napi && napi build --platform --release
//
// If the addon is missing, `require` throws the napi loader's "Failed to load
// native binding" error — surfaced verbatim so the operator knows to build it.
module.exports = require("../../../src/chromite/crates/chromite-client-napi/index.js");
