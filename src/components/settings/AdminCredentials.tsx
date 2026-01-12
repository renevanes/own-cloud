import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { Eye, EyeOff, Save, Trash2, CheckCircle2, XCircle } from 'lucide-react';

interface ProviderCredential {
  id: string;
  provider: string;
  credentials: Record<string, string>;
  is_configured: boolean;
}

interface CredentialField {
  key: string;
  label: string;
  placeholder: string;
  type: 'text' | 'password';
}

const providerConfigs: Record<string, { name: string; fields: CredentialField[]; icon: string }> = {
  aws_s3: {
    name: 'AWS S3',
    icon: '☁️',
    fields: [
      { key: 'access_key_id', label: 'Access Key ID', placeholder: 'AKIAIOSFODNN7EXAMPLE', type: 'text' },
      { key: 'secret_access_key', label: 'Secret Access Key', placeholder: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', type: 'password' },
      { key: 'bucket', label: 'Bucket Name', placeholder: 'my-bucket', type: 'text' },
      { key: 'region', label: 'Region', placeholder: 'us-east-1', type: 'text' },
    ],
  },
  microsoft: {
    name: 'Microsoft OneDrive',
    icon: '📁',
    fields: [
      { key: 'client_id', label: 'Client ID', placeholder: 'Your Azure App Client ID', type: 'text' },
      { key: 'client_secret', label: 'Client Secret', placeholder: 'Your Azure App Client Secret', type: 'password' },
    ],
  },
  google: {
    name: 'Google Drive',
    icon: '📂',
    fields: [
      { key: 'client_id', label: 'Client ID', placeholder: 'Your Google Client ID', type: 'text' },
      { key: 'client_secret', label: 'Client Secret', placeholder: 'Your Google Client Secret', type: 'password' },
    ],
  },
};

export const AdminCredentials = () => {
  const { user } = useAuth();
  const [credentials, setCredentials] = useState<Record<string, ProviderCredential>>({});
  const [formData, setFormData] = useState<Record<string, Record<string, string>>>({});
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      loadCredentials();
    }
  }, [user]);

  const loadCredentials = async () => {
    if (!user) return;
    
    try {
      const { data, error } = await supabase
        .from('provider_credentials')
        .select('*')
        .eq('user_id', user.id);

      if (error) throw error;

      const credMap: Record<string, ProviderCredential> = {};
      const formMap: Record<string, Record<string, string>> = {};

      // Initialize form data for all providers
      Object.keys(providerConfigs).forEach(provider => {
        formMap[provider] = {};
        providerConfigs[provider].fields.forEach(field => {
          formMap[provider][field.key] = '';
        });
      });

      // Load existing credentials
      data?.forEach(cred => {
        credMap[cred.provider] = {
          id: cred.id,
          provider: cred.provider,
          credentials: cred.credentials as Record<string, string>,
          is_configured: cred.is_configured,
        };
        
        // Populate form with masked values for existing credentials
        if (cred.credentials) {
          Object.keys(cred.credentials as Record<string, string>).forEach(key => {
            formMap[cred.provider][key] = (cred.credentials as Record<string, string>)[key] || '';
          });
        }
      });

      setCredentials(credMap);
      setFormData(formMap);
    } catch (error) {
      console.error('Error loading credentials:', error);
      toast.error('Failed to load credentials');
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (provider: string, field: string, value: string) => {
    setFormData(prev => ({
      ...prev,
      [provider]: {
        ...prev[provider],
        [field]: value,
      },
    }));
  };

  const togglePasswordVisibility = (fieldKey: string) => {
    setShowPasswords(prev => ({
      ...prev,
      [fieldKey]: !prev[fieldKey],
    }));
  };

  const saveCredentials = async (provider: string) => {
    if (!user) return;
    
    setSaving(provider);
    try {
      const providerData = formData[provider];
      const config = providerConfigs[provider];
      
      // Check if all required fields are filled
      const allFilled = config.fields.every(field => providerData[field.key]?.trim());
      
      const existingCred = credentials[provider];
      
      if (existingCred) {
        // Update existing
        const { error } = await supabase
          .from('provider_credentials')
          .update({
            credentials: providerData,
            is_configured: allFilled,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingCred.id);

        if (error) throw error;
      } else {
        // Insert new
        const { error } = await supabase
          .from('provider_credentials')
          .insert({
            user_id: user.id,
            provider,
            credentials: providerData,
            is_configured: allFilled,
          });

        if (error) throw error;
      }

      toast.success(`${config.name} credentials saved`);
      await loadCredentials();
    } catch (error) {
      console.error('Error saving credentials:', error);
      toast.error('Failed to save credentials');
    } finally {
      setSaving(null);
    }
  };

  const deleteCredentials = async (provider: string) => {
    if (!user) return;
    
    const existingCred = credentials[provider];
    if (!existingCred) return;

    try {
      const { error } = await supabase
        .from('provider_credentials')
        .delete()
        .eq('id', existingCred.id);

      if (error) throw error;

      toast.success(`${providerConfigs[provider].name} credentials deleted`);
      await loadCredentials();
    } catch (error) {
      console.error('Error deleting credentials:', error);
      toast.error('Failed to delete credentials');
    }
  };

  if (loading) {
    return (
      <Card className="glass border-border/50">
        <CardContent className="flex items-center justify-center py-8">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="glass border-border/50">
      <CardHeader>
        <CardTitle className="text-xl">Storage Provider Credentials</CardTitle>
        <CardDescription>
          Configure your cloud storage provider credentials here. These will be stored securely and used for syncing.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="aws_s3" className="w-full">
          <TabsList className="grid w-full grid-cols-3 bg-secondary/50">
            {Object.entries(providerConfigs).map(([key, config]) => (
              <TabsTrigger
                key={key}
                value={key}
                className="flex items-center gap-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
              >
                <span>{config.icon}</span>
                <span className="hidden sm:inline">{config.name}</span>
                {credentials[key]?.is_configured && (
                  <CheckCircle2 className="h-3 w-3 text-green-500" />
                )}
              </TabsTrigger>
            ))}
          </TabsList>

          {Object.entries(providerConfigs).map(([provider, config]) => (
            <TabsContent key={provider} value={provider} className="mt-6 space-y-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{config.icon}</span>
                  <h3 className="font-semibold text-lg">{config.name}</h3>
                </div>
                {credentials[provider]?.is_configured ? (
                  <span className="flex items-center gap-1 text-sm text-green-500">
                    <CheckCircle2 className="h-4 w-4" />
                    Configured
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-sm text-muted-foreground">
                    <XCircle className="h-4 w-4" />
                    Not configured
                  </span>
                )}
              </div>

              <div className="space-y-4">
                {config.fields.map(field => (
                  <div key={field.key} className="space-y-2">
                    <Label htmlFor={`${provider}-${field.key}`}>{field.label}</Label>
                    <div className="relative">
                      <Input
                        id={`${provider}-${field.key}`}
                        type={field.type === 'password' && !showPasswords[`${provider}-${field.key}`] ? 'password' : 'text'}
                        placeholder={field.placeholder}
                        value={formData[provider]?.[field.key] || ''}
                        onChange={(e) => handleInputChange(provider, field.key, e.target.value)}
                        className="pr-10 bg-secondary/30 border-border"
                      />
                      {field.type === 'password' && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                          onClick={() => togglePasswordVisibility(`${provider}-${field.key}`)}
                        >
                          {showPasswords[`${provider}-${field.key}`] ? (
                            <EyeOff className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <Eye className="h-4 w-4 text-muted-foreground" />
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex gap-3 pt-4">
                <Button
                  onClick={() => saveCredentials(provider)}
                  disabled={saving === provider}
                  className="flex-1"
                >
                  {saving === provider ? (
                    <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin mr-2" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  Save Credentials
                </Button>
                {credentials[provider] && (
                  <Button
                    variant="destructive"
                    onClick={() => deleteCredentials(provider)}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </Button>
                )}
              </div>

              {provider === 'aws_s3' && (
                <div className="p-4 bg-primary/5 border border-primary/20 rounded-lg mt-4">
                  <p className="text-sm text-muted-foreground">
                    <strong className="text-foreground">Tip:</strong> Create an IAM user with S3 access permissions. 
                    We recommend using a policy that only grants access to the specific bucket you want to sync.
                  </p>
                </div>
              )}
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
};
