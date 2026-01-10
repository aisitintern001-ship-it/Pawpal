-- Migration: Allow admins and vets to view adoption records
-- Purpose: ensure admin adoption management can read adoption requests/applications

BEGIN;

-- Ensure RLS is enabled (no-op if already enabled)
ALTER TABLE IF EXISTS public.adoption_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.adoption_applications ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE polname = 'admins view adoption requests'
      AND tablename = 'adoption_requests'
  ) THEN
    CREATE POLICY "admins view adoption requests"
    ON public.adoption_requests
    FOR SELECT
    TO authenticated
    USING (
      requester_id = auth.uid()
      OR owner_id = auth.uid()
      OR EXISTS (
        SELECT 1
        FROM public.users reviewer
        WHERE reviewer.user_id = auth.uid()
          AND reviewer.role IN ('admin', 'vet')
      )
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE polname = 'admins view adoption applications'
      AND tablename = 'adoption_applications'
  ) THEN
    CREATE POLICY "admins view adoption applications"
    ON public.adoption_applications
    FOR SELECT
    TO authenticated
    USING (
      applicant_id = auth.uid()
      OR EXISTS (
        SELECT 1
        FROM public.users reviewer
        WHERE reviewer.user_id = auth.uid()
          AND reviewer.role IN ('admin', 'vet')
      )
    );
  END IF;
END $$;

COMMIT;















