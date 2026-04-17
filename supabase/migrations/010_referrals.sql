-- Migration 010: referral tracking
-- Adds referral_code + referred_by to users, creates referrals table

ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code text UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by bigint REFERENCES users(telegram_id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id bigint NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  referred_id bigint REFERENCES users(telegram_id) ON DELETE SET NULL,
  referral_code text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'converted')),
  shared_at timestamptz NOT NULL DEFAULT now(),
  converted_at timestamptz,
  UNIQUE(referrer_id, referred_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referral_code);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);
