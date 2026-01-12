import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface ConnectedAccount {
  id: string;
  provider: string;
  account_email: string | null;
  account_name: string | null;
  storage_used: number | null;
  storage_total: number | null;
  permission_level: string | null;
}

export interface LocalStorageAccount {
  id: string;
  provider: 'local_storage';
  account_email: string | null;
  account_name: string;
  storage_used: number;
  storage_total: number;
}

export type StorageAccount = ConnectedAccount | LocalStorageAccount;

export const useConnectedAccounts = () => {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAccounts = useCallback(async () => {
    if (!user) {
      setAccounts([]);
      setLoading(false);
      return;
    }

    try {
      const { data, error } = await supabase
        .from("connected_accounts")
        .select("id, provider, account_email, account_name, storage_used, storage_total, permission_level")
        .eq("user_id", user.id);

      if (error) throw error;
      setAccounts(data || []);
    } catch (err) {
      console.error("Failed to fetch connected accounts:", err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // Get all accounts for a specific provider
  const getAccountsByProvider = (provider: string): ConnectedAccount[] => {
    return accounts.filter(acc => acc.provider === provider);
  };

  // Get first account for a provider (for backward compatibility)
  const getAccount = (provider: string): ConnectedAccount | undefined => {
    return accounts.find(acc => acc.provider === provider);
  };

  // Check if any account of this provider is connected
  const isConnected = (provider: string): boolean => {
    return accounts.some(acc => acc.provider === provider);
  };

  // Get local storage as a virtual account
  const getLocalStorageAccount = (): LocalStorageAccount | null => {
    if (!user) return null;
    return {
      id: 'local_storage',
      provider: 'local_storage',
      account_email: user.email || null,
      account_name: 'Local Storage',
      storage_used: 0, // Could calculate from actual storage usage
      storage_total: 100 * 1024 * 1024 * 1024, // 100GB virtual limit
    };
  };

  // Get all accounts including local storage
  const getAllStorageAccounts = (): StorageAccount[] => {
    const result: StorageAccount[] = [];
    
    // Always add local storage first if user is logged in
    const localAccount = getLocalStorageAccount();
    if (localAccount) {
      result.push(localAccount);
    }

    // Add all cloud accounts
    result.push(...accounts);

    return result;
  };

  // Group accounts by provider type
  const getGroupedAccounts = (): Record<string, StorageAccount[]> => {
    const grouped: Record<string, StorageAccount[]> = {};
    
    const localAccount = getLocalStorageAccount();
    if (localAccount) {
      grouped['local_storage'] = [localAccount];
    }

    accounts.forEach(acc => {
      if (!grouped[acc.provider]) {
        grouped[acc.provider] = [];
      }
      grouped[acc.provider].push(acc);
    });

    return grouped;
  };

  // Get OneDrive accounts (multiple possible)
  const onedriveAccounts = getAccountsByProvider("onedrive");
  const googleDriveAccounts = getAccountsByProvider("google_drive");

  return {
    accounts,
    loading,
    refetch: fetchAccounts,
    getAccount,
    getAccountsByProvider,
    isConnected,
    getLocalStorageAccount,
    getAllStorageAccounts,
    getGroupedAccounts,
    // Arrays for multiple accounts
    onedriveAccounts,
    googleDriveAccounts,
    // Legacy single account getters (first account of each type)
    onedriveAccount: getAccount("onedrive"),
    googleDriveAccount: getAccount("google_drive"),
    onedriveConnected: isConnected("onedrive"),
    googleDriveConnected: isConnected("google_drive"),
  };
};
