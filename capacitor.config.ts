import type { CapacitorConfig } from '@capacitor/cli';

// iOS app (Capacitor). The app runs the BUNDLED build (dist/), not a website URL: it works offline
// and is a real app, not a repackaged site. The appId is a placeholder: the owner chooses the final
// bundle identifier when creating the app in App Store Connect (docs/IOS_APP_STORE.md), and it must
// be changed here and in Xcode before the first TestFlight upload.
const config: CapacitorConfig = {
  appId: 'com.myvoicelife.app',
  appName: 'Voice Life',
  webDir: 'dist',
  ios: {
    contentInset: 'never',
    // Swift Package Manager (no CocoaPods needed on the build machine).
  },
  plugins: {
    LocalNotifications: { iconColor: '#6f4ef0' },
  },
};

export default config;
