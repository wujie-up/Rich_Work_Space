export const DEFAULT_FONT_SIZE = 14;
export const FONT_SIZES = Array.from({ length: 15 }, (_, index) => index + 10);

export function appearanceSettings(value) {
  if (!FONT_SIZES.includes(value?.fontSize)) {
    throw Object.assign(Error('会话字号必须为 10–24 的整数'), { code: 'INVALID_ARGUMENT' });
  }
  return { fontSize: value.fontSize };
}
