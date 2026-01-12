import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Copy, Check, ExternalLink, Settings as SettingsIcon, KeyRound, BookOpen, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { OneDriveIcon, GoogleDriveIcon } from '@/components/icons/CloudIcons';
import AppSettings from '@/components/settings/AppSettings';
import { ConnectedAccounts } from '@/components/settings/ConnectedAccounts';
const Settings = () => {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const { toast } = useToast();
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const redirectUri = `${window.location.origin}/auth/callback`;
  const supabaseCallbackUrl = `https://smodkjrlnyuhdmgsmxhi.supabase.co/auth/v1/callback`;

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    toast({
      title: "Copied!",
      description: "URL copied to clipboard",
    });
    setTimeout(() => setCopiedField(null), 2000);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    navigate('/auth');
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Background effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-accent/10 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 container mx-auto px-4 py-8 max-w-4xl">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/')}
            className="hover:bg-secondary"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <SettingsIcon className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Settings</h1>
              <p className="text-muted-foreground text-sm">Configure your cloud connections and credentials</p>
            </div>
          </div>
        </div>

        {/* Main Settings Tabs */}
        <Tabs defaultValue="accounts" className="w-full space-y-6">
          <TabsList className="grid w-full grid-cols-3 bg-secondary/50">
            <TabsTrigger value="accounts" className="flex items-center gap-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Link2 className="h-4 w-4" />
              Accounts
            </TabsTrigger>
            <TabsTrigger value="credentials" className="flex items-center gap-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <KeyRound className="h-4 w-4" />
              Credentials
            </TabsTrigger>
            <TabsTrigger value="setup" className="flex items-center gap-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <BookOpen className="h-4 w-4" />
              Setup Guide
            </TabsTrigger>
          </TabsList>

          <TabsContent value="accounts">
            <ConnectedAccounts />
          </TabsContent>

          <TabsContent value="credentials">
            <AppSettings />
          </TabsContent>

          <TabsContent value="setup" className="space-y-6">
            {/* OAuth Setup Instructions */}
            <Card className="glass border-border/50">
              <CardHeader>
                <CardTitle className="text-xl">Cloud Provider Setup</CardTitle>
                <CardDescription>
                  Follow these instructions to connect your cloud storage accounts
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue="microsoft" className="w-full">
                  <TabsList className="grid w-full grid-cols-2 bg-secondary/50">
                    <TabsTrigger value="microsoft" className="flex items-center gap-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                      <OneDriveIcon className="h-4 w-4" />
                      Microsoft OneDrive
                    </TabsTrigger>
                    <TabsTrigger value="google" className="flex items-center gap-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                      <GoogleDriveIcon className="h-4 w-4" />
                      Google Drive
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="microsoft" className="mt-6 space-y-6">
                    <div className="space-y-4">
                      <h3 className="font-semibold text-lg">Step 1: Create Azure App Registration</h3>
                      <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                        <li>Go to the <a href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">Azure Portal <ExternalLink className="h-3 w-3" /></a></li>
                        <li>Click "New registration"</li>
                        <li>Name your app (e.g., "CloudSync")</li>
                        <li>Select "Accounts in any organizational directory and personal Microsoft accounts"</li>
                        <li>Add the redirect URI below as "Web" type</li>
                      </ol>
                    </div>

                    <div className="space-y-3">
                      <h3 className="font-semibold text-lg">Step 2: Configure Redirect URI</h3>
                      <p className="text-sm text-muted-foreground">Add this URL as a redirect URI in your Azure app:</p>
                      <div className="flex items-center gap-2 p-3 bg-secondary/50 rounded-lg border border-border">
                        <code className="flex-1 text-sm text-primary break-all">{supabaseCallbackUrl}</code>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => copyToClipboard(supabaseCallbackUrl, 'ms-redirect')}
                          className="shrink-0"
                        >
                          {copiedField === 'ms-redirect' ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <h3 className="font-semibold text-lg">Step 3: Configure API Permissions</h3>
                      <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                        <li>Go to "API permissions" → "Add a permission"</li>
                        <li>Select "Microsoft Graph" → "Delegated permissions"</li>
                        <li>Add these permissions:
                          <ul className="list-disc list-inside ml-4 mt-1 space-y-1">
                            <li><code className="text-xs bg-secondary px-1 py-0.5 rounded">Files.ReadWrite.All</code></li>
                            <li><code className="text-xs bg-secondary px-1 py-0.5 rounded">User.Read</code></li>
                            <li><code className="text-xs bg-secondary px-1 py-0.5 rounded">offline_access</code></li>
                          </ul>
                        </li>
                      </ol>
                    </div>

                    <div className="space-y-4">
                      <h3 className="font-semibold text-lg">Step 4: Create Client Secret</h3>
                      <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                        <li>Go to "Certificates & secrets"</li>
                        <li>Click "New client secret"</li>
                        <li>Copy the secret value immediately (it won't be shown again)</li>
                      </ol>
                    </div>

                    <div className="p-4 bg-primary/5 border border-primary/20 rounded-lg">
                      <p className="text-sm text-muted-foreground">
                        <strong className="text-foreground">Note:</strong> After setup, go to the Credentials tab and enter your Client ID and Client Secret.
                      </p>
                    </div>
                  </TabsContent>

                  <TabsContent value="google" className="mt-6 space-y-6">
                    <div className="space-y-4">
                      <h3 className="font-semibold text-lg">Step 1: Create Google Cloud Project</h3>
                      <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                        <li>Go to the <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">Google Cloud Console <ExternalLink className="h-3 w-3" /></a></li>
                        <li>Create a new project or select existing one</li>
                        <li>Go to "APIs & Services" → "Credentials"</li>
                        <li>Click "Create Credentials" → "OAuth client ID"</li>
                      </ol>
                    </div>

                    <div className="space-y-4">
                      <h3 className="font-semibold text-lg">Step 2: Configure OAuth Consent Screen</h3>
                      <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                        <li>Select "External" user type</li>
                        <li>Fill in app name and support email</li>
                        <li>Add scopes:
                          <ul className="list-disc list-inside ml-4 mt-1 space-y-1">
                            <li><code className="text-xs bg-secondary px-1 py-0.5 rounded">https://www.googleapis.com/auth/drive</code></li>
                            <li><code className="text-xs bg-secondary px-1 py-0.5 rounded">https://www.googleapis.com/auth/userinfo.email</code></li>
                            <li><code className="text-xs bg-secondary px-1 py-0.5 rounded">https://www.googleapis.com/auth/userinfo.profile</code></li>
                          </ul>
                        </li>
                      </ol>
                    </div>

                    <div className="space-y-3">
                      <h3 className="font-semibold text-lg">Step 3: Configure Redirect URI</h3>
                      <p className="text-sm text-muted-foreground">Add this URL as an authorized redirect URI:</p>
                      <div className="flex items-center gap-2 p-3 bg-secondary/50 rounded-lg border border-border">
                        <code className="flex-1 text-sm text-primary break-all">{supabaseCallbackUrl}</code>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => copyToClipboard(supabaseCallbackUrl, 'google-redirect')}
                          className="shrink-0"
                        >
                          {copiedField === 'google-redirect' ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <h3 className="font-semibold text-lg">Step 4: Enable Google Drive API</h3>
                      <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                        <li>Go to "APIs & Services" → "Library"</li>
                        <li>Search for "Google Drive API"</li>
                        <li>Click "Enable"</li>
                      </ol>
                    </div>

                    <div className="p-4 bg-primary/5 border border-primary/20 rounded-lg">
                      <p className="text-sm text-muted-foreground">
                        <strong className="text-foreground">Note:</strong> After setup, go to the Credentials tab and enter your Client ID and Client Secret.
                      </p>
                    </div>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>

            {/* Quick Links */}
            <Card className="glass border-border/50">
              <CardHeader>
                <CardTitle className="text-lg">Quick Links</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <a
                  href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 p-3 rounded-lg bg-secondary/30 hover:bg-secondary/50 transition-colors"
                >
                  <OneDriveIcon className="h-5 w-5" />
                  <span className="flex-1">Azure App Registrations</span>
                  <ExternalLink className="h-4 w-4 text-muted-foreground" />
                </a>
                <a
                  href="https://console.cloud.google.com/apis/credentials"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 p-3 rounded-lg bg-secondary/30 hover:bg-secondary/50 transition-colors"
                >
                  <GoogleDriveIcon className="h-5 w-5" />
                  <span className="flex-1">Google Cloud Console</span>
                  <ExternalLink className="h-4 w-4 text-muted-foreground" />
                </a>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
};

export default Settings;
