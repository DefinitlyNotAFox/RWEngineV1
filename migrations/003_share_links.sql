PRAGMA foreign_keys = ON;

/*
  Public share links.

  Only a SHA-256 hash of the public token is stored. Generating a new link for
  the same resource rotates the token, immediately invalidating the old URL.
*/

CREATE TABLE IF NOT EXISTS share_links (
  share_id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  faction_id INTEGER NOT NULL,
  resource_type TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER,

  UNIQUE(owner_user_id, faction_id, resource_type, resource_key),

  FOREIGN KEY (owner_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (faction_id) REFERENCES factions(faction_id)
);

CREATE INDEX IF NOT EXISTS idx_share_links_token
ON share_links(token_hash, is_enabled);

CREATE INDEX IF NOT EXISTS idx_share_links_owner
ON share_links(owner_user_id, faction_id, resource_type, updated_at DESC);
