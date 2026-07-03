declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    COVERS: R2Bucket;
    SESSION_SECRET: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
