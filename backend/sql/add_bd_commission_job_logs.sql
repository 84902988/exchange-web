CREATE TABLE IF NOT EXISTS bd_commission_job_logs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  run_time DATETIME NOT NULL,
  status VARCHAR(50) NOT NULL,
  step VARCHAR(50) NOT NULL,
  processed_count INT NOT NULL DEFAULT 0,
  success_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  message VARCHAR(500) NOT NULL DEFAULT '',
  error_message TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bd_commission_job_logs_run_time (run_time),
  KEY idx_bd_commission_job_logs_status (status),
  KEY idx_bd_commission_job_logs_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
