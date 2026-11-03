import { appearanceSettings, DEFAULT_FONT_SIZE } from '../../shared/appearance.js';

// Display preferences belong to the plugin, independently of engine accounts and session history.
export function registerAppearance(context) {
  const pluginId = context.pluginId;
  const key = `plugin-data/${pluginId}/appearance.json`;
  context.methods.register('appearance.get', async () => {
    try {
      return appearanceSettings(await context.storage.readJson(key, { fontSize: DEFAULT_FONT_SIZE }));
    } catch (error) {
      console.error('[ai:appearance-load]', { pluginId }, error);
      return { fontSize: DEFAULT_FONT_SIZE };
    }
  });
  context.methods.register('appearance.save', async input => {
    const settings = appearanceSettings(input);
    try {
      await context.storage.writeJson(key, settings);
    } catch (error) {
      console.error('[ai:appearance-save]', { pluginId, fontSize: settings.fontSize }, error);
      throw error;
    }
    context.emit('appearance.changed', settings);
    console.info('[ai:appearance-saved]', { pluginId, fontSize: settings.fontSize });
    return settings;
  }, { exclusive: true });
}
