-- Migration: push_tokens RLS policies for admin marking
-- This migration adds RLS policies to the push_tokens table to allow users to:
-- 1. Insert their own push token (for registration)
-- 2. Update their own push token's is_admin flag (for marking as admin)
-- 3. Admins can read all tokens (for sending notifications)

-- Enable RLS on push_tokens (if not already enabled)
ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;

-- Policy: Users can insert their own push token
CREATE POLICY "Users can insert own push token" ON push_tokens
FOR INSERT
WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

-- Policy: Users can update their own push token (including is_admin flag)
CREATE POLICY "Users can update own push token" ON push_tokens
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Policy: Users can read their own push token
CREATE POLICY "Users can read own push token" ON push_tokens
FOR SELECT
USING (auth.uid() = user_id);

-- Policy: Service role (admin) can read all push tokens (for sending notifications)
-- This is handled by the service role key which bypasses RLS

-- Also ensure the table has the is_admin column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'push_tokens' AND column_name = 'is_admin'
    ) THEN
        ALTER TABLE push_tokens ADD COLUMN is_admin BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- Index for faster admin token queries
CREATE INDEX IF NOT EXISTS idx_push_tokens_is_admin ON push_tokens(is_admin) WHERE is_admin = TRUE;
CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id ON push_tokens(user_id);