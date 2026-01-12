import React from "react";
import { SyncIcon } from "@/components/icons/CloudIcons";
import { Button } from "@/components/ui/button";

interface SyncStatusProps {
  isSyncing: boolean;
  lastSync: string;
  filesCount: number;
  onSync: () => void;
  canSync?: boolean;
}

export const SyncStatus = ({ isSyncing, lastSync, filesCount, onSync, canSync = true }: SyncStatusProps) => {
  return (
    <div className="glass rounded-xl p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-display text-xl font-semibold text-foreground">Sync Status</h2>
        <Button 
          variant="gradient" 
          size="sm" 
          onClick={onSync}
          disabled={isSyncing || !canSync}
          className="gap-2"
          title={!canSync ? "Connect both accounts to sync" : undefined}
        >
          <SyncIcon className="w-4 h-4" spinning={isSyncing} />
          {isSyncing ? 'Syncing...' : 'Sync Now'}
        </Button>
      </div>
      
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-secondary/50 rounded-lg p-4">
          <p className="text-muted-foreground text-sm mb-1">Last Sync</p>
          <p className="font-display font-semibold text-foreground">{lastSync}</p>
        </div>
        <div className="bg-secondary/50 rounded-lg p-4">
          <p className="text-muted-foreground text-sm mb-1">Files Synced</p>
          <p className="font-display font-semibold text-foreground">{filesCount.toLocaleString()}</p>
        </div>
      </div>
      
      {!canSync && (
        <div className="mt-4 flex items-center gap-3 text-muted-foreground">
          <div className="w-2 h-2 rounded-full bg-muted-foreground/50" />
          <span className="text-sm">Connect both cloud services to enable sync</span>
        </div>
      )}
      
      {isSyncing && (
        <div className="mt-4 flex items-center gap-3 text-primary animate-pulse-slow">
          <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          <span className="text-sm">Synchronizing files between cloud services...</span>
        </div>
      )}
    </div>
  );
};
