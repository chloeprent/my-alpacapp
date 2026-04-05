import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.yourorg.app',
  appName: 'YOUR_APP_NAME',
  webDir: 'www',
  plugins: {
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#2e2226',
    },
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      backgroundColor: '#f5f4ed',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: true,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    CapacitorUpdater: {
      autoUpdate: true,
    },
  },
  ios: {
    scheme: 'YOUR_APP_NAME',
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
