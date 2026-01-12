import React, { useState, useEffect } from "react";
import { Header } from "@/components/dashboard/Header";
import { useAuth } from "@/hooks/useAuth";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TranscriptionSourceManager } from "@/components/transcription/TranscriptionSourceManager";
import { TranscriptionProgress } from "@/components/transcription/TranscriptionProgress";
import { TranscriptionQuickActions } from "@/components/transcription/TranscriptionQuickActions";
import { TranscriptionJobHistory } from "@/components/transcription/TranscriptionJobHistory";

const Transcribe = () => {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [user, authLoading, navigate]);

  const handleJobStarted = () => {
    setRefreshKey(prev => prev + 1);
  };

  const handleSourcesChange = () => {
    // Trigger refresh when sources change
    setRefreshKey(prev => prev + 1);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 pb-8">
        <Header />
        
        <div className="max-w-5xl mx-auto mt-8 space-y-6">
          {/* Progress indicator for active jobs */}
          <TranscriptionProgress key={`progress-${refreshKey}`} />

          <Tabs defaultValue="config" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="config">Configuration</TabsTrigger>
              <TabsTrigger value="history">Job History</TabsTrigger>
            </TabsList>

            <TabsContent value="config" className="space-y-6 mt-6">
              {/* Source Configuration */}
              <TranscriptionSourceManager onSourcesChange={handleSourcesChange} />

              {/* Quick Actions */}
              <TranscriptionQuickActions onJobStarted={handleJobStarted} />
            </TabsContent>

            <TabsContent value="history" className="mt-6">
              <TranscriptionJobHistory key={`history-${refreshKey}`} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
};

export default Transcribe;
