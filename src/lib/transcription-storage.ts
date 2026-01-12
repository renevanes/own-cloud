// Transcription storage service
// Stores transcriptions in Supabase Storage under /Transcriptions/ path

import { supabase } from "@/integrations/supabase/client";

export interface StoredTranscription {
  id: string;
  fileName: string;
  sourceProvider: "onedrive" | "google_drive" | "recording" | "local_storage";
  sourcePath: string;
  transcription: string;
  segments: TranscriptionSegment[];
  createdAt: string;
  duration?: number;
  // Call metadata fields
  callDate?: string; // Original call date (when the call actually happened)
  callerName?: string;
  callerPhone?: string;
  callDirection?: 'inbound' | 'outbound';
  callType?: 'phone' | 'meeting' | 'voice_memo' | 'other';
  notes?: string;
  tags?: string[];
}

export interface TranscriptionSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

export interface ConfiguredSource {
  id: string;
  name: string;
  path: string;
  provider: "onedrive" | "google_drive" | "local_storage";
  type: "file" | "folder";
  accountId?: string;
}

// Backwards compatibility alias
export type ConfiguredFolder = ConfiguredSource;

const CONFIGURED_FOLDERS_KEY = "transcribe/configured_folders";

// Get all stored transcriptions from Supabase Storage
export const getStoredTranscriptions = async (userId: string): Promise<StoredTranscription[]> => {
  try {
    const { data: files, error } = await supabase.storage
      .from("user-files")
      .list(`${userId}/Transcriptions`, {
        limit: 500,
        sortBy: { column: 'created_at', order: 'desc' }
      });

    if (error) {
      console.error("Error listing transcriptions:", error);
      return [];
    }

    const transcriptions: StoredTranscription[] = [];
    
    for (const file of files || []) {
      if (file.name.endsWith('.json') && file.id !== null) {
        try {
          const { data, error: downloadError } = await supabase.storage
            .from("user-files")
            .download(`${userId}/Transcriptions/${file.name}`);
          
          if (downloadError) continue;
          
          const text = await data.text();
          const transcription = JSON.parse(text) as StoredTranscription;
          transcriptions.push(transcription);
        } catch (e) {
          console.error("Error reading transcription:", e);
        }
      }
    }

    return transcriptions;
  } catch (error) {
    console.error("Error getting transcriptions:", error);
    return [];
  }
};

// Sync version for components that need immediate access (uses cache)
let transcriptionCache: StoredTranscription[] = [];
let cacheUserId: string | null = null;

export const getStoredTranscriptionsSync = (): StoredTranscription[] => {
  return transcriptionCache;
};

export const refreshTranscriptionCache = async (userId: string): Promise<StoredTranscription[]> => {
  transcriptionCache = await getStoredTranscriptions(userId);
  cacheUserId = userId;
  return transcriptionCache;
};

// Save a new transcription to Supabase Storage
export const saveTranscription = async (
  userId: string,
  transcription: Omit<StoredTranscription, "id" | "createdAt">
): Promise<StoredTranscription | null> => {
  try {
    const newTranscription: StoredTranscription = {
      ...transcription,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };

    const fileName = `${newTranscription.id}.json`;
    const content = JSON.stringify(newTranscription, null, 2);
    
    const { error } = await supabase.storage
      .from("user-files")
      .upload(`${userId}/Transcriptions/${fileName}`, content, {
        contentType: 'application/json',
        upsert: true
      });

    if (error) {
      console.error("Error saving transcription:", error);
      return null;
    }

    // Update cache
    transcriptionCache.unshift(newTranscription);

    return newTranscription;
  } catch (error) {
    console.error("Error saving transcription:", error);
    return null;
  }
};

// Delete a transcription from Supabase Storage
export const deleteTranscription = async (userId: string, id: string): Promise<boolean> => {
  try {
    const { error } = await supabase.storage
      .from("user-files")
      .remove([`${userId}/Transcriptions/${id}.json`]);

    if (error) {
      console.error("Error deleting transcription:", error);
      return false;
    }

    // Update cache
    transcriptionCache = transcriptionCache.filter(t => t.id !== id);

    return true;
  } catch (error) {
    console.error("Error deleting transcription:", error);
    return false;
  }
};

// Get configured folders (still uses localStorage as it's config data)
export const getConfiguredFolders = (): ConfiguredFolder[] => {
  try {
    const data = localStorage.getItem(CONFIGURED_FOLDERS_KEY);
    return data ? JSON.parse(data) : [];
  } catch (error) {
    console.error("Error reading configured folders from localStorage:", error);
    return [];
  }
};

// Add a configured folder
export const addConfiguredFolder = (folder: ConfiguredFolder): void => {
  const folders = getConfiguredFolders();
  
  // Check if folder already exists
  if (folders.some((f) => f.id === folder.id && f.provider === folder.provider)) {
    return;
  }
  
  folders.push(folder);
  localStorage.setItem(CONFIGURED_FOLDERS_KEY, JSON.stringify(folders));
};

// Remove a configured folder
export const removeConfiguredFolder = (id: string, provider: string): void => {
  const folders = getConfiguredFolders();
  const filtered = folders.filter((f) => !(f.id === id && f.provider === provider));
  localStorage.setItem(CONFIGURED_FOLDERS_KEY, JSON.stringify(filtered));
};

// Clear all configured folders
export const clearConfiguredFolders = (): void => {
  localStorage.setItem(CONFIGURED_FOLDERS_KEY, JSON.stringify([]));
};

// Ensure the Transcriptions folder exists
export const ensureTranscriptionsFolderExists = async (userId: string): Promise<void> => {
  try {
    // Check if folder exists by trying to list it
    const { data, error } = await supabase.storage
      .from("user-files")
      .list(`${userId}/Transcriptions`, { limit: 1 });

    // If error or no data, create the folder with a placeholder
    if (error || !data) {
      await supabase.storage
        .from("user-files")
        .upload(`${userId}/Transcriptions/.placeholder`, '', {
          contentType: 'text/plain'
        });
    }
  } catch (error) {
    console.error("Error ensuring transcriptions folder:", error);
  }
};
