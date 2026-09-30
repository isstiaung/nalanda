// The release this code is: SemVer, bumped in a release commit alongside its CHANGELOG.md entry
// (runbooks/updating.md, ARCH.md §16 #42). test/version.spec.ts keeps it in step with package.json.
// Shown to signed-in people only (the Account page). The public descriptor carries the connections
// protocol version, not this, so an instance doesn't advertise to the world which release it runs.
export const VERSION = '1.6.2';
