import React, { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { Loader2, Eye, EyeOff, Save, Globe, Key } from "lucide-react";
import { OneDriveIcon, GoogleDriveIcon } from "@/components/icons/CloudIcons";

interface SettingField {
  key: string;
  label: string;
  placeholder: string;
  isSecret: boolean;
}

interface ProviderConfig {
  name: string;
  icon: React.ReactNode;
  fields: SettingField[];
}

const settingsConfig: Record<string, ProviderConfig> = {
  app: {
    name: "Application",
    icon: <Globe className="w-5 h-5" />,
    fields: [
      { key: "APP_URL", label: "Application URL", placeholder: "https://your-app.lovable.app", isSecret: false },
    ],
  },
  microsoft: {
    name: "Microsoft OneDrive",
    icon: <OneDriveIcon className="w-5 h-5 text-onedrive" />,
    fields: [
      { key: "MICROSOFT_CLIENT_ID", label: "Client ID", placeholder: "Your Microsoft App Client ID", isSecret: false },
      { key: "MICROSOFT_CLIENT_SECRET", label: "Client Secret", placeholder: "Your Microsoft App Client Secret", isSecret: true },
    ],
  },
  google: {
    name: "Google Drive",
    icon: <GoogleDriveIcon className="w-5 h-5 text-google-drive" />,
    fields: [
      { key: "GOOGLE_CLIENT_ID", label: "Client ID", placeholder: "Your Google OAuth Client ID", isSecret: false },
      { key: "GOOGLE_CLIENT_SECRET", label: "Client Secret", placeholder: "Your Google OAuth Client Secret", isSecret: true },
    ],
  },
};

const AppSettings: React.FC = () => {
  const { user } = useAuth();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [visibleSecrets, setVisibleSecrets] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (user) {
      loadSettings();
    }
  }, [user]);

  const loadSettings = async () => {
    if (!user) return;
    
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from("app_settings")
        .select("setting_key, setting_value, is_secret")
        .eq("user_id", user.id);

      if (error) throw error;

      const settingsMap: Record<string, string> = {};
      data?.forEach((item) => {
        settingsMap[item.setting_key] = item.setting_value || "";
      });
      setSettings(settingsMap);
    } catch (error) {
      console.error("Error loading settings:", error);
      toast.error("Failed to load settings");
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const toggleSecretVisibility = (key: string) => {
    setVisibleSecrets((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const saveSettings = async (providerKey: string) => {
    if (!user) return;

    const config = settingsConfig[providerKey];
    if (!config) return;

    setSaving((prev) => ({ ...prev, [providerKey]: true }));

    try {
      for (const field of config.fields) {
        const value = settings[field.key] || "";
        
        const { error } = await supabase
          .from("app_settings")
          .upsert({
            user_id: user.id,
            setting_key: field.key,
            setting_value: value,
            is_secret: field.isSecret,
            updated_at: new Date().toISOString(),
          }, { onConflict: "user_id,setting_key" });

        if (error) throw error;
      }

      toast.success(`${config.name} settings saved`);
    } catch (error) {
      console.error("Error saving settings:", error);
      toast.error("Failed to save settings");
    } finally {
      setSaving((prev) => ({ ...prev, [providerKey]: false }));
    }
  };

  const isConfigured = (providerKey: string): boolean => {
    const config = settingsConfig[providerKey];
    if (!config) return false;
    return config.fields.every((field) => settings[field.key]?.trim());
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-sm text-muted-foreground mb-4">
        Configure your OAuth credentials and application settings. These settings are stored securely and used for connecting to cloud storage providers.
      </div>

      {Object.entries(settingsConfig).map(([providerKey, config]) => (
        <Card key={providerKey} className="glass">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {config.icon}
                <div>
                  <CardTitle className="text-lg">{config.name}</CardTitle>
                  <CardDescription>
                    {isConfigured(providerKey) ? (
                      <span className="text-green-500">✓ Configured</span>
                    ) : (
                      <span className="text-amber-500">Not configured</span>
                    )}
                  </CardDescription>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {config.fields.map((field) => (
              <div key={field.key} className="space-y-2">
                <Label htmlFor={field.key} className="flex items-center gap-2">
                  {field.isSecret && <Key className="w-3 h-3 text-muted-foreground" />}
                  {field.label}
                </Label>
                <div className="relative">
                  <Input
                    id={field.key}
                    type={field.isSecret && !visibleSecrets[field.key] ? "password" : "text"}
                    value={settings[field.key] || ""}
                    onChange={(e) => handleInputChange(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    className="pr-10"
                  />
                  {field.isSecret && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                      onClick={() => toggleSecretVisibility(field.key)}
                    >
                      {visibleSecrets[field.key] ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </Button>
                  )}
                </div>
              </div>
            ))}

            <Button
              onClick={() => saveSettings(providerKey)}
              disabled={saving[providerKey]}
              className="w-full"
            >
              {saving[providerKey] ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  Save {config.name} Settings
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      ))}

      <Card className="glass border-amber-500/30">
        <CardContent className="pt-4">
          <p className="text-sm text-muted-foreground">
            <strong>Note:</strong> After updating OAuth credentials, you may need to reconnect your cloud storage accounts in the Accounts tab for changes to take effect.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default AppSettings;
