// What a signed-in device is called on Account (ARCH.md §16 #98): the browser and the system, read once from the
// User-Agent at sign-in — "Chrome · macOS", "Safari · iPhone" — and nothing else of it kept: no version, no model, no
// address. A string nothing recognises is "A browser"; the list still shows when it signed in and when it was last used.

/** The longest name kept: a User-Agent is anyone's to write. */
export const MAX_DEVICE_NAME = 60;

const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\b(?:Chrome|CriOS)\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\biPad\b/, 'iPad'],
  [/\biPhone\b/, 'iPhone'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bLinux\b/, 'Linux'],
];

/** A device's name from its User-Agent: browser · system, either alone when the other isn't recognised. */
export function deviceName(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? '').slice(0, 512);
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  const name = browser && system ? `${browser} · ${system}` : (browser ?? system ?? '');
  return name.slice(0, MAX_DEVICE_NAME);
}
