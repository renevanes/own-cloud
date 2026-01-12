-- Add DELETE policy for sync_jobs table
CREATE POLICY "Users can delete their own sync jobs"
ON public.sync_jobs 
FOR DELETE 
USING (auth.uid() = user_id);