"use strict";
// Additive schema. Legacy/demo wallets are deliberately not backfilled into this ledger.
const ddl = `
CREATE TABLE IF NOT EXISTS agency_tenants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE NOT NULL, name text NOT NULL,
 status text NOT NULL DEFAULT 'sandbox' CHECK(status IN ('sandbox','active','suspended','closed')),
 environment text NOT NULL DEFAULT 'sandbox' CHECK(environment IN ('sandbox','live')),
 currency text NOT NULL DEFAULT 'IDR', coin_scale integer NOT NULL DEFAULT 0 CHECK(coin_scale BETWEEN 0 AND 12),
 coin_multiplier numeric(38,0) NOT NULL DEFAULT 1 CHECK(coin_multiplier>0),
 policy jsonb NOT NULL DEFAULT '{}', website jsonb NOT NULL DEFAULT '{}',
 config_version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agency_staff (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES agency_tenants(id),
 username text NOT NULL, display_name text NOT NULL, password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('owner','finance','supervisor','support','marketing','analyst')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 ip_allowlist jsonb NOT NULL DEFAULT '[]', mfa_secret text, mfa_enabled boolean NOT NULL DEFAULT false,
 mfa_last_step bigint NOT NULL DEFAULT -1, auth_version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,username), UNIQUE(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS agency_players (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES agency_tenants(id),
 username text NOT NULL, password_hash text NOT NULL, display_name text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','excluded')),
 limits jsonb NOT NULL DEFAULT '{}', auth_version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,username), UNIQUE(tenant_id,id)
);
ALTER TABLE agency_players ADD COLUMN IF NOT EXISTS profile jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS agency_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES agency_tenants(id),
 staff_id uuid, player_id uuid, token_hash text UNIQUE NOT NULL, auth_version integer NOT NULL,
 ip text NOT NULL, user_agent text NOT NULL, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(staff_id,player_id)=1),
 FOREIGN KEY(tenant_id,staff_id) REFERENCES agency_staff(tenant_id,id),
 FOREIGN KEY(tenant_id,player_id) REFERENCES agency_players(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS agency_sessions_expiry ON agency_sessions(expires_at);
CREATE TABLE IF NOT EXISTS agency_device_events (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, player_id uuid NOT NULL,
 ip text NOT NULL, user_agent text NOT NULL, fingerprint text NOT NULL, source text NOT NULL DEFAULT 'session-signal',
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,player_id) REFERENCES agency_players(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS agency_audit (
 id bigserial PRIMARY KEY, tenant_id uuid REFERENCES agency_tenants(id), actor text NOT NULL,
 action text NOT NULL, resource text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agency_audit_tenant_time ON agency_audit(tenant_id,id DESC);
CREATE TABLE IF NOT EXISTS agency_balances (
 tenant_id uuid NOT NULL REFERENCES agency_tenants(id), code text NOT NULL, unit text NOT NULL,
 amount numeric(38,0) NOT NULL DEFAULT 0, nonnegative boolean NOT NULL DEFAULT true,
 PRIMARY KEY(tenant_id,code,unit), CHECK(NOT nonnegative OR amount>=0)
);
CREATE TABLE IF NOT EXISTS agency_journals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES agency_tenants(id),
 business_id text NOT NULL, kind text NOT NULL, digest text NOT NULL, actor text NOT NULL,
 data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,business_id), UNIQUE(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS agency_entries (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, journal_id uuid NOT NULL,
 code text NOT NULL, unit text NOT NULL, delta numeric(38,0) NOT NULL CHECK(delta<>0),
 FOREIGN KEY(tenant_id,journal_id) REFERENCES agency_journals(tenant_id,id),
 FOREIGN KEY(tenant_id,code,unit) REFERENCES agency_balances(tenant_id,code,unit)
);
ALTER TABLE agency_journals ADD COLUMN IF NOT EXISTS posting_tx bigint NOT NULL DEFAULT txid_current();
CREATE OR REPLACE FUNCTION agency_entry_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF NOT EXISTS(SELECT 1 FROM agency_journals WHERE tenant_id=NEW.tenant_id AND id=NEW.journal_id AND posting_tx=txid_current())
 THEN RAISE EXCEPTION 'Cannot append to a finalized agency journal'; END IF;
 RETURN NEW; END; $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='agency_entry_insert_guard' AND tgrelid='agency_entries'::regclass) THEN
 CREATE TRIGGER agency_entry_insert_guard BEFORE INSERT ON agency_entries FOR EACH ROW EXECUTE FUNCTION agency_entry_insert_guard();
 END IF;
END $$;
CREATE OR REPLACE FUNCTION agency_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'Final ledger records are immutable'; END; $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='agency_journal_immutable' AND tgrelid='agency_journals'::regclass) THEN
 CREATE TRIGGER agency_journal_immutable BEFORE UPDATE OR DELETE ON agency_journals FOR EACH ROW EXECUTE FUNCTION agency_immutable();
 CREATE TRIGGER agency_entry_immutable BEFORE UPDATE OR DELETE ON agency_entries FOR EACH ROW EXECUTE FUNCTION agency_immutable();
 END IF;
END $$;
CREATE OR REPLACE FUNCTION agency_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF NOT EXISTS(SELECT 1 FROM agency_entries WHERE journal_id=NEW.id AND tenant_id=NEW.tenant_id)
 OR EXISTS(SELECT unit FROM agency_entries WHERE journal_id=NEW.id AND tenant_id=NEW.tenant_id GROUP BY unit HAVING sum(delta)<>0)
 THEN RAISE EXCEPTION 'Unbalanced agency journal'; END IF;
 RETURN NEW; END; $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='agency_journal_balanced' AND tgrelid='agency_journals'::regclass) THEN
 CREATE CONSTRAINT TRIGGER agency_journal_balanced AFTER INSERT ON agency_journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agency_balanced();
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS agency_allocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES agency_tenants(id),
 amount numeric(38,0) NOT NULL CHECK(amount>0), status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','rejected')),
 reason text NOT NULL, requested_by text NOT NULL, reviewed_by text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agency_gateway_accounts (
 tenant_id uuid PRIMARY KEY REFERENCES agency_tenants(id), mode text NOT NULL DEFAULT 'SHARED' CHECK(mode IN ('SHARED','SPLIT')),
 provider text NOT NULL DEFAULT 'simulation', deposit_account text NOT NULL, withdrawal_account text NOT NULL,
 version integer NOT NULL DEFAULT 1, verified boolean NOT NULL DEFAULT false,
 CHECK(mode<>'SHARED' OR deposit_account=withdrawal_account)
);
CREATE TABLE IF NOT EXISTS agency_transactions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, player_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('deposit','withdraw')), method text NOT NULL,
 amount numeric(38,0) NOT NULL CHECK(amount>0), coins numeric(38,0) NOT NULL CHECK(coins>0),
 state text NOT NULL, request_key text NOT NULL, request_digest text NOT NULL,
 account_ref text NOT NULL, account_version integer NOT NULL, policy_version integer NOT NULL,
 beneficiary text, created_by text NOT NULL, approved_by text, data jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,kind,request_key), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,player_id) REFERENCES agency_players(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS agency_payment_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES agency_tenants(id),
 provider text NOT NULL, account_ref text NOT NULL, event_ref text NOT NULL, digest text NOT NULL,
 transaction_id uuid, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,account_ref,event_ref), FOREIGN KEY(tenant_id,transaction_id) REFERENCES agency_transactions(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS agency_payout_jobs (
 tenant_id uuid NOT NULL, transaction_id uuid PRIMARY KEY, state text NOT NULL DEFAULT 'queued',
 provider_ref text, attempts integer NOT NULL DEFAULT 0, last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,transaction_id) REFERENCES agency_transactions(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS agency_approvals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, staff_id uuid NOT NULL,
 action text NOT NULL, resource text NOT NULL, digest text NOT NULL, token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, used_at timestamptz,
 FOREIGN KEY(tenant_id,staff_id) REFERENCES agency_staff(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS agency_game_releases (
 game_id uuid PRIMARY KEY REFERENCES gameops_games(id), version text NOT NULL DEFAULT '1',
 readiness text NOT NULL DEFAULT 'registered' CHECK(readiness IN ('registered','connectivity','rounds','launch','wallet','publishable')),
 launch_url text NOT NULL DEFAULT '', environment text NOT NULL DEFAULT 'sandbox', evidence text NOT NULL DEFAULT '',
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agency_games (
 tenant_id uuid NOT NULL REFERENCES agency_tenants(id), game_id uuid NOT NULL REFERENCES gameops_games(id),
 entitled boolean NOT NULL DEFAULT false, selected boolean NOT NULL DEFAULT false, position integer NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,game_id)
);
CREATE TABLE IF NOT EXISTS agency_launches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, player_id uuid NOT NULL, game_id uuid NOT NULL REFERENCES gameops_games(id),
 token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL, redeemed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,player_id) REFERENCES agency_players(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS agency_rounds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, player_id uuid NOT NULL, game_id uuid NOT NULL REFERENCES gameops_games(id),
 launch_id uuid NOT NULL, round_ref text NOT NULL, stake numeric(38,0) NOT NULL CHECK(stake>0), payout numeric(38,0),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','void')), evidence text, release_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
 UNIQUE(tenant_id,game_id,round_ref), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,player_id) REFERENCES agency_players(tenant_id,id), FOREIGN KEY(tenant_id,launch_id) REFERENCES agency_launches(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS agency_contracts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES agency_tenants(id),
 effective_period text NOT NULL, basis text NOT NULL CHECK(basis IN ('gross','net')), rate_bps integer NOT NULL DEFAULT 2000 CHECK(rate_bps BETWEEN 0 AND 10000),
 terms jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,effective_period)
);
CREATE TABLE IF NOT EXISTS agency_invoices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES agency_tenants(id), period text NOT NULL,
 total numeric(38,0) NOT NULL, paid numeric(38,0) NOT NULL DEFAULT 0, statement jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,period)
);
CREATE TABLE IF NOT EXISTS agency_banner_assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES agency_tenants(id),
 hash text NOT NULL, bytes bytea NOT NULL, width integer NOT NULL, height integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,hash)
);
CREATE TABLE IF NOT EXISTS agency_content (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES agency_tenants(id), slug text NOT NULL,
 version integer NOT NULL DEFAULT 1, draft jsonb NOT NULL DEFAULT '{}', published jsonb, scheduled_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,slug), UNIQUE(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS agency_content_revisions (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, content_id uuid NOT NULL, version integer NOT NULL, body jsonb NOT NULL,
 actor text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(content_id,version),
 FOREIGN KEY(tenant_id,content_id) REFERENCES agency_content(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS agency_domains (
 domain text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES agency_tenants(id), token text NOT NULL,
 verified_at timestamptz, is_primary boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agency_one_primary_domain ON agency_domains(tenant_id) WHERE is_primary;
CREATE TABLE IF NOT EXISTS agency_tickets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES agency_tenants(id), player_id uuid,
 subject text NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','pending','answered','closed')),
 messages jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,player_id) REFERENCES agency_players(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS agency_nonce (
 key_id text NOT NULL, nonce text NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(key_id,nonce)
);
`;
module.exports = { ddl };
