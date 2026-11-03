// Keep startup palette replies identical to the terminal canvas in both themes.
export const terminalColors = {
  dark: { background: '#202227', foreground: '#adb0b7', white: '#adb0b7', brightWhite: '#bdc0c7', cursor: '#c4b5fd', selectionBackground: '#63588d88', black: '#30333a', extendedAnsi: Object.assign([], { 239: '#30343c' }) },
  light: { background: '#ffffff', foreground: '#282c35', cursor: '#6950b9', selectionBackground: '#d8cff5', black: '#282c35', extendedAnsi: Object.assign([], { 239: '#f5f5f5' }) }
};
