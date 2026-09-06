-- ─────────────────────────────────────────────────────────────────────────────
-- 001_initial.sql — Core schema for the Scraping & Automation Framework
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── jobs ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL,
    scraper     TEXT        NOT NULL,
    status      TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','queued','running','completed','failed','cancelled')),
    input       JSONB       NOT NULL DEFAULT '{}',
    priority    INT         NOT NULL DEFAULT 0,
    scheduled_at TIMESTAMPTZ,
    started_at  TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_jobs_status     ON jobs(status);
CREATE INDEX idx_jobs_scraper    ON jobs(scraper);
CREATE INDEX idx_jobs_scheduled  ON jobs(scheduled_at) WHERE scheduled_at IS NOT NULL;

-- ── job_runs ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_runs (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id      UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    attempt     INT         NOT NULL DEFAULT 1,
    status      TEXT        NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running','completed','failed')),
    error       TEXT,
    duration_ms INT,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at    TIMESTAMPTZ
);

CREATE INDEX idx_job_runs_job_id ON job_runs(job_id);

-- ── scraping_results ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scraping_results (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id      UUID        REFERENCES jobs(id) ON DELETE SET NULL,
    scraper     TEXT        NOT NULL,
    url         TEXT,
    data        JSONB       NOT NULL DEFAULT '{}',
    scraped_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_results_job_id  ON scraping_results(job_id);
CREATE INDEX idx_results_scraper ON scraping_results(scraper);
CREATE INDEX idx_results_data    ON scraping_results USING gin(data);

-- ── proxies ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proxies (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    provider    TEXT        NOT NULL,
    protocol    TEXT        NOT NULL DEFAULT 'http',
    host        TEXT        NOT NULL,
    port        INT         NOT NULL,
    username    TEXT,
    country     CHAR(2),
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    failure_count INT       NOT NULL DEFAULT 0,
    last_used_at  TIMESTAMPTZ,
    last_checked_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_proxies_host_port ON proxies(host, port);
CREATE INDEX idx_proxies_country ON proxies(country) WHERE country IS NOT NULL;
CREATE INDEX idx_proxies_active  ON proxies(is_active);

-- ── captcha_logs ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS captcha_logs (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id      UUID        REFERENCES jobs(id) ON DELETE SET NULL,
    provider    TEXT        NOT NULL,
    type        TEXT        NOT NULL,
    success     BOOLEAN     NOT NULL,
    duration_ms INT,
    cost_usd    NUMERIC(10,6),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_captcha_logs_job_id ON captcha_logs(job_id);
CREATE INDEX idx_captcha_logs_provider ON captcha_logs(provider);

-- ── browser_sessions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS browser_sessions (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id      UUID        REFERENCES jobs(id) ON DELETE SET NULL,
    engine      TEXT        NOT NULL,
    proxy_host  TEXT,
    user_agent  TEXT,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at    TIMESTAMPTZ,
    pages_visited INT       NOT NULL DEFAULT 0
);

-- ── Trigger: auto-update updated_at on jobs ───────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_jobs_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
