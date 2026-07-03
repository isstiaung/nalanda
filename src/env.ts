export type Bindings = {
  DB: D1Database;
  COVERS: R2Bucket;
  SESSION_SECRET: string;
  DISCOGS_TOKEN?: string;
  GOOGLE_BOOKS_KEY?: string;
};

export type SessionUser = {
  id: number;
  username: string;
  role: 'admin' | 'member';
  mustChangePassword: boolean;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    user: SessionUser;
  };
};

// Sent on all outbound metadata/cover fetches; some providers (Discogs, BGG) require a UA.
export const USER_AGENT = 'nalanda/0.1 (self-hosted personal library)';
