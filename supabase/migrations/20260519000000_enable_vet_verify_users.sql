-- Allow vets/admins to verify pending user accounts.
BEGIN;

DROP POLICY IF EXISTS "Enable vet verify users" ON public.users;
CREATE POLICY "Enable vet verify users"
ON public.users FOR UPDATE
USING (
  role = 'user'
  AND COALESCE(verified, false) = false
  AND COALESCE(declined, false) = false
  AND EXISTS (
    SELECT 1
    FROM public.users reviewer
    WHERE reviewer.user_id = auth.uid()
      AND reviewer.role IN ('vet', 'admin')
  )
)
WITH CHECK (
  role = 'user'
  AND COALESCE(verified, false) = true
  AND COALESCE(declined, false) = false
  AND EXISTS (
    SELECT 1
    FROM public.users reviewer
    WHERE reviewer.user_id = auth.uid()
      AND reviewer.role IN ('vet', 'admin')
  )
);

COMMIT;
