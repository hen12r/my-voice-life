// True inside the iOS app (Capacitor), false in any browser (including the installed web app).
import { Capacitor } from '@capacitor/core';

export const isNativeApp = (): boolean => Capacitor.isNativePlatform();
