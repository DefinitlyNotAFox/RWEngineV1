PRAGMA foreign_keys = ON;

/*
  Faction permissions are intentionally separate from users.is_admin.
  Platform administrators retain global access; faction administrators can
  manage only the faction represented by this row.
*/
CREATE TABLE IF NOT EXISTS faction_user_roles (
  faction_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (faction_id, user_id, role),
  FOREIGN KEY (faction_id) REFERENCES factions(faction_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_faction_user_roles_user
ON faction_user_roles(user_id, faction_id, role);

/*
  Notes are one compact record per faction member. Empty notes are deleted by
  the application so this table does not accumulate placeholder rows.
*/
CREATE TABLE IF NOT EXISTS member_notes (
  faction_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  note_text TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  updated_by_user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (faction_id, player_id),
  FOREIGN KEY (faction_id, player_id)
    REFERENCES faction_members(faction_id, player_id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_member_notes_faction_updated
ON member_notes(faction_id, updated_at DESC);
