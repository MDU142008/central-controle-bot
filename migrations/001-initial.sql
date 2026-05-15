-- Etapa 5 — D1 mirror inicial de "03. ADS NOVOS".
--
-- Estratégia mono-tenant (Etapa 4 multi-tenant agregará tenant_id depois):
--   - tabela `ads`: 1 fila por row do spreadsheet (UNIQUE por source_aba+source_row).
--     Upsert via ON CONFLICT no sync — mantém o id estável mesmo após edições.
--   - virtual table `ads_fts`: FTS5 sobre campos textuais para o QA bot da Etapa 7.
--     Triggers AFTER INSERT/UPDATE/DELETE mantêm ads_fts sincronizado com ads.
--   - tabela `_sync_log`: cada execução do cron (ou /teste_d1) deixa rastro.
--     Health check via `SELECT MAX(ran_at) FROM _sync_log WHERE status='ok'`.
--
-- Booleans (REVISÃO FINAL, GESTOR DE ADS RECEBEU) viram INTEGER 0/1 (SQLite
-- não tem bool nativo). O conversor em src/d1/sync.ts é tolerante a vários
-- inputs (TRUE/true/verdadeiro/sim/1, FALSE/false/falso/não/0).
--
-- Aplicar com: npx wrangler d1 execute cc-bot-mirror --file migrations/001-initial.sql --remote

CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Origem na Sheet (multi-tenant Etapa 4 agrega tenant_id antes destes).
  source_aba TEXT NOT NULL,
  source_row INTEGER NOT NULL, -- 1-indexed (linha 2 = primeira fila de dados)
  -- Colunas mapeadas de "03. ADS NOVOS".
  fase TEXT,
  nome TEXT,
  copy_status TEXT,
  link_copy TEXT,
  design_ou_edicao TEXT,
  status TEXT,
  responsavel TEXT,
  link_ads_finalizado TEXT,
  revisao_final INTEGER,         -- bool 0/1
  gestor_de_ads_recebeu INTEGER, -- bool 0/1
  -- Metadata de sync.
  last_synced_at TEXT NOT NULL,  -- ISO 8601
  UNIQUE(source_aba, source_row)
);

CREATE INDEX IF NOT EXISTS idx_ads_fase ON ads(fase);
CREATE INDEX IF NOT EXISTS idx_ads_status ON ads(status);
CREATE INDEX IF NOT EXISTS idx_ads_responsavel ON ads(responsavel);
CREATE INDEX IF NOT EXISTS idx_ads_nome ON ads(nome);

-- FTS5: índice de full-text search sobre campos textuais que o QA bot da
-- Etapa 7 vai querer pesquisar. `content='ads'` faz com que ads_fts não
-- guarde duplicado dos dados (apenas o índice invertido), e os triggers
-- abaixo o mantêm sincronizado com a tabela `ads`.
CREATE VIRTUAL TABLE IF NOT EXISTS ads_fts USING fts5(
  fase, nome, copy_status, link_copy, design_ou_edicao, status, responsavel,
  content='ads',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS ads_ai AFTER INSERT ON ads BEGIN
  INSERT INTO ads_fts(rowid, fase, nome, copy_status, link_copy, design_ou_edicao, status, responsavel)
  VALUES (new.id, new.fase, new.nome, new.copy_status, new.link_copy, new.design_ou_edicao, new.status, new.responsavel);
END;

CREATE TRIGGER IF NOT EXISTS ads_ad AFTER DELETE ON ads BEGIN
  INSERT INTO ads_fts(ads_fts, rowid, fase, nome, copy_status, link_copy, design_ou_edicao, status, responsavel)
  VALUES('delete', old.id, old.fase, old.nome, old.copy_status, old.link_copy, old.design_ou_edicao, old.status, old.responsavel);
END;

CREATE TRIGGER IF NOT EXISTS ads_au AFTER UPDATE ON ads BEGIN
  INSERT INTO ads_fts(ads_fts, rowid, fase, nome, copy_status, link_copy, design_ou_edicao, status, responsavel)
  VALUES('delete', old.id, old.fase, old.nome, old.copy_status, old.link_copy, old.design_ou_edicao, old.status, old.responsavel);
  INSERT INTO ads_fts(rowid, fase, nome, copy_status, link_copy, design_ou_edicao, status, responsavel)
  VALUES (new.id, new.fase, new.nome, new.copy_status, new.link_copy, new.design_ou_edicao, new.status, new.responsavel);
END;

-- Log de cada execução do cron (ou /teste_d1, ou manual).
-- Consultado por /status_d1 e (futuro) por alertas se ran_at fica obsoleto.
CREATE TABLE IF NOT EXISTS _sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT NOT NULL,        -- ISO 8601
  trigger TEXT NOT NULL,       -- 'cron' | 'teste_d1' | 'manual'
  source_aba TEXT,             -- null se a resolução de aba falhou
  rows_synced INTEGER NOT NULL,
  status TEXT NOT NULL,        -- 'ok' | 'error'
  error_msg TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sync_log_ran_at ON _sync_log(ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_log_status ON _sync_log(status);
