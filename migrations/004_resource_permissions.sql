PRAGMA foreign_keys = ON;

/*
  Generic visibility rules for shareable RWEngine resources.

  Missing rows use the resource type's application default. Ranked-war reports
  default to faction visibility for backward compatibility.
*/

CREATE TABLE IF NOT EXISTS resource_permissions (
  permission_id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  faction_id INTEGER NOT NULL,
  resource_type TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'faction'
    CHECK (visibility IN ('private', 'faction', 'public')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  UNIQUE(faction_id, resource_type, resource_key),

  FOREIGN KEY (owner_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (faction_id) REFERENCES factions(faction_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_permissions_lookup
ON resource_permissions(faction_id, resource_type, resource_key);

CREATE INDEX IF NOT EXISTS idx_resource_permissions_owner
ON resource_permissions(owner_user_id, faction_id, updated_at DESC);

/* Existing active war share links were already public by definition. */
INSERT OR IGNORE INTO resource_permissions (
  owner_user_id,
  faction_id,
  resource_type,
  resource_key,
  visibility,
  created_at,
  updated_at
)
SELECT
  sl.owner_user_id,
  sl.faction_id,
  sl.resource_type,
  sl.resource_key,
  'public',
  sl.created_at,
  sl.updated_at
FROM share_links sl
WHERE sl.is_enabled = 1
  AND sl.resource_type = 'war';
