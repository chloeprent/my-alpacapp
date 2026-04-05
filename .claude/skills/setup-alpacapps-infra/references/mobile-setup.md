# Mobile App Setup (Capacitor 8)

Optional step in the setup wizard. Only offer if the user wants a native mobile app.

## Prerequisites

- Xcode (macOS only, for iOS)
- Android Studio (for Android)
- Node.js 18+

## Setup Steps

### 1. Initialize Capacitor

```bash
npm install @capacitor/core @capacitor/cli
npx cap init "{APP_NAME}" "{APP_ID}" --web-dir "mobile/app"
```

- `{APP_NAME}` — Display name (e.g., "My Property App")
- `{APP_ID}` — Reverse domain (e.g., "com.example.myapp")

### 2. Create Mobile App Shell

Create `mobile/app/index.html` with:
- Loading overlay
- Login overlay (reuses `shared/auth.js`)
- Tab sections (dynamically loaded based on enabled features)
- Bottom navigation bar

Create `mobile/app/mobile-app.js` with:
- Auth initialization (PKCE flow with visibility-based refresh)
- Tab switching with lazy dynamic imports
- Feature-aware tab filtering (reads `property_config.features`)

Create `mobile/app/mobile.css` with:
- Dark theme by default
- Bottom nav styling
- Safe area insets for notch devices
- Tab content containers

### 3. Configure Tabs Based on Features

The mobile app's tabs should be feature-aware. Map features to tabs:

| Feature | Tab | Module |
|---------|-----|--------|
| cameras | Cameras | `cameras-tab.js` |
| music | Music | `music-tab.js` |
| lighting | Lights | `lights-tab.js` |
| climate | Climate | `climate-tab.js` |
| vehicles | Cars | `cars-tab.js` |

Only create tab modules for enabled features. The bottom nav should show max 5 tabs.

### 4. Add Platforms

```bash
npx cap add ios      # macOS only
npx cap add android
```

### 5. Configure capacitor.config.ts

```typescript
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: '{APP_ID}',
  appName: '{APP_NAME}',
  webDir: 'mobile/app',
  server: {
    url: '{LIVE_URL}',          // GitHub Pages URL for production
    cleartext: false,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
    },
  },
};

export default config;
```

### 6. Add npm Scripts

Add to `package.json`:
```json
{
  "scripts": {
    "sync": "npx cap sync",
    "sync:ios": "npx cap sync ios",
    "sync:android": "npx cap sync android",
    "open:ios": "npx cap open ios",
    "open:android": "npx cap open android"
  }
}
```

### 7. OTA Updates (Optional — Capgo)

For over-the-air updates without App Store review:

```bash
npm install @capgo/capacitor-updater
npx cap sync
```

Configure in `capacitor.config.ts`:
```typescript
plugins: {
  CapacitorUpdater: {
    autoUpdate: true,
  },
}
```

Sign up at https://capgo.app and follow their CLI setup.

### 8. Build & Run

```bash
npm run sync        # Sync web code to native projects
npm run open:ios    # Opens Xcode — press Play to run
npm run open:android # Opens Android Studio — press Run
```

## Auth Considerations for Mobile

- Use PKCE OAuth flow (no server secret needed)
- Refresh session on app resume (visibility change event)
- Store tokens in Capacitor Preferences (not localStorage)
- Deep link handling for OAuth callback

## Push Notifications (Optional)

```bash
npm install @capacitor/push-notifications
npx cap sync
```

Requires Firebase project (Android) and Apple Push certificate (iOS).
