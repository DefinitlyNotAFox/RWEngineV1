-- Raw attack rows are no longer persisted. Importers aggregate each page in
-- transient state and store only finalized per-member totals in war_log.

DELETE FROM app_meta
WHERE key LIKE 'attack_summary:%'
   OR key LIKE 'war_attack_accumulator_v1:%'
   OR key LIKE 'war_score_adjustment:%'
   OR key LIKE 'performance_chain_bonus_v1:%';

DROP TABLE IF EXISTS attacks;
