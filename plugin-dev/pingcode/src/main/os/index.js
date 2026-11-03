const implementation = process.platform === 'darwin' ? await import('./mac/browser.js') : await import('./unsupported.js');
export const createBrowserPlatform = implementation.createBrowserPlatform;
