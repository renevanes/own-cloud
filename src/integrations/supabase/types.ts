export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      ai_conversations: {
        Row: {
          created_at: string
          id: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          file_content: string | null
          file_name: string | null
          file_type: string | null
          id: string
          role: string
          user_id: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          file_content?: string | null
          file_name?: string | null
          file_type?: string | null
          id?: string
          role: string
          user_id: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          file_content?: string | null
          file_name?: string | null
          file_type?: string | null
          id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "ai_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      app_settings: {
        Row: {
          created_at: string
          id: string
          is_secret: boolean
          setting_key: string
          setting_value: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_secret?: boolean
          setting_key: string
          setting_value?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_secret?: boolean
          setting_key?: string
          setting_value?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      chat_conversations: {
        Row: {
          created_at: string
          first_message_at: string | null
          id: string
          last_message_at: string | null
          message_count: number
          name: string
          phone_number: string | null
          source_file: string
          source_type: string
          user_id: string
        }
        Insert: {
          created_at?: string
          first_message_at?: string | null
          id?: string
          last_message_at?: string | null
          message_count?: number
          name: string
          phone_number?: string | null
          source_file: string
          source_type: string
          user_id: string
        }
        Update: {
          created_at?: string
          first_message_at?: string | null
          id?: string
          last_message_at?: string | null
          message_count?: number
          name?: string
          phone_number?: string | null
          source_file?: string
          source_type?: string
          user_id?: string
        }
        Relationships: []
      }
      chat_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          id: string
          is_outgoing: boolean
          media_url: string | null
          message_type: string
          sender: string
          sent_at: string
          user_id: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          id?: string
          is_outgoing?: boolean
          media_url?: string | null
          message_type?: string
          sender: string
          sent_at: string
          user_id: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          is_outgoing?: boolean
          media_url?: string | null
          message_type?: string
          sender?: string
          sent_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "chat_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      connected_accounts: {
        Row: {
          access_token: string
          account_email: string | null
          account_id: string | null
          account_name: string | null
          created_at: string
          id: string
          permission_level: string | null
          provider: string
          refresh_token: string | null
          storage_total: number | null
          storage_used: number | null
          token_expires_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token: string
          account_email?: string | null
          account_id?: string | null
          account_name?: string | null
          created_at?: string
          id?: string
          permission_level?: string | null
          provider: string
          refresh_token?: string | null
          storage_total?: number | null
          storage_used?: number | null
          token_expires_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string
          account_email?: string | null
          account_id?: string | null
          account_name?: string | null
          created_at?: string
          id?: string
          permission_level?: string | null
          provider?: string
          refresh_token?: string | null
          storage_total?: number | null
          storage_used?: number | null
          token_expires_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      file_activity: {
        Row: {
          action: string
          created_at: string
          file_name: string
          file_type: string
          id: string
          source: string
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          file_name: string
          file_type: string
          id?: string
          source: string
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          file_name?: string
          file_type?: string
          id?: string
          source?: string
          user_id?: string
        }
        Relationships: []
      }
      invoice_scan_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          date_from: string | null
          date_to: string | null
          emails_scanned: number | null
          error_message: string | null
          id: string
          invoices_found: number | null
          labels: string[] | null
          started_at: string | null
          status: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          date_from?: string | null
          date_to?: string | null
          emails_scanned?: number | null
          error_message?: string | null
          id?: string
          invoices_found?: number | null
          labels?: string[] | null
          started_at?: string | null
          status?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          date_from?: string | null
          date_to?: string | null
          emails_scanned?: number | null
          error_message?: string | null
          id?: string
          invoices_found?: number | null
          labels?: string[] | null
          started_at?: string | null
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      provider_credentials: {
        Row: {
          created_at: string
          credentials: Json
          id: string
          is_configured: boolean
          provider: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          credentials?: Json
          id?: string
          is_configured?: boolean
          provider: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          credentials?: Json
          id?: string
          is_configured?: boolean
          provider?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      scanned_invoices: {
        Row: {
          confidence_score: number | null
          created_at: string
          email_date: string | null
          email_from: string | null
          email_id: string
          email_subject: string | null
          id: string
          invoice_amount: number | null
          invoice_filename: string
          invoice_storage_path: string
          status: string
          updated_at: string
          user_id: string
          vendor_name: string | null
        }
        Insert: {
          confidence_score?: number | null
          created_at?: string
          email_date?: string | null
          email_from?: string | null
          email_id: string
          email_subject?: string | null
          id?: string
          invoice_amount?: number | null
          invoice_filename: string
          invoice_storage_path: string
          status?: string
          updated_at?: string
          user_id: string
          vendor_name?: string | null
        }
        Update: {
          confidence_score?: number | null
          created_at?: string
          email_date?: string | null
          email_from?: string | null
          email_id?: string
          email_subject?: string | null
          id?: string
          invoice_amount?: number | null
          invoice_filename?: string
          invoice_storage_path?: string
          status?: string
          updated_at?: string
          user_id?: string
          vendor_name?: string | null
        }
        Relationships: []
      }
      sync_folders: {
        Row: {
          created_at: string
          id: string
          last_synced_at: string | null
          next_sync_at: string | null
          source_account_id: string | null
          source_folder_id: string
          source_folder_path: string
          source_provider: string
          sync_enabled: boolean
          sync_schedule: string | null
          target_account_id: string | null
          target_folder_id: string | null
          target_folder_path: string | null
          target_provider: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_synced_at?: string | null
          next_sync_at?: string | null
          source_account_id?: string | null
          source_folder_id: string
          source_folder_path: string
          source_provider: string
          sync_enabled?: boolean
          sync_schedule?: string | null
          target_account_id?: string | null
          target_folder_id?: string | null
          target_folder_path?: string | null
          target_provider: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_synced_at?: string | null
          next_sync_at?: string | null
          source_account_id?: string | null
          source_folder_id?: string
          source_folder_path?: string
          source_provider?: string
          sync_enabled?: boolean
          sync_schedule?: string | null
          target_account_id?: string | null
          target_folder_id?: string | null
          target_folder_path?: string | null
          target_provider?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_folders_source_account_id_fkey"
            columns: ["source_account_id"]
            isOneToOne: false
            referencedRelation: "connected_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_folders_target_account_id_fkey"
            columns: ["target_account_id"]
            isOneToOne: false
            referencedRelation: "connected_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_jobs: {
        Row: {
          batch_size: number | null
          completed_at: string | null
          created_at: string
          error_message: string | null
          file_list: Json | null
          files_synced: number | null
          files_total: number | null
          id: string
          resume_from_index: number | null
          started_at: string | null
          status: string
          sync_folder_id: string | null
          user_id: string
        }
        Insert: {
          batch_size?: number | null
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          file_list?: Json | null
          files_synced?: number | null
          files_total?: number | null
          id?: string
          resume_from_index?: number | null
          started_at?: string | null
          status?: string
          sync_folder_id?: string | null
          user_id: string
        }
        Update: {
          batch_size?: number | null
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          file_list?: Json | null
          files_synced?: number | null
          files_total?: number | null
          id?: string
          resume_from_index?: number | null
          started_at?: string | null
          status?: string
          sync_folder_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_jobs_sync_folder_id_fkey"
            columns: ["sync_folder_id"]
            isOneToOne: false
            referencedRelation: "sync_folders"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_logs: {
        Row: {
          action: string
          completed_at: string | null
          created_at: string
          error_message: string | null
          file_size: number | null
          id: string
          source_file_id: string | null
          source_file_name: string | null
          status: string
          sync_folder_id: string | null
          sync_job_id: string | null
          target_file_id: string | null
          target_file_name: string | null
          user_id: string
        }
        Insert: {
          action: string
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          file_size?: number | null
          id?: string
          source_file_id?: string | null
          source_file_name?: string | null
          status?: string
          sync_folder_id?: string | null
          sync_job_id?: string | null
          target_file_id?: string | null
          target_file_name?: string | null
          user_id: string
        }
        Update: {
          action?: string
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          file_size?: number | null
          id?: string
          source_file_id?: string | null
          source_file_name?: string | null
          status?: string
          sync_folder_id?: string | null
          sync_job_id?: string | null
          target_file_id?: string | null
          target_file_name?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_logs_sync_folder_id_fkey"
            columns: ["sync_folder_id"]
            isOneToOne: false
            referencedRelation: "sync_folders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_logs_sync_job_id_fkey"
            columns: ["sync_job_id"]
            isOneToOne: false
            referencedRelation: "sync_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      transcription_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          error_message: string | null
          files_processed: number | null
          files_skipped: number | null
          files_total: number | null
          id: string
          started_at: string | null
          status: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          files_processed?: number | null
          files_skipped?: number | null
          files_total?: number | null
          id?: string
          started_at?: string | null
          status?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          files_processed?: number | null
          files_skipped?: number | null
          files_total?: number | null
          id?: string
          started_at?: string | null
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      transcription_logs: {
        Row: {
          completed_at: string | null
          created_at: string
          duration_seconds: number | null
          error_message: string | null
          file_size: number | null
          id: string
          source_file_id: string
          source_file_name: string
          source_file_path: string | null
          source_provider: string
          status: string
          transcription_id: string | null
          transcription_job_id: string | null
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          duration_seconds?: number | null
          error_message?: string | null
          file_size?: number | null
          id?: string
          source_file_id: string
          source_file_name: string
          source_file_path?: string | null
          source_provider: string
          status?: string
          transcription_id?: string | null
          transcription_job_id?: string | null
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          duration_seconds?: number | null
          error_message?: string | null
          file_size?: number | null
          id?: string
          source_file_id?: string
          source_file_name?: string
          source_file_path?: string | null
          source_provider?: string
          status?: string
          transcription_id?: string | null
          transcription_job_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transcription_logs_transcription_job_id_fkey"
            columns: ["transcription_job_id"]
            isOneToOne: false
            referencedRelation: "transcription_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      transcription_sources: {
        Row: {
          created_at: string
          folder_id: string
          folder_name: string
          folder_path: string
          id: string
          item_type: string
          last_scanned_at: string | null
          next_scan_at: string | null
          provider: string
          scan_enabled: boolean
          scan_schedule: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          folder_id: string
          folder_name: string
          folder_path: string
          id?: string
          item_type?: string
          last_scanned_at?: string | null
          next_scan_at?: string | null
          provider: string
          scan_enabled?: boolean
          scan_schedule?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          folder_id?: string
          folder_name?: string
          folder_path?: string
          id?: string
          item_type?: string
          last_scanned_at?: string | null
          next_scan_at?: string | null
          provider?: string
          scan_enabled?: boolean
          scan_schedule?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      decrypt_token: { Args: { encrypted_value: string }; Returns: string }
      encrypt_token: { Args: { token_value: string }; Returns: string }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
