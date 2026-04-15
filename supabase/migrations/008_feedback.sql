-- Feedback table for user feedback collection
CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL,
  username TEXT,
  first_name TEXT,
  category TEXT NOT NULL DEFAULT 'general', -- bug, feature, general
  feedback_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for querying by user
CREATE INDEX idx_feedback_telegram_id ON feedback(telegram_id);
-- Index for filtering by category
CREATE INDEX idx_feedback_category ON feedback(category);
-- Index for time-based queries
CREATE INDEX idx_feedback_created_at ON feedback(created_at DESC);
