-- Add DELETE policy to file_activity table for GDPR compliance (right to erasure)
CREATE POLICY "Users can delete their own file activity"
ON public.file_activity 
FOR DELETE 
USING (auth.uid() = user_id);