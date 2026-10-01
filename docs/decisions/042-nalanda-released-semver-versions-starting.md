# §16 #42 — Nalanda is released as SemVer versions, starting at 1.0.0, with notes written for whoever hosts it

**Decided:** 2026-09-28 (versions and releases). Cited as `ARCH.md §16 #42`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Other households run their own copies, and a migration applies itself on deploy,
so the one thing a self-hoster can't learn from the code is what an update will do to their
data. So every release says so. A version lives in package.json and `src/version.ts` (kept in
step by a test). Each release's notes give it an **Upgrading** section: the migrations it
runs and whether to back up, any new secret, and whether connected households on older
versions are affected. Pushing a `vX.Y.Z` tag publishes those notes as a GitHub Release
(`.github/workflows/release.yml`, which holds no secret beyond its own token and never
deploys). A patch fixes; a minor adds, including migrations that apply on their own; a
major needs something from the host or breaks compatibility with connections. That last
one is judged against the connections protocol, whose own version (in `/.well-known/nalanda`)
is separate and changes only when instances stop understanding each other. The app's
version shows on the Account page to signed-in people and is deliberately left out of the
public descriptor: an instance shouldn't tell the world which release, and so which known
bugs, it runs. v1.0.0 is the deploy of 2026-09-28 (cf2d7f2), tagged after the fact. GitHub
runs a tag's workflow as it is in the tagged commit, and that one predates the workflow, so
v1.0.0's release was published by hand; every later tag is on a commit that carries it, and
the workflow refuses a tag that isn't on main. runbooks/updating.md is the self-hoster's path.
*Amended 2026-10-01:* one file per release. The notes live in `changelog/vX.Y.Z.md`, headed
`## [X.Y.Z] - <date>`, and CHANGELOG.md is their index: the SemVer intro, then one line per
release, newest first (version, date, one-sentence summary, link). Pull requests add their
entries to `changelog/unreleased.md`. A release commit renames that file to
`changelog/vX.Y.Z.md` with its heading, date and summary, creates a fresh `unreleased.md`,
and adds the index line. The tag's workflow publishes main's `changelog/vX.Y.Z.md` minus its
heading, and fails, naming the file, when it's missing or headed otherwise. A test holds the
current version to a file, and every file to its heading, an Upgrading block and an index
line. The single CHANGELOG.md had grown to every release's full notes in one long page; the
index now reads at a glance, and each release's notes stand alone.
