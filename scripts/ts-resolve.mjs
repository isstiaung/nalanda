// Lets Node run the Worker's own TypeScript (src/metadata) for scripts/backfill-remote.mjs, unbundled.
// Node 22.18+ strips types natively; what it won't do is resolve the extensionless relative imports our
// source uses (the Worker bundler does), so this hook tries `.ts` for them. Stripping is safe here because
// tsconfig sets isolatedModules: every type-only import is marked as one and simply disappears.
export async function resolve(specifier, context, nextResolve) {
  if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // not a .ts sibling — fall through to the default resolution
    }
  }
  return nextResolve(specifier, context);
}
