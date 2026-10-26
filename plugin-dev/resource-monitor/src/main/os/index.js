const implementation = await import(process.platform === 'darwin' ? './mac/index.js' : './unsupported.js');
export const createPlatform = implementation.createPlatform;
