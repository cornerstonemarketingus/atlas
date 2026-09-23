-- Some deployments applied the later user/task migrations without completing
-- initial provisioning. Restore the two initial tables without replacing data.
CREATE TABLE IF NOT EXISTS installations (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  github_installation_id integer NOT NULL,
  account_login text NOT NULL,
  account_type text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS installations_github_installation_id_idx ON installations (github_installation_id);
CREATE TABLE IF NOT EXISTS repositories (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  installation_id integer REFERENCES installations(id),
  owner text NOT NULL,
  name text NOT NULL,
  merge_policy text DEFAULT 'manual' NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS repositories_owner_name_idx ON repositories (owner, name);
